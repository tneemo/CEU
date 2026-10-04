"""Background generation. A generation runs in its own thread, independent of any HTTP
client, so closing the tab or switching conversations never loses output. Clients attach
(and re-attach) to a generation's event log over SSE."""
import datetime
import json
import mimetypes
import os
import re
import threading
import time

from . import (agent_mode, agent_tools, calls, claude_sdk, code_runtimes, code_tools, codex_sdk, coordination, db,
               providers, redir)

MAX_TOOL_ROUNDS = 8
MAX_CODE_ROUNDS = 200
MAX_AGENT_ROUNDS = 60


class Cancel:
    def __init__(self):
        self._ev = threading.Event()
        self._callbacks = []

    def set(self):
        self._ev.set()
        for cb in self._callbacks:
            try:
                cb()
            except Exception:  # noqa: BLE001
                pass

    def is_set(self):
        return self._ev.is_set()

    def on_cancel(self, cb):
        self._callbacks.append(cb)
        if self.is_set():
            cb()


class Bus:
    """App-wide events (conversation list changes) fan-out to /api/events subscribers."""

    def __init__(self):
        self.cond = threading.Condition()
        self.events = []
        self.base = 0

    def publish(self, event):
        with self.cond:
            self.events.append(event)
            if len(self.events) > 500:
                drop = len(self.events) - 250
                self.events = self.events[drop:]
                self.base += drop
            self.cond.notify_all()

    def cursor(self):
        with self.cond:
            return self.base + len(self.events)

    def wait(self, cursor, timeout=15):
        with self.cond:
            if cursor >= self.base + len(self.events):
                self.cond.wait(timeout)
            start = max(cursor - self.base, 0)
            return self.events[start:], self.base + len(self.events)


bus = Bus()


class Generation:
    def __init__(self, message_id, conversation_id):
        self.message_id = message_id
        self.conversation_id = conversation_id
        self.cond = threading.Condition()
        self.events = []
        self.content = ""
        self.reasoning = ""
        self.notice = None
        self.done = False
        self.cancel = Cancel()
        self.finished_at = None
        # Code sessions: the tool call waiting for the user's answer, and messages the
        # user sent while the agent was working (delivered with the next tool result).
        self.pending = None
        self._answer = None
        self._answer_ev = threading.Event()
        self.steer = []
        # an external harness that takes mid-run messages itself (External.steerable)
        self.steer_to = None
        self.cancel.on_cancel(self._answer_ev.set)
        # Agent conversations: approvals park the turn instead of blocking this thread
        # (not on Codex, whose tool calls run inside its own turn).
        self.parkable = False
        # (call_id, executor generation, its call_id): an executor's approval card shown on this turn's
        # `delegate` call (coordination.py); answering it here answers the executor
        self.forward = None

    def ask(self, request):
        """Blocks the generation thread until the user answers `request` (or stops the turn).
        Returns {"decision": "allow"|"always"|"deny", "reason": str} or None when cancelled."""
        with self.cond:
            self.pending = request
            self._answer = None
            self._answer_ev.clear()
        if self.cancel.is_set():
            self._answer_ev.set()
        self.push({"type": "approval", "request": request})
        bus.publish({"type": "approval", "conversation_id": self.conversation_id, "message_id": self.message_id,
                     "state": "pending"})
        while not self._answer_ev.wait(1.0):
            pass
        with self.cond:
            answer, self.pending = self._answer, None
        self.push({"type": "approval_done", "call_id": request["call_id"]})
        bus.publish({"type": "approval", "conversation_id": self.conversation_id, "message_id": self.message_id,
                     "state": "answered"})
        return None if self.cancel.is_set() else answer

    def answer(self, call_id, decision, reason=""):
        fwd = self.forward
        if fwd and fwd[0] == call_id and not (self.pending and self.pending["call_id"] == call_id):
            return fwd[1].answer(fwd[2], decision, reason)
        with self.cond:
            if not self.pending or self.pending["call_id"] != call_id:
                return False
            self._answer = {"decision": decision, "reason": reason}
        self._answer_ev.set()
        return True

    def push(self, event):
        with self.cond:
            self.events.append(event)
            if event["type"] == "text":
                self.content += event["text"]
            elif event["type"] == "reasoning":
                self.reasoning += event["text"]
            self.cond.notify_all()

    def wait(self, cursor, timeout=15):
        with self.cond:
            if cursor >= len(self.events) and not self.done:
                self.cond.wait(timeout)
            return self.events[cursor:], len(self.events), self.done


_active = {}
_lock = threading.Lock()


def get(message_id):
    with _lock:
        return _active.get(message_id)


