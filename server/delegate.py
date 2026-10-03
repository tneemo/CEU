"""Delegated calls: `@Code` and `@Agent` from a Chat conversation (calls.py has the call format).

Unlike `@modelo`, the target doesn't speak inline. The request and a briefing of the conversation
(calls.brief) go to the target surface, which runs them with its own machinery — nothing here
re-implements Code or Agent:

- `code`: a Code session on the chosen folder, run by the normal CEU loop with its tools, its
  permission mode (manual unless the call says otherwise) and its approval cards. Later calls from
  the same conversation to the same folder continue that session, briefed only with what was said
  since the previous call.
- `agent`: a task of that agent (agent_mode.create_task, the agent's own delegation unit) with its
  notes, computer, rules and parked approvals. The reply returns at the end of the task's run; if
  the agent decided to keep going, the task carries on in the Agent area and the reply says so.

Meanwhile the origin conversation shows a reply in progress: a Relay, which is a Generation like
any other (clients attach to it, stop it) that follows the target's turn, forwards its approval
cards and the user's answers, and ends with the target's final message as the reply. The target
conversation records where the call came from (`conversations.origin`). The work runs with the
target's tools and permissions only: the origin's Chat tools never travel with a delegation.
"""
import time

from . import agent_mode, calls, db, generation, providers


class Relay(generation.Generation):
    """The origin's reply while the work runs elsewhere."""

    def __init__(self, message_id, conversation_id):
        super().__init__(message_id, conversation_id)
        self.target = None  # the target turn's current Generation

    def answer(self, call_id, decision, reason=""):
        """An approval card forwarded from the target, answered in the origin conversation."""
        t = self.target
        return bool(t) and t.answer(call_id, decision, reason)


def start(conv, user, call):
    """The reply placeholder in the origin conversation + the relay that fills it. Returns the placeholder."""
    model = call.get("model") if call["surface"] == "code" else agent_mode.model_for(db.get_agent(call["target"]) or {})
    asst = db.create_message(conv["id"], user["id"], "assistant", model=model, provider_kind=generation.provider_kind(model),
                             status="streaming", call=call)
    db.update_conversation(conv["id"], {"current_leaf_id": asst["id"]}, touch=True)
    generation.spawn(Relay(asst["id"], conv["id"]), _relay, conv, user, call)
    return asst


def _relay(g, conv, user, call):
    status, error, notice, content = "complete", None, None, ""
    try:
        path = db.path_to(user["id"])
        origin = {"conversation_id": conv["id"], "message_id": g.message_id, "title": conv.get("title") or ""}
        if call["surface"] == "code":
            tconv, tmsg = _to_code(path, conv, call, origin)
        else:
            tconv, tmsg = _to_agent(path, conv, call, origin)
        link = dict(call, conversation_id=tconv["id"], message_id=tmsg["id"])
        db.update_message(g.message_id, call=link)
        g.push({"type": "delegate", "call": link, "title": tconv.get("title") or ""})
        generation.bus.publish({"type": "conversation", "conversation_id": tconv["id"]})
        final = _follow(g, tconv, tmsg["id"])
        content = (final.get("content") or "").strip()
        status = final["status"] if final["status"] in ("complete", "error", "stopped") else "stopped"
        if status == "error":
            error = f"{calls.label(calls.addressed(call))}: {final.get('error') or 'erro desconhecido'}"
        if call["surface"] == "agent" and status == "complete":
            notice = _task_outcome(tconv)
        elif status == "complete" and final.get("notice"):
            notice = final["notice"]
    except providers.ProviderError as e:
        status, error = "error", str(e)
    except Exception as e:  # noqa: BLE001 - never leave the origin reply stuck in 'streaming'
        import traceback
        traceback.print_exc()
        status, error = "error", f"Erro inesperado: {e}"
    if g.cancel.is_set() and status != "error":
        status = "stopped"
    finished = time.time()
    db.update_message(g.message_id, content=content, status=status, error=error, notice=notice, finished_at=finished)
    db.update_conversation(conv["id"], {}, touch=True)
    msg = db.get_message(g.message_id)
    with g.cond:
        g.content = content
        g.done = True
        g.finished_at = finished
        g.events.append({"type": "done", "message": msg})
        g.cond.notify_all()
    generation.bus.publish({"type": "generation", "conversation_id": conv["id"], "message_id": g.message_id,
                            "state": "done"})
    generation._maybe_title(conv["id"], conv.get("model"))
    generation._gc()


