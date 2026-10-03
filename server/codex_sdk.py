"""Codex SDK runtime: a code-session turn run by OpenAI's Codex harness, driven natively over
the Codex app-server (the JSON-RPC interface Codex's own SDKs and IDE extension use).

Codex brings its prompt, tools and sandbox; CEU starts a persistent thread in the project
folder (resumed by id on later turns), streams its items into the same rounds a CEU turn
produces, answers its approval requests on CEU's approval card, forwards mid-run messages
with `turn/steer` and stops it with `turn/interrupt`. Login is the integration's job
(integrations.py); the account lives in Codex's own store.

Permission modes, as Codex sandbox + approval policy:
  manual        read-only sandbox, "untrusted": edits and non-trusted commands ask
  accept_edits  workspace-write,   "untrusted": edits inside the folder run, commands ask
  plan          read-only,         "never" (+ a plan instruction): nothing asks, nothing writes
  auto          workspace-write,   "never": writes only inside the folder, never asks
"""
import json
import queue
import time

from . import codex_bridge, integrations, providers, redir

POLICY = {
    "manual": ("read-only", "untrusted"),
    "accept_edits": ("workspace-write", "untrusted"),
    "plan": ("read-only", "never"),
    "auto": ("workspace-write", "never"),
}
PLAN_PREFIX = ("[CEU · modo Plano] Não altere nada: só investigue e termine com um plano concreto e numerado "
               "(arquivos a mudar, o que muda em cada um, como verificar).\n\n")
DECISION = {"allow": "accept", "always": "acceptForSession", "deny": "decline"}


class CodexSdkError(providers.ProviderError):
    pass


def _diff_stats(diff):
    added = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    removed = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    return added, removed


def _change_diff(change):
    """Codex gives a unified diff for updates; for added/deleted files it may give the content."""
    diff = change.get("diff") or ""
    kind = (change.get("kind") or {}).get("type")
    if diff and "@@" not in diff and kind in ("add", "delete"):
        lines = diff.replace("\r\n", "\n").rstrip("\n").split("\n")
        sign = "+" if kind == "add" else "-"
        head = f"@@ -0,0 +1,{len(lines)} @@" if kind == "add" else f"@@ -1,{len(lines)} +0,0 @@"
        diff = head + "\n" + "\n".join(sign + ln for ln in lines)
    return diff


def _file_call(item):
    changes = item.get("changes") or []
    first = changes[0] if changes else {}
    kind = (first.get("kind") or {}).get("type")
    name = {"add": "write_file", "delete": "delete_file"}.get(kind, "edit_file")
    return {"id": item["id"], "name": name, "input": {"path": first.get("path") or ""}}


def _file_meta(item):
    changes = item.get("changes") or []
    diff = "\n".join(_change_diff(c) for c in changes)
    added, removed = _diff_stats(diff)
    first = changes[0] if changes else {}
    return {"path": first.get("path"), "diff": diff, "added": added, "removed": removed,
            "created": (first.get("kind") or {}).get("type") == "add",
            "files": [c.get("path") for c in changes]}


def _command_call(item):
    return {"id": item["id"], "name": "run_command",
            "input": {"command": redir.DRIVERS["codex"]._inner(item.get("command") or "")}}


def _relpath(root, path):
    call = {"input": {"path": path}}
    redir._relative(root, call)
    return call["input"]["path"]


