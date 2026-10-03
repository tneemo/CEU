"""CEU REDIR: a code-session turn delegated to an external, complete agent CLI (Codex CLI,
Claude Code, Antigravity CLI), supervised by CEU.

REDIR is an execution layer, not a provider. The external agent brings its own harness —
system prompt, tools, sandbox, auth and session store — and CEU only supervises it: starts
the process in the project folder, hands it the user's message, streams its events into the
same text/rounds a CEU turn produces, keeps the external session id so the next turn resumes
it, cancels it (process tree) and records the result.

Each CLI is a Driver: how to find the executable, which CEU permission modes it can honour
without interactive approvals, how to build the command for a turn, and how to read its
output. The supervisor (`run_turn`) is shared. Installing the CLI and logging into it is
the integration's job (integrations.py), named by `Driver.integration`.
"""
import collections
import json
import os
import re
import shutil
import subprocess
import threading
import time

from . import code_tools, integrations, providers


class RedirError(providers.ProviderError):
    pass


class Driver:
    id = ""
    name = ""
    exe_names = ()
    implemented = False
    # CEU permission modes the CLI honours without asking per action (REDIR has no approval channel).
    modes = ()
    default_mode = None
    mode_notes = {}
    # Provider kinds whose model ids the CLI accepts; any other selection runs the CLI's default model.
    model_kinds = ()
    # Not implemented yet: the intended path, for whoever writes the driver.
    pending = ""
    # integrations.py entry that installs the CLI and logs into it (None: plain PATH lookup)
    integration = None
    # exit codes the CLI documents as "not authenticated": the hub is told to ask for a login
    auth_exit_codes = ()
    _catalog = None
    _catalog_at = 0

    def find(self):
        if self.integration:
            return integrations.BY_ID[self.integration].locate()["path"]
        for n in self.exe_names:
            p = shutil.which(n)
            if p:
                return p
        return None

    def command(self, exe, session, mode, model, effort):
        """argv for one turn; the prompt goes to stdin. `session` is the id to resume (or None)."""
        raise NotImplementedError

    def prompt(self, text, mode):
        return text

    def parse(self, obj):
        """One line of the CLI's JSON stream -> list of actions:
        ("session", id) · ("text"|"reasoning"|"notice", str) · ("delta", str) (a piece of the
        current text, no paragraph break) · ("tool_start", call) · ("tool_end", call, result)
        (only call["id"] matters when its start was seen) · ("model", id) · ("usage", dict) · ("done",) ·
        ("response", str) (terminal response fallback) · ("error", str) (the turn failed; keep reading) ·
        ("fatal", str) (stop the CLI now, e.g. an auth failure it would otherwise retry for minutes)"""
        raise NotImplementedError


    def discover(self, exe):
        return [], []

    def catalog(self):
        exe = self.find()
        if not exe:
            return {"models": [], "efforts": []}
        if self._catalog is None or time.monotonic() - self._catalog_at > 300:
            try:
                models, efforts = self.discover(exe)
                self._catalog = {"models": models, "efforts": efforts}
            except Exception:  # discovery is advisory; older or offline CLIs still run in Auto
                self._catalog = {"models": [], "efforts": []}
            self._catalog_at = time.monotonic()
        return self._catalog


def _quiet(argv):
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                          timeout=12, creationflags=code_tools._NO_WINDOW)


def _json_catalog(output):
    """Normalize a CLI's machine-readable model list, when it offers one."""
    try:
        data = json.loads(output)
    except ValueError:
        return []
    rows = data if isinstance(data, list) else data.get("models", data.get("data", []))
    if not isinstance(rows, list):
        return []
    return ([{"id": m, "name": m} for m in rows if isinstance(m, str)] +
            [{"id": m.get("id") or m.get("name"),
              "name": m.get("displayName") or m.get("display_name") or m.get("name") or m.get("id")}
             for m in rows if isinstance(m, dict) and (m.get("id") or m.get("name"))])


def _help_efforts(exe):
    help_text = _quiet([exe, "--help"]).stdout
    match = re.search(r"--effort\s+<[^>]+>(.*?)(?=\n\s*--|\n\s*-[a-z]|\nCommands:|\Z)", help_text, re.I | re.S)
    choices = re.search(r"\((\w+(?:,\s*\w+)+)\)", match.group(1)) if match else None
    return [v.strip() for v in choices.group(1).split(",")] if choices else []


