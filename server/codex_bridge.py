"""Bridge to the Codex CLI's `app-server` (JSON-RPC over stdio), reused instead of
reimplementing OpenAI's OAuth flow. Login (`account/login/start` with type "chatgpt")
is handled entirely inside the app-server: it builds the authorize URL, runs the local
callback listener, exchanges the code, and persists/refreshes tokens under
`~/.codex/auth.json` on its own. This module never reads that file or holds a
client_id/token — CEU only ever sees `authUrl` (to open in the browser),
`account/login/completed` (success/failure), and `account/read` (email/plan).

Wire format: newline-delimited JSON, `{"id"|"method", ...}`, no outer "jsonrpc" echoed
back by the server. Confirmed by hand against `codex app-server` (see chat history).
"""
import itertools
import json
import queue
import shutil
import subprocess
import threading
import time
import webbrowser

from .version import VERSION


class CodexError(Exception):
    pass


APPROVAL_METHODS = ("item/commandExecution/requestApproval", "item/fileChange/requestApproval")


def find_codex():
    exe = shutil.which("codex") or shutil.which("codex.exe")
    if exe:
        return exe
    import os
    candidates = [
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


class CodexBridge:
    def __init__(self, exe):
        self.exe = exe
        self._id_seq = itertools.count(1)
        self._pending = {}  # id -> queue.Queue(maxsize=1)
        self._pending_lock = threading.Lock()
        self._thread_subs = {}  # threadId -> queue.Queue
        self._approval_threads = set()  # threads whose approval requests go to their subscriber (Codex SDK)
        self._subs_lock = threading.Lock()
        self._account_subs = []  # list of queue.Queue
        self._closed = False
        self.proc = subprocess.Popen(
            [self.exe, "app-server"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1, encoding="utf-8", errors="replace",
        )
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name="codex-bridge-reader")
        self._reader.start()
        self.request("initialize", {"clientInfo": {"name": "CEU", "version": VERSION},
                                    "capabilities": {"experimentalApi": True}}, timeout=15)

    # ------------------------------------------------------------ transport

    def alive(self):
        return not self._closed and self.proc.poll() is None

    def close(self):
        self._closed = True
        try:
            self.proc.terminate()
        except Exception:  # noqa: BLE001
            pass

    def request(self, method, params, timeout=60):
        if not self.alive():
            raise CodexError("O app-server do Codex não está em execução.")
        req_id = next(self._id_seq)
        q = queue.Queue(maxsize=1)
        with self._pending_lock:
            self._pending[req_id] = q
        line = json.dumps({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params}) + "\n"
        try:
            self.proc.stdin.write(line)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as e:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise CodexError(f"Falha ao falar com o Codex: {e}")
        try:
            kind, payload = q.get(timeout=timeout)
        except queue.Empty:
            with self._pending_lock:
                self._pending.pop(req_id, None)
            raise CodexError(f"O Codex não respondeu a tempo ({method}).")
        if kind == "error":
            raise CodexError(payload.get("message") or "Erro do Codex.")
        return payload

    def subscribe_thread(self, thread_id, approvals=False):
        """`approvals`: the subscriber answers this thread's approval requests itself (a code
        session under the Codex SDK runtime); otherwise they are refused (chat-only sessions)."""
        q = queue.Queue()
        with self._subs_lock:
            self._thread_subs[thread_id] = q
            if approvals:
                self._approval_threads.add(thread_id)
        return q

    def unsubscribe_thread(self, thread_id):
        with self._subs_lock:
            self._thread_subs.pop(thread_id, None)
            self._approval_threads.discard(thread_id)

    def subscribe_account(self):
        q = queue.Queue()
        with self._subs_lock:
            self._account_subs.append(q)
        return q

    def unsubscribe_account(self, q):
        with self._subs_lock:
            if q in self._account_subs:
                self._account_subs.remove(q)

    # ------------------------------------------------------------ reader

    def _read_loop(self):
        try:
            for line in self.proc.stdout:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                self._handle(obj)
        except Exception:  # noqa: BLE001
            pass
        finally:
            self._closed = True
            with self._pending_lock:
                for q in self._pending.values():
                    try:
                        q.put_nowait(("error", {"message": "Conexão com o Codex encerrada."}))
                    except queue.Full:
                        pass
                self._pending.clear()

    def _handle(self, obj):
        method = obj.get("method")
        has_id = "id" in obj
        if method is None and has_id:
            # response to a request we sent
            with self._pending_lock:
                q = self._pending.pop(obj["id"], None)
            if q:
                if "error" in obj:
                    q.put(("error", obj["error"]))
                else:
                    q.put(("result", obj.get("result")))
            return
        if method is not None and has_id:
            if method == "item/tool/call":
                # dynamic tool call: executed by the turn loop (run_turn), which owns the
                # conversation context; the reader thread must never block on a tool.
                thread_id = (obj.get("params") or {}).get("threadId")
                with self._subs_lock:
                    q = self._thread_subs.get(thread_id)
                if q:
                    q.put((method, {**obj["params"], "_reqId": obj["id"]}))
                else:
                    self._send_error(obj["id"], "Turno não encontrado.")
                return
            if method in APPROVAL_METHODS:
                thread_id = (obj.get("params") or {}).get("threadId")
                with self._subs_lock:
                    q = self._thread_subs.get(thread_id) if thread_id in self._approval_threads else None
                if q:  # answered by the turn loop, which may wait for the user
                    q.put((method, {**obj["params"], "_reqId": obj["id"]}))
                    return
            # any other request FROM the server: always reply so it never blocks on us.
            self._respond_to_server_request(obj)
            return
        # notification
        params = obj.get("params") or {}
        thread_id = params.get("threadId")
        if thread_id:
            with self._subs_lock:
                q = self._thread_subs.get(thread_id)
            if q:
                q.put((method, params))
        if method in ("account/login/completed", "account/updated"):
            with self._subs_lock:
                subs = list(self._account_subs)
            for q in subs:
                q.put((method, params))

    def _respond_to_server_request(self, obj):
        method = obj["method"]
        req_id = obj["id"]
        if method == "currentTime/read":
            result = {"isoTime": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
        elif method in ("item/commandExecution/requestApproval", "item/fileChange/requestApproval",
                       "applyPatchApproval", "execCommandApproval"):
            result = {"decision": {"denied": {"rejection": "Sessão somente-chat: execução desativada."}}}
        else:
            self._send_error(req_id, "Método não suportado neste cliente.")
            return
        self._send_result(req_id, result)

    def _send_result(self, req_id, result):
        try:
            self.proc.stdin.write(json.dumps({"id": req_id, "result": result}) + "\n")
            self.proc.stdin.flush()
        except OSError:
            pass

    def _send_error(self, req_id, message):
        try:
            self.proc.stdin.write(json.dumps({"id": req_id, "error": {"code": -32000, "message": message}}) + "\n")
            self.proc.stdin.flush()
        except OSError:
            pass


_bridge = None
_bridge_lock = threading.Lock()


def get_bridge():
    global _bridge
    with _bridge_lock:
        if _bridge is None or not _bridge.alive():
            exe = find_codex()
            if not exe:
                raise CodexError(
                    "Codex CLI não encontrado. Instale em https://developers.openai.com/codex/cli e faça "
                    "login (menu do provedor ChatGPT/Codex).")
            _bridge = CodexBridge(exe)
        return _bridge


# ---------------------------------------------------------------- account / login
#
# Everything here is the app-server's official account API (`account/*`); credentials stay in
# Codex's own store. CEU only relays the authorize URL / device code and reads email + plan.

def account_read(refresh=False):
    """{"type": "chatgpt"|"apiKey"|..., "email", "plan"} or None when nobody is logged in.
    `refresh` asks Codex to refresh its token first, which also proves the session still works."""
    result = get_bridge().request("account/read", {"refreshToken": bool(refresh)}, timeout=30 if refresh else 15)
    account = result.get("account")
    if not account:
        return None
    return {"type": account.get("type"), "email": account.get("email"), "plan": account.get("planType")}


def account_status():
    account = account_read()
    if account and account.get("type") == "chatgpt":
        return {"connected": True, "email": account.get("email"), "plan": account.get("plan")}
    return {"connected": False, "email": None, "plan": None}


def login_start(params):
    """Starts an `account/login/start` (type "chatgpt" = browser OAuth, "chatgptDeviceCode", or
    "apiKey"). Subscribes to account notifications *before* the request so a fast completion is
    never missed. Returns (result, queue); the caller unsubscribes the queue (`unwatch_login`)."""
    b = get_bridge()
    q = b.subscribe_account()
    try:
        result = b.request("account/login/start", params, timeout=20)
    except CodexError:
        b.unsubscribe_account(q)
        raise
    return result, q


def start_login():
    """Browser login for the ChatGPT provider card (legacy routes): opens the authorize URL."""
    result, q = login_start({"type": "chatgpt"})
    if result.get("type") != "chatgpt":
        unwatch_login(q)
        raise CodexError("Resposta de login inesperada do Codex.")
    webbrowser.open(result["authUrl"])
    return result["loginId"], q


def unwatch_login(q):
    b = get_bridge()
    b.unsubscribe_account(q)


def cancel_login(login_id):
    b = get_bridge()
    try:
        b.request("account/login/cancel", {"loginId": login_id}, timeout=10)
    except CodexError:
        pass


def logout():
    get_bridge().request("account/logout", {}, timeout=20)


def wait_login_completed(q, login_id, cancel_event, timeout=25):
    """Blocks (checking `cancel_event`) until account/login/completed fires for `login_id`.
    True on success, None on timeout; raises CodexError on failure or cancellation. Does NOT
    unsubscribe `q`, so callers may poll repeatedly."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cancel_event.is_set():
            raise CodexError("Login cancelado.")
        try:
            method, params = q.get(timeout=1.0)
        except queue.Empty:
            continue
        if method == "account/login/completed" and params.get("loginId") in (login_id, None):
            if not params.get("success", False):
                raise CodexError(params.get("error") or "Login cancelado ou recusado.")
            return True
    return None


def wait_login(q, login_id, cancel_event, timeout=25):
    """Legacy provider route: like wait_login_completed, returning the account on success."""
    return account_status() if wait_login_completed(q, login_id, cancel_event, timeout) else None


# ---------------------------------------------------------------- models / chat

def list_models():
    b = get_bridge()
    result = b.request("model/list", {}, timeout=20)
    out = []
    for m in result.get("data", []):
        if m.get("hidden"):
            continue
        entry = {"id": m["id"], "name": m.get("displayName") or m["id"]}
        levels = [e["reasoningEffort"] for e in m.get("supportedReasoningEfforts") or []]
        if levels:
            entry["effortLevels"] = levels
            entry["defaultEffort"] = m.get("defaultReasoningEffort") or levels[0]
        out.append(entry)
    return out


def _dynamic_tools(tools=None):
    # Codex's own shell/patch tools stay blocked (read-only sandbox); file creation and code
    # execution go through CEU's tools instead (chat: WSL2 sandbox + per-conversation
    # workspace; code sessions: the project folder, with CEU's approval flow).
    from . import agent_tools
    return [{"type": "function", "name": t["name"], "description": t["description"],
             "inputSchema": t["input_schema"]} for t in (agent_tools.enabled_tools() if tools is None else tools)]


def _run_dynamic_tool(b, params, conversation_id):
    """Executes one item/tool/call, answers the server, returns the list of changed files."""
    from . import agent_tools
    res = agent_tools.execute(params.get("tool"), params.get("arguments") or {}, conversation_id)
    b._send_result(params["_reqId"], {
        "contentItems": [{"type": "inputText", "text": res["output"][:8000]}],
        "success": not res["is_error"],
    })
    return res["files"]


def run_turn(system, transcript_text, model, cancel, effort=None, conversation_id=None, tools=None, tool_executor=None):
    """Runs one ephemeral turn (Codex's own shell is read-only/no-approval; CEU's tools are
    offered as dynamic tools when `conversation_id` is given) and yields normalized events:
    {"type": "reasoning"|"text"|"notice", "text": str} then a final dict with usage.
    Raises CodexError on failure."""
    b = get_bridge()
    start_params = {
        "ephemeral": True,
        "sandbox": "read-only",
        "approvalPolicy": "never",
        "model": model,
        "developerInstructions": system or None,
    }
    if conversation_id:
        start_params["dynamicTools"] = _dynamic_tools(tools)
    thread = b.request("thread/start", start_params, timeout=30)
    thread_id = thread["thread"]["id"]
    q = b.subscribe_thread(thread_id)
    try:
        turn_params = {
            "threadId": thread_id,
            "input": [{"type": "text", "text": transcript_text}],
        }
        if effort:
            turn_params["reasoningEffort"] = effort
        turn = b.request("turn/start", turn_params, timeout=30)
        turn_id = turn["turn"]["id"]
        cancel.on_cancel(lambda: _interrupt(b, thread_id, turn_id))
        usage = None
        deadline = time.time() + 600
        while time.time() < deadline:
            if cancel.is_set():
                return
            try:
                method, params = q.get(timeout=1.0)
            except queue.Empty:
                continue
            if method == "item/agentMessage/delta":
                yield {"type": "text", "text": params.get("delta") or ""}
            elif method in ("item/reasoning/summaryTextDelta", "item/reasoning/textDelta"):
                yield {"type": "reasoning", "text": params.get("delta") or ""}
            elif method == "item/tool/call":
                if not conversation_id:
                    b._send_error(params["_reqId"], "Ferramentas indisponíveis.")
                    continue
                if tool_executor:
                    # Runs (and may wait for the user's approval) inside the generation thread.
                    res = tool_executor(params.get("tool"), params.get("arguments") or {})
                    b._send_result(params["_reqId"], {
                        "contentItems": [{"type": "inputText", "text": res["output"][:30000]}],
                        "success": not res["is_error"],
                    })
                    deadline = time.time() + 600  # waiting on the user doesn't count against the turn
                    continue
                yield {"type": "notice", "text": f"Executando ferramenta “{params.get('tool')}”…"}
                files = _run_dynamic_tool(b, params, conversation_id)
                if files:
                    yield {"type": "notice", "text": f"Arquivo(s) atualizados: {', '.join(files)}."}
            elif method == "thread/tokenUsage/updated":
                u = (params.get("tokenUsage") or {}).get("total") or {}
                usage = {"input": u.get("inputTokens"), "output": u.get("outputTokens")}
            elif method == "turn/completed":
                turn_obj = params.get("turn") or {}
                if turn_obj.get("error"):
                    raise CodexError(str(turn_obj["error"]))
                yield {"type": "final", "usage": usage}
                return
        raise CodexError("A resposta do Codex demorou demais.")
    finally:
        b.unsubscribe_thread(thread_id)


def _interrupt(bridge, thread_id, turn_id):
    try:
        bridge.request("turn/interrupt", {"threadId": thread_id, "turnId": turn_id}, timeout=10)
    except CodexError:
        pass