def run_turn(root, text, session, mode, model, effort, cancel, hooks):
    """Runs one turn and yields normalized events (text/reasoning/notice, then final). Tool
    activity goes to `hooks` (start/output/end/session/ask/steerable), see generation.External."""
    try:
        b = codex_bridge.get_bridge()
    except codex_bridge.CodexError as e:
        raise CodexSdkError(f"Codex SDK: {e}")
    sandbox, policy = POLICY.get(mode or "manual", POLICY["manual"])
    params = {"cwd": root, "sandbox": sandbox, "approvalPolicy": policy, "model": model or None}
    thread_id = None
    if session:
        try:
            thread_id = b.request("thread/resume", {"threadId": session, **params}, timeout=60)["thread"]["id"]
        except codex_bridge.CodexError:
            yield {"type": "notice", "text": "A sessão anterior do Codex não pôde ser retomada; começando uma nova."}
    if not thread_id:
        try:
            thread_id = b.request("thread/start", params, timeout=60)["thread"]["id"]
        except codex_bridge.CodexError as e:
            raise CodexSdkError(f"Codex SDK: não foi possível abrir a sessão: {e}")
    hooks.session(thread_id)
    q = b.subscribe_thread(thread_id, approvals=True)
    try:
        turn_params = {"threadId": thread_id, "input": [{"type": "text", "text": (PLAN_PREFIX if mode == "plan" else "") + text}],
                       "approvalPolicy": policy}
        if effort:
            turn_params["effort"] = effort
        try:
            turn_id = b.request("turn/start", turn_params, timeout=60)["turn"]["id"]
        except codex_bridge.CodexError as e:
            raise CodexSdkError(f"Codex SDK: {e}")
        cancel.on_cancel(lambda: _interrupt(b, thread_id, turn_id))

        def steer(msg):
            b.request("turn/steer", {"threadId": thread_id, "expectedTurnId": turn_id,
                                     "input": [{"type": "text", "text": msg}]}, timeout=20)
        hooks.steerable(steer)

        open_calls = {}     # item id -> call (rounds opened in the tree)
        declined = set()    # item ids the user denied on the card
        file_items = {}     # item id -> fileChange item, for the approval preview
        streamed = set()    # item ids whose text arrived as deltas
        last_text_item = None
        usage = None
        idle_deadline = time.time() + 900
        while True:
            if cancel.is_set():
                return
            try:
                method, p = q.get(timeout=1.0)
            except queue.Empty:
                if time.time() > idle_deadline:
                    raise CodexSdkError("O Codex ficou tempo demais sem responder.")
                if not b.alive():
                    raise CodexSdkError("O app-server do Codex encerrou durante o turno.")
                continue
            idle_deadline = time.time() + 900
            if method == "item/agentMessage/delta":
                iid = p.get("itemId")
                if last_text_item and iid != last_text_item:
                    yield {"type": "text", "text": "\n\n"}
                last_text_item = iid
                streamed.add(iid)
                yield {"type": "text", "text": p.get("delta") or ""}
            elif method in ("item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
                streamed.add(p.get("itemId"))
                yield {"type": "reasoning", "text": p.get("delta") or ""}
            elif method == "item/commandExecution/outputDelta":
                hooks.output(p.get("itemId"), p.get("delta") or "")
            elif method == "item/started":
                item = p.get("item") or {}
                call = _call_for(item)
                if item.get("type") == "fileChange":
                    file_items[item["id"]] = item
                if call:
                    last_text_item = None
                    if call["name"] in ("edit_file", "write_file", "delete_file"):
                        call["input"]["path"] = _relpath(root, call["input"]["path"])
                    open_calls[item["id"]] = call
                    hooks.start(call)
            elif method == "item/completed":
                item = p.get("item") or {}
                kind, iid = item.get("type"), item.get("id")
                if kind == "agentMessage" and iid not in streamed and item.get("text"):
                    if last_text_item and iid != last_text_item:
                        yield {"type": "text", "text": "\n\n"}
                    last_text_item = iid
                    yield {"type": "text", "text": item["text"]}
                elif kind == "reasoning" and iid not in streamed:
                    summary = "\n".join(item.get("summary") or [])
                    if summary:
                        yield {"type": "reasoning", "text": summary + "\n\n"}
                elif iid in open_calls or _call_for(item):
                    call = open_calls.pop(iid, None)
                    if call is None:
                        call = _call_for(item)
                        hooks.start(call)
                    res = _result_for(item)
                    if iid in declined:
                        res["meta"]["denied"] = True
                    if res["meta"].get("path"):
                        res["meta"]["path"] = _relpath(root, res["meta"]["path"])
                    if res["meta"].get("files"):
                        res["meta"]["files"] = [_relpath(root, f) for f in res["meta"]["files"] if f]
                    hooks.end(call, res)
            elif method in codex_bridge.APPROVAL_METHODS:
                if _answer_approval(b, root, method, p, open_calls, file_items, hooks, steer) != "accept":
                    declined.add(p.get("itemId"))
            elif method == "thread/tokenUsage/updated":
                u = (p.get("tokenUsage") or {}).get("last") or {}
                usage = {"input": u.get("inputTokens"), "output": u.get("outputTokens")}
            elif method == "turn/completed":
                turn = p.get("turn") or {}
                for call in list(open_calls.values()):
                    hooks.end(call, {"output": "Interrompido.", "is_error": True, "meta": {"cancelled": True}})
                open_calls.clear()
                if cancel.is_set() or turn.get("status") == "interrupted":
                    return
                if turn.get("status") == "failed" or turn.get("error"):
                    err = turn.get("error") or {}
                    msg = err.get("message") or "O Codex encerrou o turno com erro."
                    info = str(err.get("codexErrorInfo") or "")
                    if "nauthorized" in info or "401" in msg or "log in" in msg.lower():
                        integrations.report_failure("codex_sdk", f"O Codex recusou a sessão: {msg}")
                    raise CodexSdkError(f"Codex SDK: {msg}")
                yield {"type": "final", "raw_blocks": None, "usage": usage, "stop_reason": "stop", "model": model,
                       "tool_calls": []}
                return
    finally:
        b.unsubscribe_thread(thread_id)


def _call_for(item):
    kind = item.get("type")
    if kind == "commandExecution":
        return _command_call(item)
    if kind == "fileChange":
        return _file_call(item)
    if kind == "webSearch":
        return {"id": item["id"], "name": "web_search", "input": {"query": item.get("query") or ""}}
    if kind == "mcpToolCall":
        return {"id": item["id"], "name": f"{item.get('server')}.{item.get('tool')}", "input": item.get("arguments") or {}}
    return None


def _result_for(item):
    kind, status = item.get("type"), item.get("status")
    if kind == "commandExecution":
        out = (item.get("aggregatedOutput") or "").replace("\r\n", "\n").rstrip()
        code = item.get("exitCode")
        meta = {"exit_code": code, "output": out, "ms": item.get("durationMs")}
        if status == "declined":
            meta["denied"] = True
        return {"output": out or ("Negado." if status == "declined" else ""),
                "is_error": status in ("failed", "declined") or bool(code), "meta": meta}
    if kind == "fileChange":
        meta = _file_meta(item)
        if status == "declined":
            meta["denied"] = True
        return {"output": "\n".join(f"{(c.get('kind') or {}).get('type')}: {c.get('path')}" for c in item.get("changes") or []),
                "is_error": status in ("failed", "declined"), "meta": meta}
    if kind == "mcpToolCall":
        body = item.get("result") or item.get("error") or ""
        return {"output": json.dumps(body, ensure_ascii=False)[:8000] if not isinstance(body, str) else body[:8000],
                "is_error": status == "failed", "meta": {}}
    return {"output": "", "is_error": False, "meta": {}}


def _answer_approval(b, root, method, p, open_calls, file_items, hooks, steer):
    iid = p.get("itemId")
    if method == "item/commandExecution/requestApproval":
        call = open_calls.get(iid) or {"id": iid, "name": "run_command",
                                         "input": {"command": redir.DRIVERS["codex"]._inner(p.get("command") or "")}}
        request = {"kind": "command", "input": {**call["input"], "description": p.get("reason") or ""},
                   "always_label": "Permitir comandos assim até o fim desta sessão do Codex"}
    else:
        item = file_items.get(iid) or {"id": iid, "changes": []}
        call = open_calls.get(iid) or _file_call(item)
        meta = _file_meta(item)
        request = {"kind": "edit", "input": call["input"],
                   "preview": {"path": _relpath(root, meta["path"] or ""), "diff": meta["diff"] or None,
                               "added": meta["added"], "removed": meta["removed"]},
                   "always_label": "Permitir estas edições até o fim desta sessão do Codex"}
    if iid not in open_calls:
        open_calls[iid] = call
        hooks.start(call)
    answer = hooks.ask({"call_id": call["id"], "name": call["name"], "rule": {"tool": call["name"], "pattern": ""},
                        **request})
    decision = "cancel" if answer is None else DECISION.get(answer["decision"], "decline")
    b._send_result(p["_reqId"], {"decision": decision})
    reason = ((answer or {}).get("reason") or "").strip()
    if decision == "decline" and reason:  # Codex's decline has no reason field: it goes as a steer
        try:
            steer(f"[O usuário negou a ação anterior] {reason}")
        except codex_bridge.CodexError:
            pass
    return "accept" if decision in ("accept", "acceptForSession") else decision


def _interrupt(bridge, thread_id, turn_id):
    try:
        bridge.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id}, timeout=10)
    except codex_bridge.CodexError:
        pass
