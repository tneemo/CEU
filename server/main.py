"""HTTP server: JSON API + SSE + static files. Standard library only (plus the Anthropic SDK)."""
import argparse
import json
import mimetypes
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import (agent_mode, agent_tools, calls, code_runtimes, code_tools, codex_bridge, db, delegate, generation,
               github, integrations, providers, rooms, suggestions)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")
MAX_UPLOAD = 25 * 1024 * 1024

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("font/woff2", ".woff2")

ROUTES = []


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn
    return deco


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


def _model_meta(model_ref):
    if not model_ref or "::" not in model_ref:
        return None
    return model_ref.split("::", 1)[1]


# ---------------------------------------------------------------- state

@route("GET", "/api/state")
def api_state(h, m):
    return {"providers": db.list_providers(), "settings": db.get_settings(), "presets": providers.PRESETS,
            "efforts": _efforts_index(), "runtimes": code_runtimes.describe(), "integrations": integrations.describe()}


def _efforts_index():
    out = {}
    for p in db.list_providers():
        if p["kind"] == "anthropic":
            for mdl in p["models"]:
                effs = providers.efforts_for(mdl["id"])
                if effs:
                    out[f"{p['id']}::{mdl['id']}"] = {"levels": effs, "default": providers.default_effort(mdl["id"])}
        elif p["kind"] == "codex":
            for mdl in p["models"]:
                effs = mdl.get("effortLevels")
                if effs:
                    out[f"{p['id']}::{mdl['id']}"] = {"levels": effs, "default": mdl.get("defaultEffort") or effs[0]}
    return out


@route("GET", "/api/suggestions")
def api_suggestions(h, m):
    return {"items": suggestions.home()}


@route("PUT", "/api/settings")
def api_settings(h, m):
    return db.update_settings(h.json())


# ---------------------------------------------------------------- providers

@route("POST", "/api/providers")
def api_provider_create(h, m):
    body = h.json()
    preset = body.get("preset", "custom")
    base = providers.PRESETS.get(preset, providers.PRESETS["custom"])
    p = db.create_provider(base["kind"], preset, (body.get("name") or base["name"]).strip(),
                           (body.get("base_url") or base["base_url"]).strip(), (body.get("api_key") or "").strip())
    return _refresh_models(p["id"])


def _refresh_models(pid):
    p = db.get_provider(pid, reveal=True)
    error = None
    try:
        models = providers.list_models(p)
        custom = [x for x in p["models"] if x.get("custom")]
        ids = {x["id"] for x in models}
        db.update_provider(pid, {"models": models + [c for c in custom if c["id"] not in ids]})
    except providers.ProviderError as e:
        error = str(e)
    return {"provider": db.get_provider(pid, reveal=False), "error": error}


@route("POST", r"/api/providers/(\w+)/refresh")
def api_provider_refresh(h, m):
    return _refresh_models(m[1])


@route("PATCH", r"/api/providers/(\w+)")
def api_provider_update(h, m):
    body = h.json()
    patch = {k: body[k] for k in ("name", "base_url", "api_key", "enabled") if k in body}
    if "add_model" in body:
        p = db.get_provider(m[1], reveal=False)
        mid = body["add_model"].strip()
        if mid and all(x["id"] != mid for x in p["models"]):
            patch["models"] = p["models"] + [{"id": mid, "name": mid, "custom": True}]
    db.update_provider(m[1], patch)
    if "api_key" in patch or "base_url" in patch:
        return _refresh_models(m[1])
    return {"provider": db.get_provider(m[1], reveal=False), "error": None}


@route("DELETE", r"/api/providers/(\w+)")
def api_provider_delete(h, m):
    db.delete_provider(m[1])
    return {"ok": True}


# ---------------------------------------------------------------- integrations (runtimes/agents hub)
#
# One lifecycle for every external harness (integrations.py). The client only triggers actions
# and renders snapshots; secrets never come back in a response.

def _integration(iid):
    if iid not in integrations.BY_ID:
        raise HttpError(404, "Integração desconhecida.")
    return iid


@route("GET", "/api/integrations")
def api_integrations(h, m):
    refresh = (h.query().get("refresh") or ["0"])[0] == "1"
    return {"integrations": integrations.describe(refresh=refresh), "runtimes": code_runtimes.describe()}


# ---------------------------------------------------------------- GitHub credentials

@route("GET", "/api/github")
def api_github(h, m):
    return {"github": github.describe(), "git_installed": code_tools.git_tools.git_available()}


@route("POST", r"/api/github/(connect|disconnect|validate)")
def api_github_action(h, m):
    action = m[1]
    try:
        if action == "connect":
            body = h.json()
            token = body.pop("token", "")
            body.clear()
            try:
                snap = github.connect(token)
            finally:
                token = ""
        elif action == "disconnect":
            snap = github.disconnect()
        else:
            snap = github.validate()
    except github.GitHubError as e:
        raise HttpError(e.status, str(e))
    return {"github": snap}


@route("POST", r"/api/integrations/(\w+)/(install|login|cancel|logout|validate|refresh)")
def api_integration_action(h, m):
    iid, action = _integration(m[1]), m[2]
    body = h.json()
    try:
        if action == "install":
            snap = integrations.install(iid)
        elif action == "login":
            snap = integrations.login(iid, body.get("method"), body.get("params") or {})
        elif action == "cancel":
            snap = integrations.cancel(iid)
        elif action == "logout":
            snap = integrations.logout(iid)
        elif action == "validate":
            snap = integrations.validate(iid)
        else:
            snap = integrations.get(iid, refresh=True)
    except integrations.SetupError as e:
        raise HttpError(400, str(e))
    except codex_bridge.CodexError as e:
        raise HttpError(502, str(e))
    return {"integration": snap}


def _integration_connected(iid):
    """A login finished: the ChatGPT provider (same Codex account) gets its model list."""
    if integrations.BY_ID[iid].group == "codex":
        for p in db.list_providers():
            if p["preset"] == "codex":
                _refresh_models(p["id"])


# ---------------------------------------------------------------- codex (ChatGPT OAuth login)
# Legacy routes of the ChatGPT provider card in web/ (vanilla client). The React client logs in
# through /api/integrations/codex_sdk (same Codex account, same app-server calls).

_codex_logins = {}  # loginId -> {"queue": ..., "cancel": threading.Event()}
_codex_logins_lock = threading.Lock()