def active_for(conversation_id):
    with _lock:
        return next((g for g in _active.values() if g.conversation_id == conversation_id and not g.done), None)


def active_conversations():
    with _lock:
        return {g.conversation_id for g in _active.values() if not g.done}


def stop(message_id):
    g = get(message_id)
    if g and not g.done:
        g.cancel.set()
        return True
    return False


def _resolve_model(model_ref):
    """'providerId::modelId' -> (provider dict with key, model id)."""
    if not model_ref or "::" not in model_ref:
        raise providers.ProviderError("Nenhum modelo selecionado. Escolha um modelo no seletor do campo de mensagem.")
    pid, mid = model_ref.split("::", 1)
    p = db.get_provider(pid, reveal=True)
    if not p:
        raise providers.ProviderError("O provedor deste modelo foi removido. Escolha outro modelo.")
    if not p["enabled"]:
        raise providers.ProviderError(f"O provedor “{p['name']}” está desativado.")
    return p, mid


STYLES = {
    "professional": "Adote um tom profissional: preciso, polido e sem informalidades.",
    "friendly": "Adote um tom amigável: acolhedor e conversador, sem perder a objetividade.",
    "candid": "Seja franco: direto, sem rodeios, e encoraje quando fizer sentido.",
    "quirky": "Seja divertido e criativo no tom, sem sacrificar a correção.",
    "efficient": "Seja eficiente: respostas concisas e simples, sem floreios.",
    "cynical": "Adote um tom crítico e levemente sarcástico, sem ser grosseiro nem impreciso.",
}

TRAITS = {
    "warmth": ("Demonstre mais cordialidade e empatia.", "Mantenha um tom neutro, com pouca cordialidade."),
    "enthusiasm": ("Demonstre entusiasmo.", "Mantenha um tom contido, sem entusiasmo."),
    "headers_lists": ("Use títulos e listas para estruturar as respostas.", "Evite títulos e listas; prefira prosa."),
    "emoji": ("Use emojis quando combinarem com o conteúdo.", "Não use emojis."),
}


def system_prompt(settings):
    """Date + personality + what the user told us about themselves + saved memories + custom instructions."""
    parts = [f"Data atual: {datetime.date.today().isoformat()}."]
    style = [STYLES[settings.get("style")]] if settings.get("style") in STYLES else []
    for key, (more, less) in TRAITS.items():
        if settings.get(key) == "more":
            style.append(more)
        elif settings.get(key) == "less":
            style.append(less)
    if style:
        parts.append("Estilo das respostas:\n" + "\n".join(f"- {s}" for s in style))
    about = []
    if settings.get("nickname", "").strip():
        about.append(f"Chame o usuário de {settings['nickname'].strip()}.")
    if settings.get("occupation", "").strip():
        about.append(f"Ocupação: {settings['occupation'].strip()}.")
    if settings.get("about", "").strip():
        about.append(settings["about"].strip())
    if about:
        parts.append("Sobre o usuário:\n" + "\n".join(about))
    if settings.get("memory_enabled", True):
        mems = [m["content"].strip() for m in db.list_memories() if m["content"].strip()]
        if mems:
            parts.append("Memórias salvas pelo usuário (use quando forem relevantes):\n" + "\n".join(f"- {m}" for m in mems))
    if settings.get("instructions", "").strip():
        parts.append(settings["instructions"].strip())
    return "\n\n".join(parts)


MODE_TEXT = {
    "manual": "O usuário aprova cada edição e cada comando antes da execução.",
    "accept_edits": "Edições de arquivo são aplicadas direto; comandos pedem aprovação do usuário.",
    "auto": "Edições e comandos rodam sem pedir aprovação: seja cuidadoso com comandos destrutivos.",
    "plan": ("MODO PLANO: você só pode explorar (ler, buscar e, com aprovação, rodar comandos que não alteram nada). "
             "Não há ferramentas de edição. Investigue o necessário e termine com um plano concreto e numerado: "
             "arquivos a mudar, o que muda em cada um e como verificar. Não implemente."),
}


