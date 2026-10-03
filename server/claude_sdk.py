"""Claude SDK runtime: a code-session turn run by Anthropic's Claude Agent SDK (Python package
`claude-agent-sdk`, which drives the Claude Code binary).

The SDK brings Claude Code's prompt, tools and session store; CEU runs it in the project
folder, resumes the SDK session by id on later turns, answers its permission callback
(`can_use_tool`) on CEU's approval card, and stops it with `interrupt()`. Auth is the official
one for third-party apps: an API key (ANTHROPIC_API_KEY), taken from the Anthropic provider the
user chose for the SDK (integrations.ClaudeSDK) and handed only to the SDK's child process.

The SDK is async; it runs on its own event loop in a helper thread and talks to the generation
thread through a queue, so rounds, approvals and DB writes all happen on the generation thread.
"""
import asyncio
import collections
import concurrent.futures
import queue
import threading

from . import integrations, providers, redir

PERMISSION = {"manual": "default", "accept_edits": "acceptEdits", "plan": "plan", "auto": "bypassPermissions"}
EDIT_TOOLS = {"Edit": "edit_file", "MultiEdit": "edit_file", "Write": "write_file"}


class ClaudeSdkError(providers.ProviderError):
    pass


def _key_env(provider):
    env = {"ANTHROPIC_API_KEY": provider["api_key"]}
    base = (provider.get("base_url") or "").rstrip("/")
    if base and base != providers.PRESETS["anthropic"]["base_url"]:
        env["ANTHROPIC_BASE_URL"] = base
    return env