def _codex_provider():
    for p in db.list_providers():
        if p["preset"] == "codex":
            return p
    base = providers.PRESETS["codex"]
    return db.create_provider(base["kind"], "codex", base["name"], "", "")


@route("GET", "/api/providers/codex/account")
def api_codex_account(h, m):
    try:
        return codex_bridge.account_status()
    except codex_bridge.CodexError as e:
        return {"connected": False, "email": None, "plan": None, "error": str(e)}


@route("POST", "/api/providers/codex/login/start")
def api_codex_login_start(h, m):
    try:
        login_id, q = codex_bridge.start_login()
    except codex_bridge.CodexError as e:
        raise HttpError(502, str(e))
    with _codex_logins_lock:
        _codex_logins[login_id] = {"queue": q, "cancel": threading.Event()}
    return {"loginId": login_id}


@route("POST", "/api/providers/codex/login/wait")
def api_codex_login_wait(h, m):
    body = h.json()
    login_id = body.get("loginId")
    with _codex_logins_lock:
        entry = _codex_logins.get(login_id)
    if not entry:
        raise HttpError(404, "Login desconhecido ou já concluído.")
    try:
        account = codex_bridge.wait_login(entry["queue"], login_id, entry["cancel"], timeout=25)
    except codex_bridge.CodexError as e:
        with _codex_logins_lock:
            _codex_logins.pop(login_id, None)
        codex_bridge.unwatch_login(entry["queue"])
        raise HttpError(502, str(e))
    if account is None:
        return {"done": False}
    with _codex_logins_lock:
        _codex_logins.pop(login_id, None)
    codex_bridge.unwatch_login(entry["queue"])
    p = _codex_provider()
    _refresh_models(p["id"])
    return {"done": True, "account": account}


@route("POST", "/api/providers/codex/login/cancel")
def api_codex_login_cancel(h, m):
    body = h.json()
    login_id = body.get("loginId")
    with _codex_logins_lock:
        entry = _codex_logins.pop(login_id, None)
    if entry:
        entry["cancel"].set()
        codex_bridge.unwatch_login(entry["queue"])
    codex_bridge.cancel_login(login_id)
    return {"ok": True}


# ---------------------------------------------------------------- conversations

@route("GET", "/api/conversations")
def api_conversations(h, m):
    active = generation.active_conversations()
    convs = db.list_conversations(archived=(h.query().get("archived") or ["0"])[0] == "1")
    for c in convs:
        c["streaming"] = c["id"] in active or rooms.running(c["id"])
    return convs


@route("GET", r"/api/conversations/(\w+)")
def api_conversation(h, m):
    conv = db.get_conversation(m[1])
    if not conv:
        raise HttpError(404, "Conversa não encontrada.")
    msgs = db.list_messages(m[1])
    for msg in msgs:
        if msg["status"] == "streaming":
            g = generation.get(msg["id"])
            if g:
                msg["content"], msg["reasoning"] = g.content, g.reasoning
    if conv.get("kind") == "code":
        _decorate_code(conv, msgs)
    elif agent_mode.is_agent_conv(conv):
        _decorate_agent(conv, msgs)
    if conv.get("room"):
        conv["room_running"] = rooms.running(conv["id"])
    return {"conversation": conv, "messages": msgs}


def _decorate_undo(msgs):
    undoable = db.turns_with_checkpoints([x["id"] for x in msgs if x["role"] == "assistant"])
    for msg in msgs:
        if msg["id"] in undoable:
            msg["undoable"] = True


def _decorate_code(conv, msgs):
    """Project status for the header, and which turns can still be undone."""
    root = conv.get("project_path") or ""
    conv["project_exists"] = os.path.isdir(root)
    conv["git_branch"] = code_tools.git_info(root)["branch"] if conv["project_exists"] else None
    _decorate_undo(msgs)


def _decorate_agent(conv, msgs):
    """Which agent/task the thread belongs to, and the approval it is parked on (if any)."""
    agent = db.get_agent(conv.get("agent_id") or "")
    conv["agent"] = {"id": agent["id"], "name": agent["name"]} if agent else None
    task = db.task_for_conversation(conv["id"])
    conv["task"] = {k: task[k] for k in ("id", "title", "kind", "status", "schedule")} if task else None
    pend = db.pending_approvals(conversation_id=conv["id"])
    conv["pending_approval"] = ({"id": pend[0]["id"], "message_id": pend[0]["message_id"], "request": pend[0]["request"]}
                                if pend else None)
    _decorate_undo(msgs)


@route("PATCH", r"/api/conversations/(\w+)")
def api_conversation_update(h, m):
    body = h.json()
    patch = {k: body[k] for k in ("title", "pinned", "archived", "current_leaf_id", "model", "effort",
                                  "permission_mode", "room") if k in body}
    if "room" in patch:
        cur = db.get_conversation(m[1])
        if not cur or not cur.get("room"):
            raise HttpError(400, "Só uma Room tem participantes e rodadas.")
        try:
            patch["room"] = rooms.normalize(patch["room"])
        except ValueError as e:
            raise HttpError(400, str(e))
    if "permission_mode" in patch:
        rt = code_runtimes.get(code_runtimes.of(db.get_conversation(m[1])))
        if patch["permission_mode"] not in db.PERMISSION_MODES or (rt and patch["permission_mode"] not in rt["modes"]):
            raise HttpError(400, "Modo de permissão inválido para este runtime.")
    if patch.get("archived"):
        patch["pinned"] = False
    if "title" in patch:
        patch["title"] = patch["title"].strip()[:120] or "Nova conversa"
        patch["title_state"] = "manual"
    conv = db.update_conversation(m[1], patch)
    if conv and conv.get("kind") == "agent" and ("model" in patch or "effort" in patch):
        # the model picker in an agent's thread is the agent's model: its tasks use it too
        db.update_agent(conv["agent_id"], {k: patch[k] for k in ("model", "effort") if k in patch})
    generation.bus.publish({"type": "conversation", "conversation_id": m[1]})
    return conv


@route("DELETE", r"/api/conversations/(\w+)")
def api_conversation_delete(h, m):
    for msg in db.list_messages(m[1]):
        if msg["status"] == "streaming":
            generation.stop(msg["id"])
    db.update_conversation(m[1], {"deleted_at": time.time()})
    generation.bus.publish({"type": "conversation", "conversation_id": m[1], "deleted": True})
    return {"ok": True}