def code_system_prompt(settings, conv):
    root = conv["project_path"]
    git = code_tools.git_info(root)
    if git["branch"]:
        git_line = f"- Git: branch `{git['branch']}`" + (
            f"; alterações pendentes:\n{git['status'][:2000]}" if git["status"] else "; árvore limpa")
    else:
        git_line = "- Não é um repositório git."
    parts = [
        "Você é um agente de programação trabalhando no projeto do usuário, no computador dele (Windows). "
        "Você lê, busca e edita arquivos e roda comandos com as ferramentas disponíveis. Trabalhe de forma autônoma "
        "até concluir a tarefa, e só então responda com um resumo curto do que fez e do que verificou.",
        "Ambiente:\n"
        f"- Pasta do projeto (diretório de trabalho): {root}\n"
        "- Sistema: Windows; os comandos rodam no PowerShell (use sintaxe PowerShell, não bash).\n" + git_line,
        "Como trabalhar:\n"
        "- Leia os arquivos relevantes antes de editá-los; siga as convenções que já existem no código.\n"
        "- Prefira edit_file a reescrever arquivos inteiros; use grep/glob para localizar código em vez de adivinhar.\n"
        "- Depois de mudar código, verifique: rode os testes, o build ou o próprio programa quando fizer sentido.\n"
        "- Faça só o que foi pedido. Não faça commit, push nem nada irreversível sem o usuário pedir.\n"
        "- Entre uma etapa e outra, escreva uma frase curta dizendo o que vai fazer; não narre cada ferramenta.\n"
        "- Se o usuário negar uma ação, não insista nela: ajuste o plano ou pergunte.",
    ]
    executor = coordination.executor_note(conv)  # a session an agent delegated work to: its role replaces the mode text
    parts.append(executor or "Permissões: " + MODE_TEXT.get(conv.get("permission_mode") or "manual", MODE_TEXT["manual"]))
    name, text = code_tools.project_instructions(root)
    if text.strip():
        parts.append(f"Instruções do projeto ({name}):\n{text.strip()}")
    return system_prompt(settings) + "\n\n" + "\n\n".join(parts)


def start(conversation_id, assistant_id, model_ref, effort, resume=None):
    """`resume` continues a turn parked on an approval: {"approval": row, "decision", "reason"}."""
    return spawn(Generation(assistant_id, conversation_id), _run, model_ref, effort, resume)


def spawn(g, fn, *args):
    """Registers `g` (so clients can attach, stop and answer it) and runs fn(g, *args) in its own thread.
    _run is one such function; delegate.py's relay is another."""
    with _lock:
        _active[g.message_id] = g
    threading.Thread(target=fn, args=(g, *args), daemon=True, name=f"gen-{g.message_id[:6]}").start()
    bus.publish({"type": "generation", "conversation_id": g.conversation_id, "message_id": g.message_id,
                 "state": "started"})
    return g


def provider_kind(model_ref):
    if model_ref and "::" in model_ref:
        p = db.get_provider(model_ref.split("::", 1)[0], reveal=False)
        return p["kind"] if p else None
    return None


def launch(conv, parent_id, model_ref, effort, call=None):
    """Assistant placeholder under `parent_id` + its generation: how every turn starts (/api/chat, agent
    tasks, a Room's conductor, a delegated Code session). With a `call` (calls.py) the target answers
    as a participant and the conversation keeps its own model and effort; without one, the turn's
    model becomes the conversation's."""
    if call:
        model_ref, effort = call["target"], call.get("effort")
    asst = db.create_message(conv["id"], parent_id, "assistant", model=model_ref, provider_kind=provider_kind(model_ref),
                             status="streaming", call=call)
    patch = {"current_leaf_id": asst["id"]} if call else {"current_leaf_id": asst["id"], "model": model_ref,
                                                          "effort": effort}
    db.update_conversation(conv["id"], patch, touch=True)
    start(conv["id"], asst["id"], model_ref, effort)
    return asst


def _describe(call):
    args = call.get("input") or {}
    return call["name"] + "(" + ", ".join(f"{k}={v!r}"[:120] for k, v in args.items()
                                          if k not in ("code", "content", "old_string", "new_string")) + ")"


def _open_round(g, tool_calls, native=None):
    """Persists the round as two tree nodes — tool_call (the text so far + the calls) and
    tool_result (filled in as calls finish) — and re-parents the assistant placeholder
    under them, so the client renders the calls before they run."""
    placeholder = db.get_message(g.message_id, raw=True)
    call_row = db.create_message(g.conversation_id, placeholder["parent_id"], "tool_call", content=g.content,
                                 model=placeholder["model"], provider_kind=placeholder["provider_kind"])
    db.update_message(call_row["id"], notice="; ".join(_describe(c) for c in tool_calls) or None,
                      reasoning=g.reasoning, raw_blocks={"native": native, "tool_calls": tool_calls})
    result_row = db.create_message(g.conversation_id, call_row["id"], "tool_result", status="streaming")
    db.update_message(result_row["id"], raw_blocks={"tool_results": []})
    db.update_message(g.message_id, content="", reasoning="", parent_id=result_row["id"])
    g.content, g.reasoning = "", ""
    g.push({"type": "reset"})
    return call_row, result_row