def run_turn(root, text, session, mode, model, effort, cancel, hooks):
    try:
        import claude_agent_sdk as sdk
    except ImportError:
        raise ClaudeSdkError("Claude SDK: o pacote claude-agent-sdk não está instalado. "
                             "Configure em Configurações → Runtimes e agentes.")
    provider = integrations.claude_sdk_provider()
    if not provider or not provider.get("api_key"):
        raise ClaudeSdkError("Claude SDK: nenhuma chave de API escolhida. Conecte em Configurações → Runtimes e agentes.")
    cli = integrations.claude_sdk_cli()
    if not cli:
        raise ClaudeSdkError("Claude SDK: falta o executável do Claude Code. Configure em Configurações → Runtimes e agentes.")

    events = queue.Queue()
    err_tail = collections.deque(maxlen=30)
    loop_box = {}

    async def can_use_tool(tool_name, tool_input, ctx):
        fut = concurrent.futures.Future()
        events.put(("ask", tool_name, tool_input, getattr(ctx, "tool_use_id", None), fut))
        answer = await asyncio.wrap_future(fut)
        if answer is None:
            return sdk.PermissionResultDeny(message="Interrompido pelo usuário.", interrupt=True)
        if answer["decision"] in ("allow", "always"):
            return sdk.PermissionResultAllow(updated_input=tool_input)
        reason = (answer.get("reason") or "").strip()
        return sdk.PermissionResultDeny(
            message="O usuário negou esta ação." + (f" Motivo: {reason}." if reason else "") +
                    " Não tente de novo da mesma forma; ajuste a abordagem ou pergunte.")

    options = sdk.ClaudeAgentOptions(
        cwd=root, cli_path=cli, permission_mode=PERMISSION.get(mode or "manual", "default"),
        resume=session or None, model=model or None,
        effort=effort if effort in ("low", "medium", "high", "xhigh", "max") else None,
        env=_key_env(provider), can_use_tool=can_use_tool, stderr=err_tail.append)

    async def main():
        loop_box["loop"] = asyncio.get_running_loop()
        async with sdk.ClaudeSDKClient(options=options) as client:
            loop_box["client"] = client
            await client.query(text)
            async for msg in client.receive_response():
                events.put(("msg", msg))

    def worker():
        try:
            asyncio.run(main())
        except BaseException as e:  # noqa: BLE001 - reported on the generation thread
            events.put(("exc", e))
        finally:
            events.put(("closed",))

    def interrupt():
        loop, client = loop_box.get("loop"), loop_box.get("client")
        if loop and client and not loop.is_closed():
            asyncio.run_coroutine_threadsafe(client.interrupt(), loop)

    threading.Thread(target=worker, daemon=True, name="claude-sdk").start()
    cancel.on_cancel(interrupt)

    open_calls, previews = {}, {}
    usage, result, failure = None, None, None
    wrote_text = False
    while True:
        kind, *rest = events.get()
        if kind == "closed":
            break
        if kind == "exc":
            if not cancel.is_set():
                failure = failure or _describe_exc(rest[0], err_tail)
            continue
        if kind == "ask":
            tool_name, tool_input, tool_use_id, fut = rest
            call = open_calls.get(tool_use_id) or redir.claude_tool_call(tool_use_id or f"perm_{id(fut)}", tool_name, tool_input)
            if call["id"] not in open_calls:
                open_calls[call["id"]] = call
                hooks.start(call)
            req = {"call_id": call["id"], "name": call["name"], "input": call["input"],
                   "kind": "edit" if tool_name in EDIT_TOOLS else "command" if call["name"] == "run_command" else "unknown",
                   "rule": {"tool": call["name"], "pattern": ""}, "always_label": None}
            if tool_name in EDIT_TOOLS:
                req["preview"] = previews.get(call["id"]) or _preview(root, tool_name, tool_input)
            if call["name"] not in ("run_command", "edit_file", "write_file"):
                req["summary"] = f"Permitir {tool_name}?"
            answer = None if cancel.is_set() else hooks.ask(req)
            fut.set_result(answer)
            continue
        msg = rest[0]
        if isinstance(msg, sdk.SystemMessage):
            data = msg.data or {}
            if msg.subtype == "init" and data.get("session_id"):
                hooks.session(data["session_id"])
            elif msg.subtype == "api_retry" and data.get("error") == "authentication_failed":
                failure = "A API da Anthropic recusou a chave do provedor escolhido para o Claude SDK."
                integrations.report_failure("claude_sdk", failure)
                interrupt()
        elif isinstance(msg, sdk.AssistantMessage):
            for b in msg.content:
                if isinstance(b, sdk.TextBlock) and b.text:
                    if wrote_text:
                        yield {"type": "text", "text": "\n\n"}
                    wrote_text = True
                    yield {"type": "text", "text": b.text}
                elif isinstance(b, sdk.ThinkingBlock) and b.thinking:
                    yield {"type": "reasoning", "text": b.thinking + "\n\n"}
                elif isinstance(b, sdk.ToolUseBlock):
                    wrote_text = False
                    call = redir.claude_tool_call(b.id, b.name, b.input)
                    _relative(root, call)
                    if b.name in EDIT_TOOLS:
                        previews[b.id] = _preview(root, b.name, b.input)
                    if b.id not in open_calls:
                        open_calls[b.id] = call
                        hooks.start(call)
        elif isinstance(msg, sdk.UserMessage):
            content = msg.content if isinstance(msg.content, list) else []
            for b in content:
                if isinstance(b, sdk.ToolResultBlock):
                    call = open_calls.pop(b.tool_use_id, None) or {"id": b.tool_use_id, "name": "tool", "input": {}}
                    res = redir.claude_result(b.content, b.is_error)
                    prev = previews.pop(b.tool_use_id, None)
                    if prev and prev.get("diff") is not None and not b.is_error:
                        res["meta"].update(prev)
                    elif call["name"] == "run_command":
                        res["meta"]["output"] = res["output"]
                    hooks.end(call, res)
        elif isinstance(msg, sdk.ResultMessage):
            u = msg.usage or {}
            usage = {"input": u.get("input_tokens"), "output": u.get("output_tokens")}
            result = msg
            if msg.session_id:
                hooks.session(msg.session_id)
    for call in open_calls.values():
        hooks.end(call, {"output": "Interrompido.", "is_error": True, "meta": {"cancelled": True}})
    if cancel.is_set():
        return
    if failure:
        raise ClaudeSdkError(f"Claude SDK: {failure}")
    if result is None:
        tail = "".join(err_tail).strip()[-1200:]
        raise ClaudeSdkError("Claude SDK: a sessão terminou sem resultado." + (f"\n{tail}" if tail else ""))
    if result.is_error:
        raise ClaudeSdkError(f"Claude SDK: {result.result or result.subtype or 'erro'}")
    yield {"type": "final", "raw_blocks": None, "usage": usage, "stop_reason": "stop", "model": model, "tool_calls": []}


def _relative(root, call):
    redir._relative(root, call)


def _preview(root, tool_name, a):
    """The diff an Edit/Write would make, read from disk before it runs (approval card + result)."""
    name = EDIT_TOOLS.get(tool_name)
    args = {"path": a.get("file_path"), "content": a.get("content"), "old_string": a.get("old_string"),
            "new_string": a.get("new_string"), "replace_all": a.get("replace_all")}
    if tool_name == "MultiEdit":
        return {"path": a.get("file_path")}
    from .generation import _edit_preview  # lazy: generation imports this module
    return _edit_preview(root, name, args)


def _describe_exc(e, err_tail):
    name = type(e).__name__
    tail = "".join(err_tail).strip()[-800:]
    if name == "CLINotFoundError":
        return "o executável do Claude Code não foi encontrado."
    msg = str(e) or name
    return msg + (f"\n{tail}" if tail and tail not in msg else "")