@route("POST", r"/api/conversations/(\w+)/restore")
def api_conversation_restore(h, m):
    db.update_conversation(m[1], {"deleted_at": None})
    generation.bus.publish({"type": "conversation", "conversation_id": m[1]})
    return db.get_conversation(m[1])


@route("DELETE", "/api/conversations")
def api_conversations_delete_all(h, m):
    for cid in generation.active_conversations():
        for msg in db.list_messages(cid):
            generation.stop(msg["id"])
    db.delete_all_conversations()
    generation.bus.publish({"type": "conversation", "conversation_id": None, "deleted": True})
    return {"ok": True}


@route("POST", "/api/archive")
def api_archive_all(h, m):
    db.archive_all()
    generation.bus.publish({"type": "conversation", "conversation_id": None})
    return {"ok": True}


@route("DELETE", "/api/archive")
def api_archive_delete(h, m):
    db.delete_archived()
    return {"ok": True}


# ---------------------------------------------------------------- memories

@route("GET", "/api/memories")
def api_memories(h, m):
    return db.list_memories()


@route("POST", "/api/memories")
def api_memory_create(h, m):
    content = (h.json().get("content") or "").strip()
    if not content:
        raise HttpError(400, "A memória está vazia.")
    return db.create_memory(content[:2000])


@route("PATCH", r"/api/memories/(\w+)")
def api_memory_update(h, m):
    content = (h.json().get("content") or "").strip()
    if not content:
        raise HttpError(400, "A memória está vazia.")
    mem = db.update_memory(m[1], content[:2000])
    if not mem:
        raise HttpError(404, "Memória não encontrada.")
    return mem


@route("DELETE", r"/api/memories/(\w+)")
def api_memory_delete(h, m):
    db.delete_memory(m[1])
    return {"ok": True}


@route("DELETE", "/api/memories")
def api_memories_delete_all(h, m):
    db.delete_all_memories()
    return {"ok": True}


# ---------------------------------------------------------------- usage, storage, export

@route("GET", "/api/usage")
def api_usage(h, m):
    return db.usage()


@route("GET", "/api/storage")
def api_storage(h, m):
    return db.storage()


@route("GET", "/api/export")
def api_export_all(h, m):
    data = json.dumps(db.export_all(), ensure_ascii=False, indent=1).encode("utf-8")
    h.send_response(200)
    h.send_header("Content-Type", "application/json; charset=utf-8")
    h.send_header("Content-Disposition", "attachment; filename=ceu-export.json")
    h.send_header("Content-Length", str(len(data)))
    h._add_cors()
    h.end_headers()
    h.wfile.write(data)
    return None


@route("GET", r"/api/conversations/(\w+)/export")
def api_export(h, m):
    conv = db.get_conversation(m[1])
    if not conv:
        raise HttpError(404, "Conversa não encontrada.")
    lines = [f"# {conv['title'] or 'Conversa'}", ""]
    for msg in db.path_to(conv["current_leaf_id"]):
        if msg["role"] == "user":
            who = "Você" + (f" → {calls.label(calls.addressed(msg['call']))}" if msg.get("call") else "")
        else:
            who = (calls.label(calls.ref_of(msg)) if msg.get("call") else _model_meta(msg["model"])) or "Assistente"
        lines.append(f"## {who}")
        lines.append("")
        for a in msg["attachments"]:
            lines.append(f"> Anexo: {a['name']}")
        if msg["attachments"]:
            lines.append("")
        lines.append(msg["content"].strip() or "_(sem conteúdo)_")
        lines.append("")
    data = "\n".join(lines).encode("utf-8")
    name = re.sub(r'[\\/:*?"<>|]+', "", conv["title"] or "conversa")[:60].strip() or "conversa"
    h.send_response(200)
    h.send_header("Content-Type", "text/markdown; charset=utf-8")
    h.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(name + ".md"))
    h.send_header("Content-Length", str(len(data)))
    h._add_cors()
    h.end_headers()
    h.wfile.write(data)
    return None


@route("GET", r"/api/conversations/(\w+)/workspace/(.+)")
def api_workspace_file(h, m):
    conv = db.get_conversation(m[1])
    if not conv:
        raise HttpError(404, "Conversa não encontrada.")
    rel = urllib.parse.unquote(m[2])
    base = os.path.normpath(agent_tools.workspace_dir(agent_mode.workspace_key(conv)))
    full = os.path.normpath(os.path.join(base, rel))
    if (full != base and not full.startswith(base + os.sep)) or not os.path.isfile(full):
        raise HttpError(404, "Arquivo não encontrado.")
    with open(full, "rb") as f:
        data = f.read()
    name = os.path.basename(full)
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    h.send_response(200)
    h.send_header("Content-Type", mime)
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Content-Disposition", "attachment; filename*=UTF-8''" + urllib.parse.quote(name))
    h.send_header("Cache-Control", "no-store")
    h._add_cors()
    h.end_headers()
    h.wfile.write(data)
    return None


@route("GET", "/api/search")
def api_search(h, m):
    q = (h.query().get("q") or [""])[0].strip()
    if not q:
        return []
    return db.search(q)


# ---------------------------------------------------------------- chat

def _check_idle(conversation_id):
    if conversation_id in generation.active_conversations():
        raise HttpError(409, "Aguarde a resposta atual terminar ou interrompa-a.")
    if rooms.running(conversation_id):
        raise HttpError(409, "A Room ainda está em andamento: aguarde a sequência terminar ou interrompa-a.")


def _take_turn(conversation_id):
    """A new turn in a thread parked on an approval closes that approval first."""
    _check_idle(conversation_id)
    agent_mode.cancel_parked(conversation_id)


def _launch(conv, parent_id, model_ref, effort, call=None):
    """Assistant placeholder + generation. With a `call` (calls.py) the target answers instead, as a
    participant: the conversation keeps its own model and effort."""
    agent_mode.on_user_turn(conv)
    return generation.launch(conv, parent_id, model_ref, effort, call=call)


def _answer(conv, user, model_ref, effort, call=None):
    """Who answers a user message: a delegated call goes to its surface (delegate.py), a Room's
    conductor runs the sequence (rooms.py), anything else is one turn."""
    if calls.is_delegated(call):
        return delegate.start(conv, user, call)
    if conv.get("room") and not call:
        try:
            return rooms.start(conv, user["id"])
        except ValueError as e:
            raise HttpError(409, str(e))
    return _launch(conv, user["id"], model_ref, effort, call=call)