def _edit_preview(root, name, args):
    """The diff an edit would produce, shown in the approval card (nothing is written)."""
    try:
        ctx = code_tools.Ctx(root, None)
        full = code_tools.resolve(ctx, args.get("path"))
        rel = code_tools.relpath(ctx, full)
        before = ""
        if os.path.isfile(full):
            before, _ = code_tools.read_text(full)
            before = before.replace("\r\n", "\n")
        if name == "write_file":
            after = (args.get("content") or "").replace("\r\n", "\n")
        else:
            old = (args.get("old_string") or "").replace("\r\n", "\n")
            new = (args.get("new_string") or "").replace("\r\n", "\n")
            if not old or old not in before:
                return {"path": rel}
            after = before.replace(old, new) if args.get("replace_all") else before.replace(old, new, 1)
        diff, added, removed = code_tools.make_diff(rel, before, after)
        return {"path": rel, "diff": diff, "added": added, "removed": removed}
    except Exception:  # noqa: BLE001 - the preview is best effort
        return {}


def _code_call(g, conv, call, rules):
    """Runs one code-session call, asking the user first when the permission mode requires it. A session
    an agent delegated work to (coordination.py) acts under that agent's rules instead: allow, ask, block."""
    name, args = call["name"], call.get("input") or {}
    mode = conv.get("permission_mode") or "manual"
    if mode == "plan" and (name in code_tools.EDITS or code_tools.git_tools.approval_class(name)):
        return {"output": "Modo plano: alterações Git e publicações não são permitidas.", "is_error": True,
                "files": [], "meta": {}}
    agent = coordination.delegating_agent(conv)
    action = None
    if agent:
        action, rule = coordination.decision(agent, name)
        if rule == "block":
            return {"output": f"O usuário bloqueou esta ação para {agent['name']} (e para quem trabalha por ele).",
                    "is_error": True, "files": [], "meta": {"denied": True, "reason": "bloqueado"}}
        kind = None if rule == "allow" else (code_tools.needs_approval(name, args, "manual", []) or "unknown")
    else:
        kind = code_tools.needs_approval(name, args, mode, rules)
    if kind:
        tool, pattern = code_tools.rule_for(name, args)
        preview = _edit_preview(conv["project_path"], name, args) if name in code_tools.EDITS else {}
        request = {"call_id": call["id"], "name": name, "input": args, "kind": kind,
                   "rule": {"tool": tool, "pattern": pattern}, "preview": preview,
                   "summary": code_tools.git_tools.summary(name, args) if name in code_tools.git_tools.TOOLS_BY_NAME else None}
        if agent:  # "always" means the agent's rule for this action, as on the agent's own cards
            request.update(action=action, action_label=agent_mode.ACTIONS[action][0], agent=agent["name"])
        answer = g.ask(request)
        if answer is None:
            return {"output": "Interrompido pelo usuário antes da execução.", "is_error": True, "files": [],
                    "meta": {"cancelled": True}}
        if answer["decision"] == "deny":
            reason = (answer.get("reason") or "").strip()
            hint = " Não tente de novo da mesma forma; ajuste a abordagem ou pergunte."
            if mode == "plan":
                hint = (" Você está no MODO PLANO: não altere nada, nem por comandos. Pare de agir e responda "
                        "agora com o plano numerado.")
            return {"output": "O usuário negou esta ação." + (f" Motivo: {reason}." if reason else "") + hint,
                    "is_error": True, "files": [], "meta": {"denied": True, "reason": reason}}
        if answer["decision"] == "always" and agent:
            db.update_agent(agent["id"], {"rules": dict(agent.get("rules") or {}, **{action: "allow"})})
            bus.publish({"type": "agent", "agent_id": agent["id"]})
        elif answer["decision"] == "always":
            db.add_rule(conv["project_path"], tool, pattern)
            rules.append({"tool": tool, "pattern": pattern})
    ctx = code_tools.Ctx(conv["project_path"], g.message_id, cancel=g.cancel,
                         on_output=lambda text: g.push({"type": "tool_output", "call_id": call["id"], "text": text}))
    return code_tools.execute(name, args, ctx)