# ---------------------------------------------------------------- Codex CLI

class CodexCLI(Driver):
    """`codex exec --json` (verified against codex-cli 0.157.1). Codex's own sandbox enforces
    the mode: Plano = read-only, Automático = workspace-write (writes only inside the folder,
    no network). `codex exec` never asks, so Manual/Aceitar edições are not offered."""
    id = "codex"
    name = "Codex CLI"
    implemented = True
    integration = "codex_cli"
    modes = ("plan", "auto")
    default_mode = "auto"
    mode_notes = {
        "plan": "Sandbox somente leitura do Codex; termina com um plano",
        "auto": "Sandbox do Codex: escreve só na pasta, sem rede, sem perguntar",
    }
    model_kinds = ("codex",)
    SANDBOX = {"plan": "read-only", "auto": "workspace-write"}

    def discover(self, exe):
        from . import codex_bridge
        return codex_bridge.list_models(), []

    def command(self, exe, session, mode, model, effort):
        argv = [exe, "exec"] + (["resume"] if session else []) + [
            "--json", "--skip-git-repo-check", "-c", f'sandbox_mode="{self.SANDBOX.get(mode, "read-only")}"']
        if model:
            argv += ["-m", model]
        if effort:
            argv += ["-c", f'model_reasoning_effort="{effort}"']
        if session:
            argv.append(session)
        return argv + ["-"]

    # Codex wraps each command in its shell: `"...\pwsh.exe" -Command '<cmd>'` (or `bash -lc '<cmd>'`).
    _WRAPPED = re.compile(r"""^"?[^"]*?(?:pwsh|powershell|bash|sh)(?:\.exe)?"?\s+(?:-NoProfile\s+)?(?:-Command|-lc|-c)\s+'(.*)'$""", re.S)

    def _inner(self, command):
        m = self._WRAPPED.match(command.strip())
        return m.group(1).replace("''", "'") if m else command

    def prompt(self, text, mode):
        if mode == "plan":
            return ("[CEU · modo Plano] Não altere nada: só investigue e termine com um plano concreto e numerado "
                    "(arquivos a mudar, o que muda em cada um, como verificar).\n\n" + text)
        return text

    def parse(self, obj):
        t = obj.get("type")
        if t == "thread.started":
            return [("session", obj.get("thread_id"))] + ([("model", obj["model"])] if obj.get("model") else [])
        if t == "turn.started" and obj.get("model"):
            return [("model", obj["model"])]
        if t == "turn.completed":
            u = obj.get("usage") or {}
            return [("usage", {"input": u.get("input_tokens"), "output": u.get("output_tokens")}), ("done",)]
        if t == "turn.failed":
            return [("error", ((obj.get("error") or {}).get("message")) or "O Codex encerrou o turno com erro.")]
        if t == "error":
            return [("notice", obj.get("message") or "Erro do Codex.")]
        if t not in ("item.started", "item.completed"):
            return []
        item = obj.get("item") or {}
        kind, done = item.get("type"), t == "item.completed"
        if kind == "agent_message" and done:
            return [("text", item.get("text") or "")]
        if kind == "reasoning" and done:
            return [("reasoning", (item.get("text") or "") + "\n\n")]
        if kind == "command_execution":
            call = {"id": item["id"], "name": "run_command", "input": {"command": self._inner(item.get("command") or "")}}
            if not done:
                return [("tool_start", call)]
            code = item.get("exit_code")
            out = (item.get("aggregated_output") or "").replace("\r\n", "\n").rstrip()
            return [("tool_end", call, {"output": out, "is_error": item.get("status") == "failed" or bool(code),
                                        "meta": {"exit_code": code, "output": out}})]
        if kind == "file_change" and done:
            failed = item.get("status") == "failed"
            out = []
            for i, ch in enumerate(item.get("changes") or []):
                name = {"add": "write_file", "delete": "delete_file"}.get(ch.get("kind"), "edit_file")
                call = {"id": f"{item['id']}_{i}", "name": name, "input": {"path": ch.get("path") or ""}}
                out += [("tool_start", call), ("tool_end", call, {
                    "output": f"{ch.get('kind')}: {ch.get('path')}", "is_error": failed,
                    "meta": {"path": ch.get("path"), "created": ch.get("kind") == "add"}})]
            return out
        if kind == "web_search":
            call = {"id": item["id"], "name": "web_search", "input": {"query": item.get("query") or ""}}
            return [("tool_start", call)] if not done else [("tool_end", call, {"output": "", "is_error": False, "meta": {}})]
        if kind == "mcp_tool_call":
            call = {"id": item["id"], "name": f"{item.get('server')}.{item.get('tool')}", "input": item.get("arguments") or {}}
            if not done:
                return [("tool_start", call)]
            return [("tool_end", call, {"output": json.dumps(item.get("result") or item.get("error") or "", ensure_ascii=False)[:8000],
                                        "is_error": item.get("status") == "failed", "meta": {}})]
        if kind == "error" and done:
            return [("notice", item.get("message") or "Erro do Codex.")]
        return []