@route("POST", "/api/chat")
def api_chat(h, m):
    body = h.json()
    content = body.get("content", "")
    attachments = body.get("attachments") or []
    call = _call_of(body)
    if not content.strip() and not attachments and not call:  # a bare `@modelo` asks that model to speak
        raise HttpError(400, "Mensagem vazia.")
    model_ref, effort = body.get("model"), body.get("effort")
    cid = body.get("conversation_id")
    if cid:
        conv = db.get_conversation(cid)
        if not conv:
            raise HttpError(404, "Conversa não encontrada.")
        if call and (conv.get("kind") or "chat") != "chat":
            raise HttpError(400, "Chamar outro modelo só funciona em conversas do Chat por enquanto.")
        if calls.is_delegated(call) and conv.get("temporary"):
            raise HttpError(400, "Uma conversa temporária não delega trabalho ao Code ou ao Agent.")
        _take_turn(cid)
    elif body.get("kind") == "code":
        if call:
            raise HttpError(400, "Chamar outro modelo só funciona em conversas do Chat por enquanto.")
        root = os.path.normpath((body.get("project_path") or "").strip().strip('"'))
        if not root or not os.path.isabs(root) or not os.path.isdir(root):
            raise HttpError(400, "Escolha uma pasta de projeto que exista.")
        rt = code_runtimes.check_ready(body.get("runtime"))
        if not rt:
            raise HttpError(400, "Runtime desconhecido.")
        if rt["status"] != "ready":
            raise HttpError(400, f"{rt['name']}: {rt['detail']}")
        mode = body.get("permission_mode")
        conv = db.create_conversation(model_ref, effort, kind="code", project_path=root, runtime=rt["id"],
                                      permission_mode=mode if mode in rt["modes"] else rt["default_mode"])
        db.update_conversation(conv["id"], {"title": generation.fallback_title(content)})
    else:
        if calls.is_delegated(call) and body.get("temporary"):
            raise HttpError(400, "Uma conversa temporária não delega trabalho ao Code ou ao Agent.")
        conv = db.create_conversation(model_ref, effort, temporary=bool(body.get("temporary")))
        names = " ".join(a["name"] for a in attachments)
        db.update_conversation(conv["id"], {"title": generation.fallback_title(content or names)})
    parent_id = body.get("parent_id")
    if parent_id:
        parent = db.get_message(parent_id)
        if not parent or parent["conversation_id"] != conv["id"]:
            raise HttpError(400, "Mensagem de origem inválida.")
    user = db.create_message(conv["id"], parent_id, "user", content=content, attachments=attachments, call=call)
    asst = _answer(conv, user, model_ref, effort, call=call)
    generation.bus.publish({"type": "conversation", "conversation_id": conv["id"]})
    return {"conversation": db.get_conversation(conv["id"]), "user": user, "assistant": asst}


def _call_of(body):
    """The structured call (`@modelo`, `@Code`, `@Agent`) a request carries, validated; None without one."""
    try:
        return calls.normalize(body.get("call"), body.get("model"), body.get("effort"))
    except ValueError as e:
        raise HttpError(400, str(e))


_LINK = ("conversation_id", "message_id")  # where a delegated call ran (delegate.py), not part of the request


@route("POST", r"/api/messages/(\w+)/regenerate")
def api_regenerate(h, m):
    body = h.json()
    msg = db.get_message(m[1])
    if not msg or msg["role"] != "assistant":
        raise HttpError(404, "Mensagem não encontrada.")
    _take_turn(msg["conversation_id"])
    conv = db.get_conversation(msg["conversation_id"])
    model_ref, call = (body.get("model") if "model" in body else msg["model"]), msg.get("call")
    if calls.is_delegated(call):  # delegated work is asked again of the same surface
        asst = delegate.start(conv, db.get_message(msg["parent_id"]), {k: v for k, v in call.items() if k not in _LINK})
        return {"conversation": db.get_conversation(conv["id"]), "assistant": asst}
    if call and model_ref != call["target"]:  # a participant's turn redone by another model stays a call
        room = call.get("room")
        call = _call_of({"call": dict(call, target=model_ref, effort=body.get("effort"))})
        if room:
            call["room"] = room
    asst = _launch(conv, msg["parent_id"], model_ref, body.get("effort"), call=call)
    return {"conversation": db.get_conversation(conv["id"]), "assistant": asst}


@route("POST", r"/api/messages/(\w+)/edit")
def api_edit(h, m):
    body = h.json()
    msg = db.get_message(m[1])
    if not msg or msg["role"] != "user":
        raise HttpError(404, "Mensagem não encontrada.")
    content = body.get("content", "")
    attachments = body.get("attachments", msg["attachments"])
    if not content.strip() and not attachments:
        raise HttpError(400, "Mensagem vazia.")
    call = _call_of(body) if "call" in body else msg.get("call")  # an edit keeps who the message was for
    _take_turn(msg["conversation_id"])
    conv = db.get_conversation(msg["conversation_id"])
    user = db.create_message(conv["id"], msg["parent_id"], "user", content=content, attachments=attachments, call=call)
    asst = _answer(conv, user, body.get("model") if "model" in body else conv["model"],
                   body.get("effort"), call=call)
    return {"conversation": db.get_conversation(conv["id"]), "user": user, "assistant": asst}


@route("PATCH", r"/api/messages/(\w+)")
def api_message_update(h, m):
    body = h.json()
    if "feedback" in body:
        v = body["feedback"]
        if v not in (1, -1, None):
            raise HttpError(400, "Avaliação inválida.")
        db.set_feedback(m[1], v)
    msg = db.get_message(m[1])
    if not msg:
        raise HttpError(404, "Mensagem não encontrada.")
    return msg


@route("POST", r"/api/messages/(\w+)/branch")
def api_branch(h, m):
    msg = db.get_message(m[1])
    if not msg:
        raise HttpError(404, "Mensagem não encontrada.")
    if msg["status"] == "streaming":
        raise HttpError(409, "Aguarde a resposta terminar para ramificar.")
    conv = db.branch_conversation(m[1])
    generation.bus.publish({"type": "conversation", "conversation_id": conv["id"]})
    return conv