def _run_calls(g, conv, result_row, tool_calls, rules, start=0, results=None, forced=None):
    """Executes the round's calls in order, persisting and streaming each result. In an agent
    conversation a call may park the turn (agent_mode.Park): the results so far are kept on the
    round and the calls from that one on run when the user answers (`start`/`results`/`forced`)."""
    code = conv.get("kind") == "code"
    agent = agent_mode.is_agent_conv(conv)
    results = list(results or [])
    file_refs = list(result_row.get("attachments") or [])
    for i in range(start, len(tool_calls)):
        call = tool_calls[i]
        if g.cancel.is_set():
            res = {"output": "Interrompido pelo usuário.", "is_error": True, "files": [], "meta": {"cancelled": True}}
        else:
            g.push({"type": "tool_start", "call_id": call["id"]})
            if code:
                res = _code_call(g, conv, call, rules)
            elif agent:
                try:
                    res = agent_mode.call(g, conv, call, (forced or {}).get(call["id"]))
                except agent_mode.Park as p:
                    db.update_message(result_row["id"], raw_blocks={"tool_results": results},
                                      attachments=json.dumps(file_refs))
                    agent_mode.park(g, conv, result_row, tool_calls, i, p.request)
                    raise
            else:
                g.push({"type": "notice", "text": f"Executando ferramenta “{call['name']}”…"})
                res = agent_tools.execute(call["name"], call.get("input") or {}, g.conversation_id)
        entry = {"id": call["id"], "name": call["name"], "output": res["output"], "is_error": res["is_error"],
                 "meta": res.get("meta") or {}}
        results.append(entry)
        if not code and res["files"]:
            if not agent:
                g.push({"type": "notice", "text": f"Arquivo(s) atualizados: {', '.join(res['files'])}."})
            base = agent_tools.workspace_dir(agent_mode.workspace_key(conv))
            for rel in res["files"]:
                try:
                    size = os.path.getsize(os.path.join(base, rel))
                except OSError:
                    continue
                mime = mimetypes.guess_type(rel)[0] or "application/octet-stream"
                file_refs.append({"id": rel.replace(os.sep, "/"), "name": os.path.basename(rel), "mime": mime,
                                  "size": size, "source": "workspace"})
        db.update_message(result_row["id"], raw_blocks={"tool_results": results})
        g.push({"type": "tool_result", "result": entry})
    # Messages the user typed while the agent worked ride along with the last result.
    with g.cond:
        steer, g.steer = g.steer, []
    if steer and results:
        results[-1]["output"] += "\n\n[Mensagem do usuário enviada durante a execução]\n" + "\n\n".join(steer)
        results[-1]["meta"]["steer"] = steer
        db.update_message(result_row["id"], raw_blocks={"tool_results": results})
    texts = [f"[{r['name']}]" + (" ERRO: " if r["is_error"] else " ") + r["output"][:4000] for r in results]
    db.update_message(result_row["id"], status="complete", notice="\n\n".join(texts) or None,
                      attachments=json.dumps(file_refs))
    return results


def _resume_round(g, conv, resume, rules):
    """Runs what is left of a round parked on an approval, starting with the answered call."""
    appr = resume["approval"]
    row = db.get_message(appr["round_id"], raw=True)
    results = (row.get("raw_blocks") or {}).get("tool_results") or []
    db.update_message(row["id"], status="streaming")
    calls = appr["calls"]
    forced = {calls[appr["call_index"]]["id"]: (resume["decision"], resume.get("reason") or "")}
    _run_calls(g, conv, row, calls, rules, start=appr["call_index"], results=results, forced=forced)
    g.push({"type": "reset"})
    return db.path_to(row["id"])


def _run_tool_round(g, conv, tool_calls, native, rules):
    _call_row, result_row = _open_round(g, tool_calls, native)
    _run_calls(g, conv, result_row, tool_calls, rules)
    g.push({"type": "reset"})
    return db.path_to(result_row["id"])


def _codex_executor(g, conv, rules):
    """Codex runs tools inside its own turn: each call becomes its own round in the tree."""
    counter = [0]

    def run(name, args):
        counter[0] += 1
        call = {"id": f"codex_{int(time.time() * 1000)}_{counter[0]}", "name": name, "input": args}
        _call_row, result_row = _open_round(g, [call])
        results = _run_calls(g, conv, result_row, [call], rules)
        g.push({"type": "reset"})
        return results[0]

    return run


def _close_round(g, result_row, call, res):
    """Records a call that already ran elsewhere (an external harness) as the round's result."""
    entry = {"id": call["id"], "name": call["name"], "output": res["output"], "is_error": res["is_error"],
             "meta": res.get("meta") or {}}
    db.update_message(result_row["id"], status="complete", raw_blocks={"tool_results": [entry]},
                      notice=f"[{call['name']}]" + (" ERRO: " if res["is_error"] else " ") + (res["output"] or "")[:4000])
    g.push({"type": "tool_result", "result": entry})
    g.push({"type": "reset"})