# ---------------------------------------------------------------- targets

def _to_code(path, conv, call, origin):
    session = db.delegated_session(conv["id"], call["target"])
    since = None
    if session:
        if generation.active_for(session["id"]):
            raise providers.ProviderError("A sessão de Code desta conversa ainda está trabalhando. Espere ela terminar.")
        # brief only what was said after the previous call to this session
        since = next((m["id"] for m in reversed(path) if (m.get("call") or {}).get("conversation_id") == session["id"]),
                     None)
        session = db.update_conversation(session["id"], {"origin": origin})
    else:
        title = generation.fallback_title(path[-1]["content"] or f"Chamada de “{origin['title']}”")
        session = db.create_conversation(call["model"], call.get("effort"), kind="code", project_path=call["target"],
                                         permission_mode=call.get("mode") or "manual", title=title, origin=origin)
    user = db.create_message(session["id"], session["current_leaf_id"], "user", content=calls.brief(path, conv, since),
                             attachments=path[-1]["attachments"])
    return session, generation.launch(session, user["id"], call["model"], call.get("effort"))


def _to_agent(path, conv, call, origin):
    agent = db.get_agent(call["target"])
    if not agent:
        raise providers.ProviderError("Este agente foi removido.")
    if not agent_mode.model_for(agent):
        raise providers.ProviderError(f"{agent['name']} não tem um modelo configurado.")
    if path[-1]["attachments"]:
        raise providers.ProviderError("Anexos ainda não são repassados a um agente: descreva o conteúdo no pedido.")
    title = generation.fallback_title(path[-1]["content"] or f"Pedido de “{origin['title']}”")
    task = agent_mode.create_task(agent, title, calls.brief(path, conv), None, start_now=True, by="call", origin=origin)
    tconv = db.get_conversation(task["conversation_id"])
    leaf = db.get_message(tconv["current_leaf_id"]) if tconv and tconv.get("current_leaf_id") else None
    if task["status"] != "running" or not leaf:
        raise providers.ProviderError(task.get("last_result") or "A tarefa do agente não começou.")
    return tconv, leaf


def _follow(g, tconv, mid):
    """Waits for the target's turn to end (across parked approvals, which end one generation and start
    another on the same message), forwarding its approval cards. Stopping the origin stops the target."""
    current, cursor = None, 0
    while True:
        if g.cancel.is_set():
            generation.stop(mid)
            agent_mode.cancel_parked(tconv["id"], "Cancelado: o usuário interrompeu a chamada na conversa de origem.")
            for _ in range(50):  # let the target close its turn
                if db.get_message(mid)["status"] not in ("streaming",):
                    break
                time.sleep(0.1)
            return db.get_message(mid)
        t = generation.get(mid)
        if t is not current:
            current, cursor = t, 0
            g.target = t
        if t:
            events, cursor, done = t.wait(cursor, timeout=1.0)
            for ev in events:
                if ev["type"] in ("approval", "approval_done"):
                    g.push(ev)
            if not done:
                continue
        m = db.get_message(mid)
        if m["status"] not in ("streaming", "waiting"):
            return m
        time.sleep(0.5)  # parked on an approval, or between two generations of the same turn


def _task_outcome(tconv):
    """What became of the agent's task once its run ended (agent_mode applies the outcome just after)."""
    task = None
    for _ in range(30):
        task = db.task_for_conversation(tconv["id"])
        if not task or task["status"] != "running":
            break
        time.sleep(0.1)
    if not task:
        return None
    if task["status"] == "blocked":
        return "O agente precisa de uma resposta sua para continuar esta tarefa (no Agent)."
    if task["status"] == "idle" and task.get("next_run_at"):
        return f"A tarefa segue em segundo plano no Agent: próxima execução {agent_mode._when(task['next_run_at'])}."
    return None