@route("POST", r"/api/messages/(\w+)/stop")
def api_stop(h, m):
    return {"stopped": generation.stop(m[1])}


# ---------------------------------------------------------------- rooms

@route("GET", "/api/rooms/templates")
def api_room_templates(h, m):
    return rooms.templates()


@route("POST", "/api/rooms")
def api_room_create(h, m):
    body = h.json()
    try:
        room = rooms.normalize(body.get("room"))
    except ValueError as e:
        raise HttpError(400, str(e))
    first = room["order"][0]
    conv = db.create_conversation(first, calls.normalize({"surface": "chat", "target": first})["effort"], room=room,
                                  title=(body.get("title") or "").strip()[:120])
    if not conv["title"]:  # the title model renames it after the first exchange
        conv = db.update_conversation(conv["id"], {"title": rooms.default_title(room)})
    generation.bus.publish({"type": "conversation", "conversation_id": conv["id"]})
    return conv


# ---------------------------------------------------------------- code sessions

@route("POST", r"/api/messages/(\w+)/approval")
def api_approval(h, m):
    body = h.json()
    decision = body.get("decision")
    if decision not in ("allow", "always", "deny"):
        raise HttpError(400, "Resposta inválida.")
    g = generation.get(m[1])
    if not g or not g.answer(body.get("call_id"), decision, (body.get("reason") or "")[:2000]):
        raise HttpError(409, "Esta aprovação não está mais pendente.")
    return {"ok": True}


@route("POST", r"/api/conversations/(\w+)/steer")
def api_steer(h, m):
    text = (h.json().get("text") or "").strip()
    if not text:
        raise HttpError(400, "Mensagem vazia.")
    conv = db.get_conversation(m[1])
    if conv and conv.get("kind") == "code":
        rt = code_runtimes.get(code_runtimes.of(conv))
        if rt and not rt["caps"].get("steer"):
            raise HttpError(409, f"{rt['name']} não recebe mensagens durante a execução. Aguarde ou interrompa.")
    g = generation.active_for(m[1])
    if not g:
        raise HttpError(409, "Nada em execução nesta conversa.")
    if g.steer_to:  # the harness takes it directly (Codex SDK: turn/steer)
        try:
            g.steer_to(text[:8000])
        except Exception as e:  # noqa: BLE001
            raise HttpError(409, f"Não foi possível enviar a mensagem ao agente: {e}")
        g.push({"type": "steer", "text": text[:8000]})
        return {"ok": True}
    with g.cond:
        g.steer.append(text[:8000])
    g.push({"type": "steer", "text": text[:8000]})
    return {"ok": True}


@route("POST", r"/api/messages/(\w+)/undo")
def api_undo(h, m):
    msg = db.get_message(m[1])
    if not msg:
        raise HttpError(404, "Mensagem não encontrada.")
    _check_idle(msg["conversation_id"])
    restored = code_tools.undo_turn(m[1])
    generation.bus.publish({"type": "conversation", "conversation_id": msg["conversation_id"]})
    return {"restored": len(restored)}


@route("GET", "/api/projects")
def api_projects(h, m):
    out = []
    for p in db.recent_projects():
        p["name"] = os.path.basename(p["project_path"].rstrip("\\/")) or p["project_path"]
        p["exists"] = os.path.isdir(p["project_path"])
        out.append(p)
    return out


@route("POST", "/api/projects/pick")
def api_project_pick(h, m):
    """Native folder picker. Runs in a child process: Tk must own its thread, and the
    server (not the webview) is what lives on the user's desktop in both the Tauri app
    and the browser."""
    script = ("import tkinter as tk\nfrom tkinter import filedialog\nr = tk.Tk(); r.withdraw(); "
              "r.attributes('-topmost', True)\n"
              "print(filedialog.askdirectory(parent=r, mustexist=True, title='Escolha a pasta do projeto') or '')")
    try:
        out = subprocess.run([sys.executable, "-c", script], capture_output=True, timeout=600,
                             creationflags=0x0800_0000 if os.name == "nt" else 0)
    except subprocess.TimeoutExpired:
        return {"path": None}
    path = out.stdout.decode("utf-8", "replace").strip()
    return {"path": os.path.normpath(path) if path else None}


@route("POST", "/api/projects/open")
def api_project_open(h, m):
    path = (h.json().get("path") or "").strip()
    if not os.path.isdir(path):
        raise HttpError(404, "Pasta não encontrada.")
    os.startfile(path)  # noqa: S606 - opens Explorer on a folder the user chose
    return {"ok": True}


@route("GET", "/api/projects/rules")
def api_project_rules(h, m):
    return db.list_rules((h.query().get("path") or [""])[0])


@route("DELETE", "/api/projects/rules")
def api_project_rule_delete(h, m):
    body = h.json()
    db.delete_rule(body.get("path") or "", body.get("tool") or "", body.get("pattern") or "")
    return {"ok": True}


@route("GET", r"/api/stream/(\w+)")
def api_stream(h, m):
    mid = m[1]
    h.start_sse()
    g = generation.get(mid)
    if not g:
        msg = db.get_message(mid)
        if not msg:
            h.sse({"type": "error", "message": "Mensagem não encontrada."})
            return None
        h.sse({"type": "done", "message": msg})
        return None
    cursor = 0
    with g.cond:
        h.sse({"type": "snapshot", "content": g.content, "reasoning": g.reasoning})
        cursor = len(g.events)
        # events already folded into the snapshot are skipped, except markers — and the
        # live tool state of the current round (output so far, a pending approval)
        last_reset = max((i for i, ev in enumerate(g.events) if ev["type"] == "reset"), default=-1)
        for i, ev in enumerate(g.events):
            if ev["type"] in ("reasoning_done", "notice"):
                h.sse(ev)
            elif i > last_reset and ev["type"] in ("tool_start", "tool_output", "tool_result", "approval",
                                                   "approval_done", "steer"):
                h.sse(ev)
    while True:
        events, cursor, done = g.wait(cursor)
        if not events and not done:
            h.sse_comment()
            continue
        for ev in events:
            h.sse(ev)
        if done and any(e["type"] == "done" for e in events):
            return None
        if done and not events:
            return None


@route("GET", "/api/events")
def api_events(h, m):
    h.start_sse()
    cursor = generation.bus.cursor()
    h.sse({"type": "hello"})
    while True:
        events, cursor = generation.bus.wait(cursor)
        if not events:
            h.sse_comment()
        for ev in events:
            h.sse(ev)