def _external_model(model_ref, kinds):
    """An external harness runs on its own login. A selected model reaches it only when it
    belongs to a provider of a kind it understands (e.g. ChatGPT/Codex models for Codex);
    otherwise the harness's default model runs."""
    if model_ref and "::" in model_ref:
        p = db.get_provider(model_ref.split("::", 1)[0], reveal=False)
        if p and p["kind"] in kinds:
            return model_ref.split("::", 1)[1]
    return None


class External:
    """What an external harness (Codex SDK, Claude SDK, REDIR) reports, turned into the same
    tree and events a CEU turn produces: each action is a round, approvals use the card."""

    def __init__(self, g, conv):
        self.g, self.conv = g, conv
        self.rounds = {}

    def start(self, call):
        if call["id"] in self.rounds:
            return
        _call_row, result_row = _open_round(self.g, [call])
        self.rounds[call["id"]] = (call, result_row)
        self.g.push({"type": "tool_start", "call_id": call["id"]})

    def output(self, call_id, text):
        if call_id in self.rounds and text:
            self.g.push({"type": "tool_output", "call_id": call_id, "text": text})

    def end(self, call, res):
        entry = self.rounds.pop(call["id"], None)
        if entry:
            _close_round(self.g, entry[1], entry[0], res)

    def session(self, sid):
        if sid and sid != self.conv.get("runtime_session"):
            self.conv["runtime_session"] = sid
            db.update_conversation(self.conv["id"], {"runtime_session": sid})

    def ask(self, request):
        """Blocks until the user answers on the approval card; None when the turn was stopped."""
        return self.g.ask(request)

    def steerable(self, fn):
        """The harness takes messages mid-run (Codex `turn/steer`): /steer forwards to it."""
        self.g.steer_to = fn

    def close(self):
        self.g.steer_to = None
        for call, row in list(self.rounds.values()):  # stopped mid-action
            _close_round(self.g, row, call, {"output": "Interrompido.", "is_error": True, "meta": {"cancelled": True}})
        self.rounds.clear()


def _latest_user_text(path, who):
    """External harnesses keep their own history (resumed by session id): they receive only
    the newest user message, with text attachments inlined."""
    user = next((m for m in reversed(path) if m["role"] == "user"), None)
    if not user:
        raise providers.ProviderError("Nada para enviar ao agente externo.")
    parts = []
    for att in user["attachments"]:
        if providers._classify(att) != "text":
            raise providers.ProviderError(f"{who} só recebe anexos de texto por enquanto.")
        parts.append(providers._file_block_text(providers._load(att)))
    if user["content"].strip():
        parts.append(user["content"])
    return "\n\n".join(parts)


def _external_stream(g, conv, runtime, path, model, effort):
    """A turn run by an external harness: Codex SDK, Claude SDK or a REDIR driver."""
    hooks = External(g, conv)
    root, session, mode = conv["project_path"], conv.get("runtime_session"), conv.get("permission_mode")
    try:
        if runtime == "codex_sdk":
            text = _latest_user_text(path, "O Codex SDK")
            yield from codex_sdk.run_turn(root, text, session, mode, model, effort, g.cancel, hooks)
        elif runtime == "claude_sdk":
            text = _latest_user_text(path, "O Claude SDK")
            yield from claude_sdk.run_turn(root, text, session, mode, model, effort, g.cancel, hooks)
        else:
            text = _latest_user_text(path, f"{runtime.name} (REDIR)")
            yield from redir.run_turn(runtime, root, text, session, mode, model, effort, g.cancel,
                                      hooks.start, hooks.end, hooks.session)
    finally:
        hooks.close()