# ---------------------------------------------------------------- Claude Code CLI

def _text_of(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text") or "" for c in content if isinstance(c, dict) and c.get("type") == "text")
    return json.dumps(content, ensure_ascii=False) if content is not None else ""


def claude_tool_call(tool_id, name, a):
    """A Claude Code tool use as a CEU call, so it renders like CEU's own tools. Shared with
    the Claude SDK runtime (claude_sdk.py)."""
    a = a or {}
    if name in ("Bash", "PowerShell"):
        return {"id": tool_id, "name": "run_command",
                "input": {"command": a.get("command") or "", "description": a.get("description") or ""}}
    simple = {"Read": "read_file", "Edit": "edit_file", "MultiEdit": "edit_file", "Write": "write_file",
              "NotebookEdit": "edit_file"}
    if name in simple:
        inp = {"path": a.get("file_path") or a.get("notebook_path") or ""}
        if a.get("offset"):
            inp["offset"] = a["offset"]
        return {"id": tool_id, "name": simple[name], "input": inp}
    if name in ("Glob", "Grep"):
        return {"id": tool_id, "name": name.lower(), "input": {"pattern": a.get("pattern") or ""}}
    if name == "WebSearch":
        return {"id": tool_id, "name": "web_search", "input": {"query": a.get("query") or ""}}
    if name == "WebFetch":
        return {"id": tool_id, "name": "fetch_url", "input": {"url": a.get("url") or ""}}
    return {"id": tool_id, "name": name, "input": a}


def claude_result(content, is_error):
    text = _text_of(content).replace("\r\n", "\n")[:30000]
    return {"output": text, "is_error": bool(is_error), "meta": {"output": text}}


CLAUDE_AUTH_FAILURE = "O Claude Code recusou a autenticação. Entre de novo em Configurações → Runtimes e agentes."


class ClaudeCodeCLI(Driver):
    """`claude -p --output-format stream-json --verbose` (format checked against Claude Code
    2.1.281: system/init, assistant/user messages with tool_use/tool_result blocks, result).
    There is no approval channel, so only the modes the CLI runs without asking are offered:
    Plano = its plan mode; Automático = bypassPermissions (no sandbox on native Windows)."""
    id = "claude"
    name = "Claude Code CLI"
    implemented = True
    integration = "claude_cli"
    modes = ("plan", "auto")
    default_mode = "plan"
    mode_notes = {
        "plan": "Modo plano do Claude Code: só lê e termina com um plano",
        "auto": "bypassPermissions: edita e roda comandos sem perguntar e sem sandbox",
    }
    model_kinds = ("anthropic",)
    PERMISSION = {"plan": "plan", "auto": "bypassPermissions"}

    def discover(self, exe):
        # Claude Code currently advertises --model, but no machine-readable list command.
        return [], _help_efforts(exe)

    def command(self, exe, session, mode, model, effort):
        argv = [exe, "-p", "--output-format", "stream-json", "--verbose",
                "--permission-mode", self.PERMISSION.get(mode, "plan")]
        if session:
            argv += ["--resume", session]
        if model:
            argv += ["--model", model]
        if effort:
            argv += ["--effort", effort]
        return argv

    def parse(self, obj):
        t = obj.get("type")
        if t == "system":
            if obj.get("subtype") == "init":
                return [("session", obj.get("session_id")), ("model", obj.get("model"))]
            if obj.get("subtype") == "api_retry" and obj.get("error") == "authentication_failed":
                return [("fatal", CLAUDE_AUTH_FAILURE)]
            return []
        if t == "assistant":
            out = []
            if not obj.get("parent_tool_use_id") and (obj.get("message") or {}).get("model"):
                out.append(("model", obj["message"]["model"]))
            for b in (obj.get("message") or {}).get("content") or []:
                if b.get("type") == "text" and b.get("text"):
                    out.append(("text", b["text"]))
                elif b.get("type") == "thinking" and b.get("thinking"):
                    out.append(("reasoning", b["thinking"] + "\n\n"))
                elif b.get("type") == "tool_use":
                    out.append(("tool_start", claude_tool_call(b.get("id"), b.get("name"), b.get("input"))))
            return out
        if t == "user":
            content = (obj.get("message") or {}).get("content")
            return [("tool_end", {"id": b.get("tool_use_id"), "name": "tool", "input": {}},
                     claude_result(b.get("content"), b.get("is_error")))
                    for b in (content if isinstance(content, list) else []) if b.get("type") == "tool_result"]
        if t == "result":
            u = obj.get("usage") or {}
            acts = [("usage", {"input": u.get("input_tokens"), "output": u.get("output_tokens")})]
            if obj.get("is_error"):
                return acts + [("error", obj.get("result") or obj.get("subtype") or "O Claude Code encerrou com erro.")]
            return acts + [("done",)]
        return []


# ---------------------------------------------------------------- Antigravity CLI

AGY_AUTH_FAILURE = "O Antigravity CLI não está autenticado. Entre de novo em Configurações → Runtimes e agentes."


class AntigravityCLI(Driver):
    """Antigravity CLI headless mode, `--input-format stream-json --output-format stream-json`.

    The CLI accepts a user event on stdin and emits init/step_update/result NDJSON events. A
    result carries the conversation id used by `--conversation` on the next turn. Tool steps
    contain both the canonical tool name and the tool result, so the supervisor can expose them
    in the same rounds as the other REDIR drivers.
    """
    id = "agy"
    name = "Antigravity CLI"
    implemented = True
    integration = "antigravity_cli"
    modes = ("plan", "auto")
    default_mode = "plan"
    mode_notes = {
        "plan": "Instrução de plano do CEU: investiga sem alterar arquivos",
        "auto": "--dangerously-skip-permissions: edita e executa sem perguntar",
    }
    # Antigravity owns its model catalogue; CEU does not invent a provider/model mapping for it.
    model_kinds = ()
    def discover(self, exe):
        result = _quiet([exe, "models"])
        if result.returncode:
            return [], []
        models = _json_catalog(result.stdout) if result.stdout.lstrip().startswith(("[", "{")) else []
        if not models:
            for line in result.stdout.splitlines():
                match = re.match(r"^\s*[-*]?\s*([\w][\w.:-]+)(?:(?:\s{2,}|\s+[-–:]\s+)(.+))?\s*$", line)
                if match and match.group(1).lower() not in ("model", "models", "id"):
                    models.append({"id": match.group(1), "name": match.group(2) or match.group(1)})
        return models, []
    TOOLS = {
        "run_command": "run_command", "run_shell_command": "run_command",
        "read_file": "read_file", "write_to_file": "write_file", "write_file": "write_file",
        "replace": "edit_file", "edit": "edit_file", "edit_file": "edit_file",
        "list_directory": "list_dir", "list_dir": "list_dir", "glob": "glob",
        "search_file_content": "grep", "grep": "grep",
        "google_web_search": "web_search", "web_search": "web_search",
        "web_fetch": "fetch_url", "fetch_url": "fetch_url",
    }

    @staticmethod
    def _value(values, *keys):
        return next((values[k] for k in keys if values.get(k) is not None), "")

    @staticmethod
    def _text(value):
        if isinstance(value, str):
            return value.replace("\r\n", "\n")
        if value is None:
            return ""
        return json.dumps(value, ensure_ascii=False)

    @classmethod
    def _usage(cls, usage):
        if not isinstance(usage, dict):
            return None
        input_tokens = usage.get("input_tokens")
        output_tokens = usage.get("output_tokens")
        if input_tokens is None and output_tokens is None:
            return None
        result = {"input": input_tokens, "output": output_tokens}
        if usage.get("thinking_tokens") is not None:
            result["thinking"] = usage["thinking_tokens"]
        if usage.get("cache_read_tokens") is not None:
            result["cache_read"] = usage["cache_read_tokens"]
        return result

    @classmethod
    def _tool_call(cls, step):
        info = step.get("tool_info") or {}
        params = info.get("parameters") or {}
        if not isinstance(params, dict):
            params = {}
        raw_name = info.get("name") or step.get("tool_name") or "tool"
        name = cls.TOOLS.get(raw_name, raw_name)
        if name == "run_command":
            inp = {"command": cls._value(params, "CommandLine", "command", "cmd"),
                   "description": cls._value(params, "Description", "description")}
        elif name in ("read_file", "write_file", "edit_file", "list_dir"):
            inp = {"path": cls._value(params, "FilePath", "file_path", "absolute_path", "DirectoryPath",
                                        "dir_path", "path")}
            if name == "edit_file":
                inp["old_string"] = cls._value(params, "OldString", "old_string", "oldText")
                inp["new_string"] = cls._value(params, "NewString", "new_string", "newText")
        elif name in ("glob", "grep"):
            inp = {"pattern": cls._value(params, "Pattern", "pattern", "query")}
        elif name == "web_search":
            inp = {"query": cls._value(params, "Query", "query", "search_query")}
        elif name == "fetch_url":
            inp = {"url": cls._value(params, "Url", "URL", "url", "uri", "prompt")}
        else:
            inp = params
        return {"id": f"agy_{step.get('step_index', 'tool')}", "name": name, "input": inp}

    @classmethod
    def _tool_result(cls, step):
        info = step.get("tool_info") or {}
        error = info.get("error")
        output = info.get("output")
        if output is None and error:
            output = error.get("message") if isinstance(error, dict) else error
        text = cls._text(output)[:30000]
        return {"output": text, "is_error": bool(error), "meta": {"output": text}}

    @staticmethod
    def _auth_error(message):
        lower = str(message or "").lower()
        return any(x in lower for x in ("authentication required", "not authenticated", "unauthenticated",
                                        "sign in", "login required", "credential", "keyring"))

    def command(self, exe, session, mode, model, effort):
        argv = [exe, "--input-format", "stream-json", "--output-format", "stream-json"]
        if session:
            argv += ["--conversation", session]
        if mode == "auto":
            argv.append("--dangerously-skip-permissions")
        if model:
            argv += ["--model", model]
        return argv

    def prompt(self, text, mode):
        if mode == "plan":
            text = ("[CEU · modo Plano] Não altere nada: só investigue e termine com um plano concreto e numerado "
                    "(arquivos a mudar, o que muda em cada um, como verificar).\n\n" + text)
        return json.dumps({"event": "user", "message": {"content": text}}, ensure_ascii=False) + "\n"

    def parse(self, obj):
        event = obj.get("event")
        if event == "init":
            init = obj.get("init") or {}
            sid = obj.get("conversation_id") or init.get("conversation_id")
            return ([("session", sid)] if sid else []) + ([("model", init["model"])] if init.get("model") else [])
        if event == "step_update":
            step = obj.get("step_update") or {}
            actions = []
            if step.get("step_type") == "agent_response" and step.get("text_delta"):
                actions.append(("delta", step["text_delta"]))
            usage = self._usage(step.get("usage"))
            if usage:
                actions.append(("usage", usage))
            if step.get("step_type") == "tool" or step.get("tool_info") or step.get("subagent_info"):
                call = self._tool_call(step)
                if step.get("state") == "ACTIVE":
                    actions.append(("tool_start", call))
                else:
                    actions.append(("tool_end", call, self._tool_result(step)))
            return actions
        if event == "result":
            result = obj.get("result") or {}
            actions = []
            if result.get("model"):
                actions.append(("model", result["model"]))
            sid = result.get("conversation_id") or obj.get("conversation_id")
            if sid:
                actions.append(("session", sid))
            usage = self._usage(result.get("usage"))
            if usage:
                actions.append(("usage", usage))
            status = str(result.get("status") or "").upper()
            if status == "SUCCESS":
                # The stream normally delivered response fragments in step_update. This is a
                # fallback for CLI versions that only populate the terminal envelope.
                if result.get("response"):
                    actions.append(("response", result["response"]))
                actions.append(("done",))
            else:
                message = result.get("error") or status or "O Antigravity CLI encerrou o turno com erro."
                if self._auth_error(message):
                    actions.append(("fatal", AGY_AUTH_FAILURE))
                else:
                    actions.append(("error", message))
            return actions
        return []


DRIVERS = {d.id: d for d in (CodexCLI(), ClaudeCodeCLI(), AntigravityCLI())}


# ---------------------------------------------------------------- supervisor

def _relative(root, call, result=None):
    """External agents report absolute paths; inside the project they read better relative."""
    for d in (call.get("input") or {}, (result or {}).get("meta") or {}):
        p = d.get("path")
        if p and os.path.isabs(p):
            try:
                rel = os.path.relpath(p, root)
            except ValueError:  # another drive
                continue
            if not rel.startswith(".."):
                d["path"] = rel.replace(os.sep, "/")


def run_turn(driver, root, text, session, mode, model, effort, cancel, on_tool_start, on_tool_end, on_session):
    """Runs one turn of `driver` in `root` and yields the normalized provider events
    (reasoning/text/notice, then final). Tool activity goes to the callbacks, which the
    generation turns into rounds; `on_session(id)` stores the external session id."""
    exe = driver.find()
    if not exe:
        raise RedirError(f"{driver.name} não está instalado. Configure em Configurações → Runtimes e agentes.")
    proc = subprocess.Popen(
        driver.command(exe, session, mode, model, effort), cwd=root,
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        encoding="utf-8", errors="replace", creationflags=code_tools._NO_WINDOW)
    err_tail = collections.deque(maxlen=40)
    threading.Thread(target=lambda: err_tail.extend(proc.stderr), daemon=True).start()
    cancel.on_cancel(lambda: code_tools.kill_tree(proc))
    started = {}  # call id -> call, for tool_end without a matching start
    usage, finished, failure, wrote_text, saw_text = None, False, None, False, False
    actual_model = None
    try:
        try:
            proc.stdin.write(driver.prompt(text, mode))
            proc.stdin.close()
        except OSError:
            pass
        for line in proc.stdout:
            if cancel.is_set():
                return
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            for act in driver.parse(obj):
                k = act[0]
                if k == "session":
                    on_session(act[1])
                elif k == "model" and act[1]:
                    actual_model = act[1]
                    yield {"type": "model_used", "model": actual_model}
                elif k == "fatal":
                    if driver.integration:
                        integrations.report_failure(driver.integration, act[1])
                    raise RedirError(f"{driver.name}: {act[1]}")
                elif k == "delta":
                    if act[1]:
                        wrote_text = True
                        saw_text = True
                        yield {"type": "text", "text": act[1]}
                elif k == "response":
                    # `result.response` repeats the stream fragments on current versions. Use it
                    # only when a CLI version emitted a terminal envelope without fragments.
                    if act[1] and not saw_text:
                        wrote_text = True
                        saw_text = True
                        yield {"type": "text", "text": act[1]}
                elif k in ("text", "reasoning", "notice"):
                    if k == "text":
                        if not act[1]:
                            continue
                        if wrote_text:  # consecutive agent messages read as paragraphs
                            yield {"type": "text", "text": "\n\n"}
                        wrote_text = True
                        saw_text = True
                    yield {"type": k, "text": act[1]}
                elif k == "tool_start":
                    _relative(root, act[1])
                    started[act[1]["id"]] = act[1]
                    wrote_text = False
                    on_tool_start(act[1])
                elif k == "tool_end":
                    call = started.pop(act[1]["id"], None)
                    if call is None:  # no start seen: open and close the round at once
                        call = act[1]
                        _relative(root, call)
                        on_tool_start(call)
                    _relative(root, call, act[2])
                    on_tool_end(call, act[2])
                elif k == "usage":
                    usage = act[1]
                elif k == "done":
                    finished = True
                elif k == "error":
                    failure = act[1]
        proc.wait()
        if cancel.is_set():
            return
        if failure:
            raise RedirError(f"{driver.name}: {failure}")
        if not finished and proc.returncode in driver.auth_exit_codes:
            msg = f"{driver.name} não está autenticado. Entre em Configurações → Runtimes e agentes."
            if driver.integration:
                integrations.report_failure(driver.integration, msg)
            raise RedirError(msg)
        if not finished:
            tail = "".join(err_tail).strip()[-1500:]
            raise RedirError(f"{driver.name} terminou sem concluir o turno (código {proc.returncode})."
                             + (f"\n{tail}" if tail else ""))
        yield {"type": "final", "raw_blocks": {"redir": {"requested_model": model, "actual_model": actual_model,
                         "requested_effort": effort}}, "usage": usage, "stop_reason": "stop", "model": actual_model or model,
               "tool_calls": []}
    finally:
        if proc.poll() is None:
            code_tools.kill_tree(proc)