# ---------------------------------------------------------------- attachments

@route("POST", "/api/attachments")
def api_upload(h, m):
    length = int(h.headers.get("Content-Length") or 0)
    if length > MAX_UPLOAD:
        raise HttpError(413, "Arquivo grande demais (máximo 25 MB).")
    name = urllib.parse.unquote(h.headers.get("X-Filename") or "arquivo")
    mime = (h.headers.get("Content-Type") or "application/octet-stream").split(";")[0].strip()
    data = h.rfile.read(length)
    if mime in ("", "application/octet-stream"):
        guessed = mimetypes.guess_type(name)[0]
        mime = guessed or "text/plain"
    if not (mime.startswith("image/") or mime == "application/pdf"):
        try:
            data.decode("utf-8")
        except UnicodeDecodeError:
            raise HttpError(415, f"“{name}” não é um arquivo de texto, imagem ou PDF.")
    return db.save_attachment(name, mime, data)


@route("GET", r"/api/attachments/(\w+)")
def api_attachment(h, m):
    row = db.get_attachment(m[1])
    if not row:
        raise HttpError(404, "Anexo não encontrado.")
    data = bytes(row["data"])
    h.send_response(200)
    h.send_header("Content-Type", row["mime"])
    h.send_header("Content-Length", str(len(data)))
    h.send_header("Cache-Control", "private, max-age=31536000, immutable")
    h._add_cors()
    h.end_headers()
    h.wfile.write(data)
    return None


# ---------------------------------------------------------------- agents (docs/referencias-agent.md)

def _agent_or_404(aid):
    agent = db.get_agent(aid)
    if not agent:
        raise HttpError(404, "Agente não encontrado.")
    return agent


def _agent_summary(agent):
    tasks = db.list_tasks(agent["id"])
    active = generation.active_conversations()
    # what waits on the user: parked approvals and tasks blocked on a question
    agent["blocked"] = sum(1 for t in tasks if t["status"] == "blocked")
    agent["pending"] = (len(db.pending_approvals(agent_id=agent["id"])) + agent["blocked"]
                        + len(coordination.pending_approvals(agent["id"])))
    agent["running"] = sum(1 for t in tasks if t["conversation_id"] in active) + (agent["conversation_id"] in active)
    agent["task_count"] = len(tasks)
    return agent


def _agent_fields(body, partial):
    """Validated agent fields from a request body."""
    out = {}
    if "name" in body or not partial:
        name = " ".join((body.get("name") or "").split())[:60]
        if not name:
            raise HttpError(400, "Dê um nome ao agente.")
        out["name"] = name
    if "instructions" in body:
        out["instructions"] = (body.get("instructions") or "").strip()[:8000]
    for k in ("model", "effort"):
        if k in body:
            out[k] = body[k] or None
    if "host_folder" in body:
        folder = (body.get("host_folder") or "").strip().strip('"')
        if folder and not (os.path.isabs(folder) and os.path.isdir(folder)):
            raise HttpError(400, "A pasta escolhida não existe.")
        out["host_folder"] = os.path.normpath(folder) if folder else None
    if "rules" in body:
        rules = body.get("rules") or {}
        if any(k not in agent_mode.ACTIONS or v not in agent_mode.DECISIONS for k, v in rules.items()):
            raise HttpError(400, "Regra inválida.")
        out["rules"] = rules
    if "research_hours" in body:
        hours = float(body.get("research_hours") or 0)
        if not 0 <= hours <= 168:
            raise HttpError(400, "O intervalo da pesquisa proativa vai de 0 a 168 horas.")
        out["research_hours"] = hours
    if "paused" in body:
        out["paused"] = bool(body["paused"])
    return out


def _agent_event(aid):
    generation.bus.publish({"type": "agent", "agent_id": aid})


@route("GET", "/api/agents")
def api_agents(h, m):
    return [_agent_summary(a) for a in db.list_agents()]


@route("POST", "/api/agents")
def api_agent_create(h, m):
    f = _agent_fields(h.json(), partial=False)
    agent = db.create_agent(f["name"], f.get("instructions", ""), f.get("model") or db.get_settings().get("default_model"),
                            f.get("effort"), f.get("host_folder"), f.get("rules") or {})
    if f.get("research_hours"):
        agent = db.update_agent(agent["id"], {"research_hours": f["research_hours"]})
        agent_mode.sync_research(agent)
    suggestions.refresh_agent(agent["id"])
    _agent_event(agent["id"])
    return _agent_summary(agent)


@route("GET", r"/api/agents/(\w+)")
def api_agent(h, m):
    agent = _agent_summary(_agent_or_404(m[1]))
    active = generation.active_conversations()
    tasks = db.list_tasks(agent["id"])
    for t in tasks:
        t["active"] = t["conversation_id"] in active
    approvals = []
    for a in db.pending_approvals(agent_id=agent["id"]):
        conv = db.get_conversation(a["conversation_id"]) or {}
        approvals.append({"id": a["id"], "conversation_id": a["conversation_id"], "message_id": a["message_id"],
                          "request": a["request"], "created_at": a["created_at"], "where": conv.get("title") or ""})
    approvals += coordination.pending_approvals(agent["id"])  # executors waiting on a card
    actions = [{"id": k, "label": label, "default": d} for k, (label, d) in agent_mode.ACTIONS.items()]
    return {"agent": agent, "tasks": tasks, "notes": db.list_notes(agent["id"]), "approvals": approvals,
            "activity": db.list_log(agent["id"], limit=40), "actions": actions, "rules": agent_mode.rules_of(agent),
            "issues": db.list_issues(agent["id"]), "calls": [_call_summary(c) for c in db.list_calls(agent["id"])]}


def _call_summary(c):
    return {k: c[k] for k in ("id", "task_id", "role", "runtime", "model", "label", "request", "conversation_id",
                              "message_id", "status", "verdict", "created_at", "finished_at")} | {
        "result": (c["result"] or "")[:600], "reviewed_current": None}