def _run(g, model_ref, effort, resume=None):
    started = time.time()
    first_token = None
    reasoning_start = None
    reasoning_ms = None
    redir_meta = None
    last_flush = 0
    final = {}
    status = "complete"
    error = None
    notices = []
    conv = {}
    agent_conv = False
    hit_limit = False
    multiparty = False
    try:
        path = db.path_to(g.message_id)
        call = path[-1].get("call") if path else None
        invited = bool(call)  # this turn was asked of a named model (calls.py)
        path = path[:-1]  # everything before the assistant placeholder
        multiparty = invited or calls.involved(path)
        settings = db.get_settings()
        conv = db.get_conversation(g.conversation_id) or {}
        code = conv.get("kind") == "code"
        agent_conv = agent_mode.is_agent_conv(conv)
        # An external harness runs the turn: a REDIR driver, or the Codex/Claude SDK runtime.
        runtime_id = code_runtimes.of(conv) if code else code_runtimes.DEFAULT
        external = code_runtimes.driver_for(conv) if code else None
        if runtime_id in ("codex_sdk", "claude_sdk"):
            external = runtime_id
        if external:
            if isinstance(external, redir.Driver) and model_ref and model_ref.startswith(f"redir:{external.id}::"):
                provider, model = None, model_ref.split("::", 1)[1]
            else:
                kinds = external.model_kinds if isinstance(external, redir.Driver) else \
                    {"codex_sdk": ("codex",), "claude_sdk": ("anthropic",)}[external]
                provider, model = None, _external_model(model_ref, kinds)
            if isinstance(external, redir.Driver):
                redir_meta = {"redir": {"requested_model": model, "actual_model": None,
                                        "requested_effort": effort}}
        else:
            provider, model = _resolve_model(model_ref)
        if code and not os.path.isdir(conv.get("project_path") or ""):
            raise providers.ProviderError(f"A pasta do projeto não existe mais: {conv.get('project_path')}")
        if agent_conv and not db.get_agent(conv.get("agent_id") or ""):
            raise providers.ProviderError("Este agente foi removido.")
        g.parkable = agent_conv and provider["kind"] != "codex"
        rules = db.list_rules(conv["project_path"]) if code else []
        room = conv.get("room") if not (code or agent_conv) else None
        # None = the Chat tools; a Room hands them to its participants only when the user turned them on
        tools = None if not room or room.get("tools") else []
        executor = _codex_executor(g, conv, rules) if code or agent_conv else None
        rounds = 0
        if resume:
            path = _resume_round(g, conv, resume, rules)
        while True:
            final = {}
            if external:  # the external harness brings its own prompt, tools and loop
                events = _external_stream(g, conv, external, path, model, effort)
            else:
                if code:  # the mode can change between rounds (e.g. the user switches to Automático)
                    conv = db.get_conversation(g.conversation_id) or conv
                    tools = code_tools.tools_for(conv.get("permission_mode"))
                elif agent_conv:  # rules, notes and tasks can change between rounds
                    agent, task = agent_mode.context(conv)
                    tools = agent_mode.tools_for(conv, agent, task)
                if code:
                    system = code_system_prompt(settings, conv)
                elif agent_conv:
                    system = agent_mode.system_prompt(settings, conv, agent, task)
                else:
                    system = system_prompt(settings)
                # several models in one history: each sees its own turns, the others' as attributed text
                note = calls.system_note(path, model_ref, invited, room, (call or {}).get("room"))
                if note:
                    system = system + "\n\n" + note
                events = providers.stream(provider, model, effort, system, calls.project(path, model_ref), g.cancel,
                                          conversation_id=g.conversation_id, tools=tools, tool_executor=executor)
            for ev in events:
                t = ev["type"]
                if t == "model_used":
                    if redir_meta:
                        redir_meta["redir"]["actual_model"] = ev["model"]
                    continue
                if t == "reasoning":
                    if reasoning_start is None:
                        reasoning_start = time.time()
                elif t == "text":
                    if first_token is None:
                        first_token = time.time()
                        if reasoning_start is not None:
                            reasoning_ms = int((first_token - reasoning_start) * 1000)
                            g.push({"type": "reasoning_done", "ms": reasoning_ms})
                elif t == "notice":
                    notices.append(ev["text"])
                elif t == "final":
                    final = ev
                    continue
                g.push(ev)
                now = time.time()
                if now - last_flush > 1.0:
                    last_flush = now
                    db.update_message(g.message_id, content=g.content, reasoning=g.reasoning)
            if g.cancel.is_set():
                break
            tool_calls = final.get("tool_calls") or []
            rounds += 1
            if not tool_calls:
                break
            if rounds > (MAX_CODE_ROUNDS if code else MAX_AGENT_ROUNDS if agent_conv else MAX_TOOL_ROUNDS):
                hit_limit = True
                notices.append("Limite de rodadas de ferramentas atingido; a tarefa continua sozinha em instantes."
                               if conv.get("kind") == "agent_task" else
                               "Limite de rodadas de ferramentas atingido; peça para continuar.")
                break
            path = _run_tool_round(g, conv, tool_calls, final.get("raw_blocks"), rules)
            if g.cancel.is_set():
                break
        if g.cancel.is_set():
            status = "stopped"
    except agent_mode.Park:
        status = "waiting"  # the rest of the turn runs when the user answers (agent_mode.answer)
    except providers.ProviderError as e:
        status, error = "error", str(e)
    except Exception as e:  # noqa: BLE001 - never leave a message stuck in 'streaming'
        if g.cancel.is_set():
            status = "stopped"
        else:
            import traceback
            traceback.print_exc()
            status, error = "error", f"Erro inesperado: {e}"

    if g.cancel.is_set() and status != "error":
        status = "stopped"
    if reasoning_start is not None and reasoning_ms is None:
        reasoning_ms = int((time.time() - reasoning_start) * 1000)
    if status == "error" and "recusou" in (error or ""):
        g.content = ""  # partial output of a refused turn is discarded
    if multiparty:  # a participant echoing the thread's markup ([@Nome], <fala>) at the start
        g.content = calls.clean(g.content)
    finished = time.time()
    usage = final.get("usage")
    if usage is not None:
        gen_seconds = finished - (reasoning_start or first_token or started)
        if usage.get("output") and gen_seconds > 0:
            usage["tps"] = round(usage["output"] / gen_seconds, 1)
        usage["ttft_ms"] = int(((first_token or reasoning_start or finished) - started) * 1000)
    db.update_message(
        g.message_id,
        content=g.content,
        reasoning=g.reasoning,
        reasoning_ms=reasoning_ms,
        status=status,
        error=error,
        notice=" ".join(notices) or None,
        usage=usage,
        raw_blocks=final.get("raw_blocks") if status == "complete" else redir_meta,
        first_token_at=first_token,
        finished_at=finished,
    )
    db.update_conversation(g.conversation_id, {}, touch=True)
    msg = db.get_message(g.message_id)
    with g.cond:
        g.done = True
        g.finished_at = finished
        g.events.append({"type": "done", "message": msg})
        g.cond.notify_all()
    bus.publish({"type": "generation", "conversation_id": g.conversation_id, "message_id": g.message_id, "state": "done"})
    if agent_conv:
        agent_mode.after_generation(conv, msg, hit_limit)
    _maybe_title(g.conversation_id, model_ref)
    _gc()


def _gc():
    cutoff = time.time() - 120
    with _lock:
        for k in [k for k, v in _active.items() if v.done and v.finished_at and v.finished_at < cutoff]:
            del _active[k]


# ---------------------------------------------------------------- titles

def fallback_title(text):
    text = re.sub(r"\s+", " ", text or "").strip()
    if not text:
        return "Nova conversa"
    if len(text) <= 48:
        return text
    cut = text[:48].rsplit(" ", 1)[0]
    return cut + "…"


def _maybe_title(conversation_id, model_ref):
    conv = db.get_conversation(conversation_id)
    if not conv or conv["title_state"] != "pending":
        return
    if not (model_ref or db.get_settings().get("title_model")):  # a REDIR turn on the CLI's default model
        db.update_conversation(conversation_id, {"title_state": "auto"})
        return
    msgs = db.list_messages(conversation_id)
    first_user = next((m for m in msgs if m["role"] == "user"), None)
    first_asst = next((m for m in msgs if m["role"] == "assistant" and m["status"] == "complete"), None)
    if not first_user or not first_asst:
        return
    db.update_conversation(conversation_id, {"title_state": "generating"})
    threading.Thread(target=_title_worker, args=(conversation_id, model_ref, first_user, first_asst),
                     daemon=True).start()


def _title_worker(conversation_id, model_ref, user_msg, asst_msg):
    title = None
    try:
        settings = db.get_settings()
        provider, model = _resolve_model(settings.get("title_model") or model_ref)
        names = ", ".join(a["name"] for a in user_msg["attachments"])
        prompt = (
            "Crie um título curto (2 a 6 palavras) para a conversa abaixo, no mesmo idioma da mensagem do usuário. "
            "Responda somente com o título, sem aspas, sem pontuação final e sem markdown.\n\n"
            f"<usuario>{user_msg['content'][:1500]}{(' [anexos: ' + names + ']') if names else ''}</usuario>\n"
            f"<assistente>{asst_msg['content'][:800]}</assistente>"
        )
        text = providers.complete_short(provider, model, None, prompt, Cancel())
        text = re.sub(r"<think>.*?</think>", "", text, flags=re.S)
        text = text.strip().splitlines()[0] if text.strip() else ""
        text = text.strip().strip("\"'“”*#").strip().rstrip(".")
        if 0 < len(text) <= 80:
            title = text
    except Exception:  # noqa: BLE001 - title is best-effort
        import traceback
        traceback.print_exc()
        title = None
    conv = db.get_conversation(conversation_id)
    if not conv or conv["title_state"] == "manual":
        return
    if title:
        db.update_conversation(conversation_id, {"title": title, "title_state": "auto"})
    else:
        db.update_conversation(conversation_id, {"title_state": "auto"})
    bus.publish({"type": "conversation", "conversation_id": conversation_id})