@route("PATCH", r"/api/issues/(\w+)")
def api_issue_update(h, m):
    """The user closing, discarding or reopening one of an agent's issues (coordination.py)."""
    issue = db.get_issue(m[1])
    if not issue:
        raise HttpError(404, "Questão não encontrada.")
    body = h.json()
    status = body.get("status")
    if status not in ("open", "resolved", "discarded"):
        raise HttpError(400, "Estado inválido.")
    resolution = (body.get("resolution") or "").strip()[:4000]
    if status != "open" and not resolution:
        raise HttpError(400, "Diga como a questão foi resolvida ou por que foi descartada.")
    issue = db.update_issue(m[1], {"status": status, "resolution": resolution or None,
                                   "closed_by": "você" if status != "open" else None})
    if issue["task_id"]:
        task = db.get_task(issue["task_id"])
        if task:
            agent_mode.log(task, "resumed" if status == "open" else "ran",
                           f"Você {'reabriu' if status == 'open' else 'fechou'} a questão “{issue['title']}”.")
    _agent_event(issue["agent_id"])
    return issue


@route("PATCH", r"/api/agents/(\w+)")
def api_agent_update(h, m):
    before = _agent_or_404(m[1])
    f = _agent_fields(h.json(), partial=True)
    agent = db.update_agent(m[1], f)
    if any(k in f and f[k] != before[k] for k in ("name", "instructions")) or not before["suggestions"]:
        suggestions.refresh_agent(m[1])
    if "name" in f:
        db.update_conversation(agent["conversation_id"], {"title": f["name"], "title_state": "manual"})
    if "model" in f or "effort" in f:
        db.update_conversation(agent["conversation_id"], {k: f[k] for k in ("model", "effort") if k in f})
    if "research_hours" in f:
        agent_mode.sync_research(agent)
    _agent_event(m[1])
    return _agent_summary(agent)


@route("DELETE", r"/api/agents/(\w+)")
def api_agent_delete(h, m):
    agent = _agent_or_404(m[1])
    convs = {agent["conversation_id"]} | {t["conversation_id"] for t in db.list_tasks(agent["id"])}
    for cid in convs & generation.active_conversations():
        g = generation.active_for(cid)
        if g:
            generation.stop(g.message_id)
    db.delete_agent(m[1])
    _agent_event(m[1])
    return {"ok": True}


@route("POST", r"/api/agents/(\w+)/notes")
def api_agent_note_create(h, m):
    _agent_or_404(m[1])
    content = " ".join((h.json().get("content") or "").split())[:2000]
    if not content:
        raise HttpError(400, "A nota está vazia.")
    note = db.create_note(m[1], content, "user")
    _agent_event(m[1])
    return note


@route("PATCH", r"/api/agent-notes/(\w+)")
def api_agent_note_update(h, m):
    content = " ".join((h.json().get("content") or "").split())[:2000]
    note = db.get_note(m[1])
    if not note:
        raise HttpError(404, "Nota não encontrada.")
    if not content:
        raise HttpError(400, "A nota está vazia.")
    note = db.update_note(m[1], content)
    _agent_event(note["agent_id"])
    return note


@route("DELETE", r"/api/agent-notes/(\w+)")
def api_agent_note_delete(h, m):
    note = db.get_note(m[1])
    if note:
        db.delete_note(m[1])
        _agent_event(note["agent_id"])
    return {"ok": True}


def _task_or_404(tid):
    task = db.get_task(tid)
    if not task:
        raise HttpError(404, "Tarefa não encontrada.")
    return task


def _schedule(body):
    try:
        return agent_mode.parse_schedule(body.get("schedule"))
    except (ValueError, TypeError, AttributeError) as e:
        raise HttpError(400, f"Agendamento inválido: {e}")


@route("POST", r"/api/agents/(\w+)/tasks")
def api_agent_task_create(h, m):
    agent = _agent_or_404(m[1])
    body = h.json()
    title = " ".join((body.get("title") or "").split())[:120]
    instructions = (body.get("instructions") or "").strip()
    if not title or not instructions:
        raise HttpError(400, "Informe o título e as instruções da tarefa.")
    return agent_mode.create_task(agent, title, instructions, _schedule(body), start_now=body.get("start_now", True) is not False)


@route("PATCH", r"/api/agent-tasks/(\w+)")
def api_agent_task_update(h, m):
    task = _task_or_404(m[1])
    body = h.json()
    patch = {}
    if "title" in body:
        patch["title"] = " ".join((body.get("title") or "").split())[:120] or task["title"]
        db.update_conversation(task["conversation_id"], {"title": patch["title"], "title_state": "manual"})
    if "instructions" in body and (body.get("instructions") or "").strip():
        patch["instructions"] = body["instructions"].strip()
    if "schedule" in body:
        patch["schedule"] = _schedule(body)
        if task["status"] != "paused":
            patch["next_run_at"] = agent_mode.next_run(patch["schedule"], time.time())
    if "paused" in body:
        if body["paused"]:
            patch.update(status="paused", next_run_at=None)
        elif task["status"] == "paused":
            sched = patch.get("schedule", task["schedule"])
            # a paused continuation picks up again shortly; a schedule, at its next slot
            cont = (task.get("outcome") or {}).get("state") == "continue"
            patch.update(status="idle", next_run_at=agent_mode.next_run(sched, time.time()) or
                         (time.time() + 60 if cont else None))
    if body.get("done") and task["status"] not in ("running", "waiting"):
        patch.update(status="done", next_run_at=None, outcome={"state": "done"})
        agent_mode.log(task, "done", "Marcada como concluída por você.")
    task = db.update_task(m[1], patch)
    _agent_event(task["agent_id"])
    return task


@route("POST", r"/api/agent-tasks/(\w+)/run")
def api_agent_task_run(h, m):
    task = _task_or_404(m[1])
    if task["status"] == "paused":
        db.update_task(task["id"], {"status": "idle"})
    if not agent_mode.run_task(db.get_task(task["id"]), "manual"):
        raise HttpError(409, "A tarefa já está rodando ou esperando uma aprovação.")
    if task["status"] in ("blocked", "done", "stopped", "error"):
        agent_mode.log(task, "resumed", "Retomada por você.")
    return db.get_task(task["id"])


@route("DELETE", r"/api/agent-tasks/(\w+)")
def api_agent_task_delete(h, m):
    task = _task_or_404(m[1])
    g = generation.active_for(task["conversation_id"])
    if g:
        generation.stop(g.message_id)
    db.delete_task(m[1])
    _agent_event(task["agent_id"])
    return {"ok": True}


@route("POST", r"/api/agent-approvals/(\w+)")
def api_agent_approval(h, m):
    body = h.json()
    appr = agent_mode.answer(m[1], body.get("decision"), (body.get("reason") or "")[:2000])
    if not appr:
        raise HttpError(409, "Esta aprovação não está mais pendente.")
    return {"ok": True, "conversation_id": appr["conversation_id"], "message_id": appr["message_id"]}


# ---------------------------------------------------------------- handler

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CEU"

    def log_message(self, fmt, *args):
        if os.environ.get("CEU_LOG"):
            sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))

    def query(self):
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)

    def json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise HttpError(400, "JSON inválido.")

    def _trusted_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return None
        if origin in Handler._TRUSTED_ORIGINS:
            return origin
        if urllib.parse.urlsplit(origin).netloc == self.headers.get("Host", ""):
            return origin
        return None

    def _add_cors(self):
        origin = self._trusted_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Expose-Headers", "Content-Disposition")
            self.send_header("Vary", "Origin")

    def send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self._add_cors()
        self.end_headers()
        self.wfile.write(data)

    def start_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self._add_cors()
        self.end_headers()
        self.close_connection = True

    def sse(self, obj):
        self.wfile.write(("data: " + json.dumps(obj, ensure_ascii=False) + "\n\n").encode("utf-8"))
        self.wfile.flush()

    def sse_comment(self):
        self.wfile.write(b": keepalive\n\n")
        self.wfile.flush()

    def _dispatch(self, method):
        path = urllib.parse.urlsplit(self.path).path
        if path.startswith("/api/"):
            if not self._same_origin():
                return self.send_json(403, {"error": "Origem não permitida."})
            for meth, rx, fn in ROUTES:
                if meth != method:
                    continue
                match = rx.match(path)
                if match:
                    try:
                        result = fn(self, match)
                        if result is not None:
                            self.send_json(200, result)
                    except HttpError as e:
                        self.send_json(e.status, {"error": e.message})
                    except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                        pass
                    except Exception as e:  # noqa: BLE001
                        import traceback
                        traceback.print_exc()
                        try:
                            self.send_json(500, {"error": f"Erro interno: {e}"})
                        except OSError:
                            pass
                    return
            return self.send_json(404, {"error": "Rota não encontrada."})
        if method != "GET":
            return self.send_json(405, {"error": "Método não permitido."})
        self._static(path)

    # Trusted origins besides same-origin: the Vite dev server and the Tauri
    # webview (whose origin never matches this process's own host:port).
    _TRUSTED_ORIGINS = {
        "http://localhost:5173",
        "http://localhost:5174",  # optional second Vite dev server
        "http://tauri.localhost",
        "tauri://localhost",
        "https://tauri.localhost",
    }

    def _same_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        if origin in self._TRUSTED_ORIGINS:
            return True
        host = self.headers.get("Host", "")
        return urllib.parse.urlsplit(origin).netloc == host

    def _static(self, path):
        rel = path.lstrip("/")
        if not rel or rel.startswith("c/") or rel == "c":
            rel = "index.html"
        full = os.path.normpath(os.path.join(WEB, rel))
        if not full.startswith(WEB) or not os.path.isfile(full):
            full = os.path.join(WEB, "index.html") if "." not in os.path.basename(rel) else None
        if not full:
            return self.send_json(404, {"error": "Arquivo não encontrado."})
        with open(full, "rb") as f:
            data = f.read()
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=86400" if "/vendor/" in full.replace("\\", "/") else "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PUT(self):
        self._dispatch("PUT")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")

    def do_OPTIONS(self):
        # CORS preflight for the Vite dev server / Tauri webview, which call
        # this same-machine server from a different origin.
        self.send_response(204)
        origin = self._trusted_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                self.headers.get("Access-Control-Request-Headers", "Content-Type, X-Filename"),
            )
            self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Content-Length", "0")
        self.end_headers()


# ---------------------------------------------------------------- bootstrap

LOCAL_PROBES = [
    ("http://127.0.0.1:8080/v1", "llama.cpp"),
    ("http://127.0.0.1:11434/v1", "Ollama"),
    ("http://127.0.0.1:1234/v1", "LM Studio"),
]


def _probe(url):
    try:
        with urllib.request.urlopen(url + "/models", timeout=1.5) as r:
            return r.status == 200
    except Exception:  # noqa: BLE001
        return False


def seed_providers():
    """First run only: connect providers found in the environment and on localhost."""
    if db.list_providers():
        return
    if os.environ.get("ANTHROPIC_API_KEY"):
        p = db.create_provider("anthropic", "anthropic", "Anthropic", providers.PRESETS["anthropic"]["base_url"],
                               os.environ["ANTHROPIC_API_KEY"])
        _refresh_models(p["id"])
    if os.environ.get("OPENAI_API_KEY"):
        p = db.create_provider("openai", "openai", "OpenAI", providers.PRESETS["openai"]["base_url"],
                               os.environ["OPENAI_API_KEY"])
        _refresh_models(p["id"])
    for url, name in LOCAL_PROBES:
        if _probe(url):
            p = db.create_provider("openai", "local", name, url, "")
            _refresh_models(p["id"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=int(os.environ.get("CEU_PORT", "4747")))
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    db.init()
    seed_providers()
    # Credentials come only from the app's own settings from here on; ambient SDK env vars
    # (e.g. a base URL meant for another tool) must not redirect requests.
    for var in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"):
        os.environ.pop(var, None)
    if not db.get_settings().get("default_model"):
        for p in db.list_providers():
            if p["models"]:
                db.update_settings({"default_model": f"{p['id']}::{p['models'][0]['id']}"})
                break

    def janitor():
        while True:
            time.sleep(30)
            try:
                db.purge_deleted(60)
            except Exception:  # noqa: BLE001
                pass
    threading.Thread(target=janitor, daemon=True).start()
    agent_mode.start_scheduler()
    integrations.on_change = lambda: generation.bus.publish({"type": "integrations"})
    integrations.on_connected = _integration_connected
    integrations.warm()

    class Server(ThreadingHTTPServer):
        def handle_error(self, request, client_address):
            # Browsers drop idle keep-alive and SSE connections all the time; that's not an error.
            if isinstance(sys.exc_info()[1], (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
                return
            super().handle_error(request, client_address)

    server = Server((args.host, args.port), Handler)
    server.daemon_threads = True
    print(f"CEU em http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
