"""Setup and login of the Code runtimes' external integrations: one lifecycle for all of them.

  unconfigured → setup_required → authenticating → connected
                        ↑________________ error ______↙   (any failed step; recoverable)

  unconfigured     what the integration needs is not on this computer (CLI, SDK package)
  setup_required   installed (or installing), but nobody is logged in / no credential chosen
  authenticating   a login started from CEU is in progress (browser, device code, console)
  connected        the official auth mechanism reports a usable session
  error            the last action or check failed; `error` says why, `actions` say how to retry

Each integration only implements its particulars (`locate`, `check_auth`, `login`, `logout`,
install steps) on top of the vendor's **official** mechanism; the state machine, the jobs
(installs, logins), caching and change notifications live here, once. CEU never reads, copies or
stores another tool's tokens: the CLIs/SDKs keep their own credential stores, and the only
secret CEU itself holds is the Anthropic API key the Claude SDK uses, which is the provider key
already in CEU's database (never sent to the client).
"""
import collections
import importlib
import importlib.metadata
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser

from . import code_tools, codex_bridge, db, providers

UNCONFIGURED, SETUP_REQUIRED, AUTHENTICATING, CONNECTED, ERROR = (
    "unconfigured", "setup_required", "authenticating", "connected", "error")

PROBE_TTL = 300        # seconds a status check stays fresh
LOGIN_TIMEOUT = 600    # a login nobody finishes is abandoned

# Hooks wired by main.py (avoids importing generation here).
on_change = lambda: None              # noqa: E731 - something in describe() changed
on_connected = lambda integ_id: None  # noqa: E731 - a login just succeeded


class Cancelled(Exception):
    pass


class SetupError(Exception):
    """A step failed in a way the user can act on; the message says how."""


# ---------------------------------------------------------------- helpers

HOME = os.path.expanduser("~")


def find_exe(names, extra=()):
    """First executable found on PATH (as names) or at one of the `extra` absolute paths.
    `extra` covers installers that put the binary on the *user* PATH, which this already
    running server process does not see until it restarts."""
    for n in names:
        p = shutil.which(n)
        if p:
            return p
    for p in extra:
        p = os.path.expandvars(p)
        if os.path.isfile(p):
            return p
    return None


_versions = {}


def exe_version(exe, args=("--version",)):
    try:
        key = (exe, os.path.getmtime(exe))
    except OSError:
        key = (exe, 0)
    if key not in _versions:
        try:
            r = subprocess.run([exe, *args], capture_output=True, timeout=20, creationflags=code_tools._NO_WINDOW,
                               stdin=subprocess.DEVNULL)
            out = (r.stdout or r.stderr).decode("utf-8", "replace").strip().splitlines()
            _versions[key] = out[0][:80] if out else None
        except (OSError, subprocess.SubprocessError):
            _versions[key] = None
    return _versions[key]


def run_quiet(argv, timeout=30, cwd=None, env=None, stdin_text=None):
    """(returncode, stdout, stderr) of a short, windowless command."""
    r = subprocess.run(argv, capture_output=True, timeout=timeout, cwd=cwd, env=env,
                       input=(stdin_text.encode("utf-8") if stdin_text is not None else None),
                       stdin=None if stdin_text is not None else subprocess.DEVNULL,
                       creationflags=code_tools._NO_WINDOW)
    return r.returncode, r.stdout.decode("utf-8", "replace"), r.stderr.decode("utf-8", "replace")


class Job:
    """A running install or login. What the client sees comes from `snapshot()`; secrets never
    go in here (a device code is not a secret: it is meant to be typed by the user)."""

    def __init__(self, kind, label):
        self.kind = kind            # install | login
        self.label = label
        self.message = ""
        self.url = None
        self.user_code = None
        self.log = collections.deque(maxlen=80)
        self.cancel = threading.Event()
        self.proc = None
        self.started = time.time()
        self._cleanup = []

    def on_cancel(self, fn):
        self._cleanup.append(fn)

    def stop(self):
        self.cancel.set()
        for fn in self._cleanup:
            try:
                fn()
            except Exception:  # noqa: BLE001
                pass
        if self.proc and self.proc.poll() is None:
            code_tools.kill_tree(self.proc)

    def say(self, message):
        self.message = message
        _changed()

    def check(self):
        if self.cancel.is_set():
            raise Cancelled()

    def snapshot(self):
        return {"kind": self.kind, "label": self.label, "message": self.message, "url": self.url,
                "user_code": self.user_code, "log": list(self.log)[-14:], "started": self.started}

    def run(self, argv, timeout=900, env=None):
        """Runs an install command windowless, streaming its output into the log."""
        self.log.append("> " + " ".join(argv))
        try:
            self.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                         encoding="utf-8", errors="replace", env=env, creationflags=code_tools._NO_WINDOW)
        except OSError as e:
            raise SetupError(f"Não foi possível executar {argv[0]}: {e}")
        deadline = time.time() + timeout
        last = 0
        for line in self.proc.stdout:
            line = line.rstrip()
            if line:
                self.log.append(line[:300])
                if time.time() - last > 1:
                    last = time.time()
                    _changed()
            if time.time() > deadline:
                code_tools.kill_tree(self.proc)
                raise SetupError("A instalação demorou demais e foi interrompida.")
        self.proc.wait()
        self.check()
        if self.proc.returncode:
            tail = "\n".join(list(self.log)[-6:])
            raise SetupError(f"O comando terminou com código {self.proc.returncode}.\n{tail}")

    def console(self, argv, cwd=None):
        """Opens `argv` in its own console window, for official logins that are interactive
        (the user answers the CLI there; CEU never sees what is typed)."""
        self.log.append("> " + " ".join(argv) + "  (em uma janela de terminal)")
        flags = subprocess.CREATE_NEW_CONSOLE if os.name == "nt" else 0
        try:
            self.proc = subprocess.Popen(argv, cwd=cwd or HOME, creationflags=flags)
        except OSError as e:
            raise SetupError(f"Não foi possível abrir {argv[0]}: {e}")
        return self.proc

    def wait_for(self, ok, interval=2.5, timeout=LOGIN_TIMEOUT, proc_must_live=False):
        """Polls `ok()` until it is true. Stops on cancel, timeout or (when `proc_must_live`) when
        the console process exits without `ok()` having turned true."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.check()
            if ok():
                return True
            if self.proc is not None and self.proc.poll() is not None:
                if ok():
                    return True
                if proc_must_live or self.proc.returncode:
                    raise SetupError("A janela de login foi fechada antes de concluir."
                                     + (f" (código {self.proc.returncode})" if self.proc.returncode else ""))
            self.cancel.wait(interval)
        raise SetupError("O login não foi concluído a tempo. Tente de novo.")


# ---------------------------------------------------------------- base class

class Integration:
    id = ""
    name = ""
    kind = "cli"           # sdk | cli
    vendor = ""
    runtime = None         # runtime id this integration enables (code_runtimes)
    group = None           # integrations sharing install + login (e.g. Codex SDK and Codex CLI)
    docs_url = ""
    auth_note = ""         # one line on how this tool authenticates, shown in the hub
    can_logout = True

    def __init__(self):
        self.group = self.group or self.id

    # -- particulars

    def locate(self):
        """{"path", "version", "requirements": [{"id", "label", "ok", "detail"}]}"""
        raise NotImplementedError

    def install_steps(self, loc):
        """Steps still missing, in order: [{"id", "label", "command", "run": fn(job)}]."""
        return []

    def check_auth(self, loc, deep=False):
        """{"ok": bool, "account": dict|None, "method": str|None, "detail": str}. `deep` also
        proves the session works (a network round trip), when the tool offers a way."""
        raise NotImplementedError

    def login_methods(self, loc):
        """[{"id", "label", "detail", "primary": bool, "fields": [...]}]"""
        return []

    def login(self, job, method, params):
        raise NotImplementedError

    def logout(self):
        raise SetupError("Esta integração não tem logout oficial pelo CEU.")


# ---------------------------------------------------------------- Codex (shared by SDK and CLI)

CODEX_EXTRA = (r"%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe", r"%APPDATA%\npm\codex.cmd")


class _Codex(Integration):
    group = "codex"
    vendor = "OpenAI"
    docs_url = "https://developers.openai.com/codex/auth"
    auth_note = ("Login oficial do Codex (app-server `account/login`): conta ChatGPT pelo navegador ou código de "
                 "dispositivo. As credenciais ficam no armazenamento do próprio Codex (~/.codex).")

    def locate(self):
        exe = codex_bridge.find_codex()
        return {"path": exe, "version": exe_version(exe) if exe else None, "requirements": [
            {"id": "codex", "label": "Codex CLI", "ok": bool(exe),
             "detail": exe or "Não encontrado. Instalação oficial: npm i -g @openai/codex"}]}

    def install_steps(self, loc):
        if loc["path"]:
            return []
        npm = find_exe(("npm.cmd", "npm"))
        return [{"id": "codex", "label": "Instalar o Codex CLI", "command": "npm install -g @openai/codex",
                 "blocked": None if npm else "Requer Node.js/npm (https://nodejs.org).",
                 "run": lambda job: job.run([npm, "install", "-g", "@openai/codex"])}]

    def check_auth(self, loc, deep=False):
        try:
            acc = codex_bridge.account_read(refresh=deep)
        except codex_bridge.CodexError as e:
            raise SetupError(f"O app-server do Codex não respondeu: {e}")
        if not acc:
            return {"ok": False, "account": None, "method": None, "detail": "Nenhuma conta conectada ao Codex."}
        method = {"chatgpt": "Conta ChatGPT", "apiKey": "Chave de API da OpenAI"}.get(acc["type"], acc["type"])
        return {"ok": True, "method": method, "detail": "",
                "account": {"email": acc.get("email"), "plan": acc.get("plan")}}

    def login_methods(self, loc):
        return [
            {"id": "chatgpt", "label": "Entrar com ChatGPT", "primary": True,
             "detail": "Abre o navegador no login oficial da OpenAI."},
            {"id": "device", "label": "Usar código de dispositivo",
             "detail": "Para quando o navegador não consegue voltar ao Codex: digite um código no site da OpenAI."},
            {"id": "api_key", "label": "Usar chave de API",
             "detail": "Cobrança pela API. A chave vai direto para o Codex, que a guarda; o CEU não a armazena.",
             "fields": [{"id": "api_key", "label": "Chave de API da OpenAI", "secret": True}]},
        ]

    def login(self, job, method, params):
        if method == "api_key":
            key = (params.get("api_key") or "").strip()
            if not key:
                raise SetupError("Cole a chave de API.")
            job.say("Enviando a chave ao Codex…")
            result, q = codex_bridge.login_start({"type": "apiKey", "apiKey": key})
            codex_bridge.unwatch_login(q)
            return
        req = {"type": "chatgptDeviceCode"} if method == "device" else {"type": "chatgpt"}
        result, q = codex_bridge.login_start(req)
        login_id = result.get("loginId")
        job.on_cancel(lambda: codex_bridge.cancel_login(login_id))
        try:
            if method == "device":
                job.url, job.user_code = result.get("verificationUrl"), result.get("userCode")
                job.say("Abra o endereço e digite o código para autorizar o Codex.")
            else:
                job.url = result.get("authUrl")
                job.say("Conclua o login no navegador que foi aberto.")
            if job.url:
                webbrowser.open(job.url)
            deadline = time.time() + LOGIN_TIMEOUT
            while time.time() < deadline:
                try:
                    if codex_bridge.wait_login_completed(q, login_id, job.cancel, timeout=5):
                        return
                except codex_bridge.CodexError as e:
                    job.check()
                    raise SetupError(str(e))
            raise SetupError("O login não foi concluído a tempo. Tente de novo.")
        finally:
            codex_bridge.unwatch_login(q)

    def logout(self):
        codex_bridge.logout()


class CodexSDK(_Codex):
    id = "codex_sdk"
    name = "Codex SDK"
    kind = "sdk"
    runtime = "codex_sdk"


class CodexCLI(_Codex):
    id = "codex_cli"
    name = "Codex CLI"
    runtime = "redir:codex"


# ---------------------------------------------------------------- Claude Code (CLI)

CLAUDE_EXTRA = (os.path.join(HOME, ".local", "bin", "claude.exe"),)
CLAUDE_INSTALL = "irm https://claude.ai/install.ps1 | iex"


def find_claude_native():
    """The native claude.exe (the official installer's); npm's claude.cmd shim as a last resort,
    which works for the CLI but is refused by the Agent SDK on Windows."""
    exe = find_exe(("claude.exe",), CLAUDE_EXTRA)
    return exe or shutil.which("claude")


def _claude_install_step(label):
    def run(job):
        ps = shutil.which("powershell") or "powershell"
        job.run([ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", CLAUDE_INSTALL])
    return {"id": "claude_code", "label": label, "command": CLAUDE_INSTALL, "run": run, "lock": "claude_code"}


def claude_auth_status(exe):
    """`claude auth status`: the CLI's official JSON report (exit 0 = logged in)."""
    try:
        code, out, err = run_quiet([exe, "auth", "status"], timeout=40)
    except (OSError, subprocess.SubprocessError) as e:
        raise SetupError(f"Não foi possível consultar o Claude Code: {e}")
    try:
        data = json.loads(out)
    except ValueError:
        raise SetupError(("`claude auth status` não respondeu em JSON: " + (err or out).strip()[:300]).strip())
    return data


class ClaudeCodeCLI(Integration):
    id = "claude_cli"
    name = "Claude Code CLI"
    vendor = "Anthropic"
    runtime = "redir:claude"
    docs_url = "https://code.claude.com/docs/en/authentication"
    auth_note = ("Login oficial do Claude Code (`claude auth login`), com assinatura Claude ou conta do Console. "
                 "As credenciais ficam com o próprio Claude Code.")

    def locate(self):
        exe = find_claude_native()
        return {"path": exe, "version": exe_version(exe) if exe else None, "requirements": [
            {"id": "claude_code", "label": "Claude Code", "ok": bool(exe),
             "detail": exe or f"Não encontrado. Instalador oficial (PowerShell): {CLAUDE_INSTALL}"}]}

    def install_steps(self, loc):
        return [] if loc["path"] else [_claude_install_step("Instalar o Claude Code (instalador oficial)")]

    def check_auth(self, loc, deep=False):
        data = claude_auth_status(loc["path"])
        method = data.get("authMethod") or "none"
        if not data.get("loggedIn"):
            return {"ok": False, "account": None, "method": None, "detail": "Nenhuma conta conectada ao Claude Code."}
        label = {"claude.ai": "Assinatura Claude", "api_key": "Chave de API", "oauth_token": "Token OAuth",
                 "api_key_helper": "apiKeyHelper", "third_party": "Provedor de nuvem"}.get(method, method)
        account = {k: data.get(k) for k in ("email", "orgName", "subscriptionType") if data.get(k)}
        return {"ok": True, "method": label, "detail": "", "account": account or None}

    def login_methods(self, loc):
        return [
            {"id": "claudeai", "label": "Entrar com conta Claude", "primary": True,
             "detail": "Abre `claude auth login` numa janela de terminal; o login segue no navegador."},
            {"id": "console", "label": "Entrar com o Console (API)",
             "detail": "`claude auth login --console`: cobrança pela API em vez da assinatura."},
        ]

    def login(self, job, method, params):
        argv = [self._exe(), "auth", "login"] + (["--console"] if method == "console" else [])
        job.console(argv)
        job.say("Siga as instruções na janela do Claude Code (ela abre o navegador).")
        exe = self._exe()
        job.wait_for(lambda: claude_auth_status(exe).get("loggedIn"), interval=3)

    def logout(self):
        code, out, err = run_quiet([self._exe(), "auth", "logout"], timeout=40)
        if code:
            raise SetupError((err or out).strip()[:300] or "O Claude Code não conseguiu sair.")

    def _exe(self):
        exe = find_claude_native()
        if not exe:
            raise SetupError("Claude Code não está instalado.")
        return exe


# ---------------------------------------------------------------- Claude SDK (Agent SDK)

def claude_sdk_cli():
    """The Claude Code binary the Agent SDK will run: the one bundled in its wheel, else a native
    claude.exe. (The SDK refuses npm's claude.cmd shim on Windows.)"""
    spec = importlib.util.find_spec("claude_agent_sdk")
    if spec and spec.origin:
        bundled = os.path.join(os.path.dirname(spec.origin), "_bundled", "claude.exe" if os.name == "nt" else "claude")
        if os.path.isfile(bundled):
            return bundled
    return find_exe(("claude.exe",) if os.name == "nt" else ("claude",), CLAUDE_EXTRA)


def claude_sdk_provider():
    """The Anthropic provider whose API key the Claude SDK uses (an explicit choice, see
    settings.claude_sdk_provider), with the key revealed — server side only."""
    pid = db.get_settings().get("claude_sdk_provider")
    p = db.get_provider(pid, reveal=True) if pid else None
    if not p or p["kind"] != "anthropic":
        return None
    return p


class ClaudeSDK(Integration):
    id = "claude_sdk"
    name = "Claude SDK"
    kind = "sdk"
    vendor = "Anthropic"
    runtime = "claude_sdk"
    docs_url = "https://code.claude.com/docs/en/agent-sdk/quickstart"
    auth_note = ("O Claude Agent SDK autentica por chave de API (ANTHROPIC_API_KEY). Login com conta claude.ai não é "
                 "permitido para apps de terceiros. A chave usada é a de um provedor Anthropic do CEU.")
    _validated = {}  # provider id + key hint -> time, so a probe doesn't hit the API every time

    def locate(self):
        spec = importlib.util.find_spec("claude_agent_sdk")
        version = None
        if spec:
            try:
                version = importlib.metadata.version("claude-agent-sdk")
            except importlib.metadata.PackageNotFoundError:
                pass
        cli = claude_sdk_cli()
        return {"path": cli if spec else None, "version": version, "requirements": [
            {"id": "package", "label": "Pacote claude-agent-sdk", "ok": bool(spec),
             "detail": f"versão {version}" if spec else "Não instalado no Python do CEU."},
            {"id": "claude_code", "label": "Executável do Claude Code", "ok": bool(cli),
             "detail": cli or "O pacote não trouxe o executável e não há claude.exe nativo instalado."},
        ]}

    def install_steps(self, loc):
        req = {r["id"]: r["ok"] for r in loc["requirements"]}
        steps = []
        if not req["package"]:
            steps.append({"id": "package", "label": "Instalar o claude-agent-sdk", "lock": "pip",
                          "command": "pip install claude-agent-sdk",
                          "run": lambda job: (job.run([sys.executable, "-m", "pip", "install", "--upgrade",
                                                       "claude-agent-sdk"]), importlib.invalidate_caches())})
        if not req["claude_code"]:
            steps.append(_claude_install_step("Instalar o Claude Code (instalador oficial)"))
        return steps

    def check_auth(self, loc, deep=False):
        p = claude_sdk_provider()
        if not p:
            return {"ok": False, "account": None, "method": None,
                    "detail": "Escolha a chave de API (provedor Anthropic) que o SDK vai usar."}
        if not p["enabled"]:
            return {"ok": False, "account": None, "method": None, "detail": f"O provedor “{p['name']}” está desativado."}
        if not p.get("api_key"):
            return {"ok": False, "account": None, "method": None, "detail": f"O provedor “{p['name']}” não tem chave de API."}
        key = (p["id"], p.get("key_hint") or p["api_key"][-4:])
        if deep or key not in self._validated:
            try:
                providers.list_anthropic_models(p)
            except providers.ProviderError as e:
                self._validated.pop(key, None)
                raise SetupError(f"A chave do provedor “{p['name']}” foi recusada: {e}")
            self._validated[key] = time.time()
        return {"ok": True, "method": "Chave de API", "detail": "",
                "account": {"provider": p["name"], "key_hint": p.get("key_hint") or ("…" + p["api_key"][-4:])}}

    def login_methods(self, loc):
        options = [{"id": p["id"], "label": f"{p['name']} {p.get('key_hint') or ''}".strip()}
                   for p in db.list_providers() if p["kind"] == "anthropic" and p.get("has_key")]
        return [{"id": "api_key", "label": "Usar chave de API", "primary": True,
                 "detail": "Use a chave de um provedor Anthropic já conectado, ou adicione uma.",
                 "fields": [{"id": "provider_id", "label": "Provedor Anthropic", "options": options}]}]

    def login(self, job, method, params):
        pid = params.get("provider_id")
        p = db.get_provider(pid, reveal=True) if pid else None
        if not p or p["kind"] != "anthropic":
            raise SetupError("Escolha um provedor Anthropic com chave de API.")
        job.say("Validando a chave com a API da Anthropic…")
        try:
            providers.list_anthropic_models(p)
        except providers.ProviderError as e:
            raise SetupError(f"A chave foi recusada: {e}")
        db.update_settings({"claude_sdk_provider": p["id"]})

    def logout(self):
        db.update_settings({"claude_sdk_provider": None})


# ---------------------------------------------------------------- Antigravity CLI

AGY_INSTALL_WINDOWS = "irm https://antigravity.google/cli/install.ps1 | iex"
AGY_INSTALL_UNIX = "curl -fsSL https://antigravity.google/cli/install.sh | bash"
AGY_EXTRA = (
    r"%LOCALAPPDATA%\agy\bin\agy.exe",
    r"%LOCALAPPDATA%\agy\bin\agy.cmd",
    os.path.join(HOME, ".local", "bin", "agy"),
    os.path.join(HOME, ".local", "bin", "agy.exe"),
)


def _antigravity_install_step():
    if os.name == "nt":
        ps = find_exe(("powershell.exe", "powershell")) or "powershell"
        return {"id": "agy", "label": "Instalar o Antigravity CLI", "command": AGY_INSTALL_WINDOWS,
                "run": lambda job: job.run([ps, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
                                              AGY_INSTALL_WINDOWS])}
    shell = find_exe(("bash", "sh")) or "sh"
    flag = "-lc" if os.path.basename(shell).lower().startswith("bash") else "-c"
    return {"id": "agy", "label": "Instalar o Antigravity CLI", "command": AGY_INSTALL_UNIX,
            "run": lambda job: job.run([shell, flag, AGY_INSTALL_UNIX])}


class AntigravityCLI(Integration):
    id = "antigravity_cli"
    name = "Antigravity CLI"
    vendor = "Google"
    runtime = "redir:agy"
    docs_url = "https://www.antigravity.google/docs/cli/install/"
    auth_note = ("O Antigravity CLI guarda a sessão no keyring seguro do sistema e faz o login oficial com a conta "
                 "Google. O CEU abre o próprio CLI numa janela; tokens e credenciais não passam pelo CEU.")
    can_logout = False  # /logout is an interactive slash command, not a headless CLI action

    def locate(self):
        exe = find_exe(("agy", "agy.exe", "agy.cmd"), AGY_EXTRA)
        install = AGY_INSTALL_WINDOWS if os.name == "nt" else AGY_INSTALL_UNIX
        return {"path": exe, "version": exe_version(exe) if exe else None, "requirements": [
            {"id": "agy", "label": "Antigravity CLI", "ok": bool(exe),
             "detail": exe or "Não encontrado. Instalação oficial: " + install}]}

    def install_steps(self, loc):
        return [] if loc["path"] else [_antigravity_install_step()]

    @staticmethod
    def _error_text(value):
        if isinstance(value, dict):
            return value.get("message") or value.get("error") or json.dumps(value, ensure_ascii=False)
        return str(value or "")

    def _probe_turn(self, exe):
        """Antigravity has no non-interactive auth-status command; its documented headless JSON
        run is the safe way to verify that the keyring session is usable."""
        with tempfile.TemporaryDirectory() as tmp:
            try:
                code, out, err = run_quiet(
                    [exe, "-p", "Responda apenas: ok", "--output-format", "json", "--print-timeout", "45s"],
                    timeout=75, cwd=tmp)
            except subprocess.TimeoutExpired:
                return False, "O Antigravity CLI não respondeu a tempo."
        data = None
        for line in reversed(out.splitlines()):
            try:
                candidate = json.loads(line)
            except ValueError:
                continue
            if isinstance(candidate, dict):
                data = candidate
                break
        if data and str(data.get("status") or "").upper() == "SUCCESS" and code == 0:
            return True, ""
        message = self._error_text((data or {}).get("error")) or (err or out).strip()[-400:]
        if not message:
            message = f"código {code}"
        lower = message.lower()
        if any(x in lower for x in ("authentication required", "not authenticated", "unauthenticated", "sign in",
                                    "login required", "credential", "keyring")):
            return False, "O Antigravity CLI ainda não tem um login."
        return False, "O Antigravity CLI recusou a chamada de teste: " + message

    def check_auth(self, loc, deep=False):
        if not loc.get("path"):
            return {"ok": False, "account": None, "method": None, "detail": "Antigravity CLI não está instalado."}
        ok, detail = self._probe_turn(loc["path"])
        return {"ok": ok, "account": None, "method": "Conta Google" if ok else None, "detail": detail}

    def login_methods(self, loc):
        return [{"id": "google", "label": "Entrar com Google", "primary": True,
                 "detail": "Abre o Antigravity CLI numa janela; conclua o login no navegador oficial."}]

    def login(self, job, method, params):
        job.console([self._exe()])
        job.say("Na janela do Antigravity CLI, conclua o login oficial no navegador.")
        try:
            job.wait_for(lambda: self.check_auth({"path": self._exe()})["ok"], interval=3, proc_must_live=True)
        finally:
            if job.proc and job.proc.poll() is None:  # the CLI stays open after login: CEU closes its window
                code_tools.kill_tree(job.proc)

    def _exe(self):
        exe = self.locate()["path"]
        if not exe:
            raise SetupError("Antigravity CLI não está instalado.")
        return exe


# ---------------------------------------------------------------- registry + lifecycle

ALL = [CodexSDK(), ClaudeSDK(), CodexCLI(), ClaudeCodeCLI(), AntigravityCLI()]
BY_ID = {i.id: i for i in ALL}

_lock = threading.RLock()
_cache = {}      # id -> {"at", "loc", "auth", "error"}
_jobs = {}       # group -> (integration id, Job)
_errors = {}     # group -> message of the last failed action (cleared by the next action/refresh)
_install_locks = collections.defaultdict(threading.Lock)


def _changed():
    try:
        on_change()
    except Exception:  # noqa: BLE001
        pass


def _probe(integ, deep=False):
    entry = {"at": time.time(), "loc": None, "auth": None, "error": None}
    try:
        entry["loc"] = integ.locate()
        if all(r["ok"] for r in entry["loc"]["requirements"]):
            entry["auth"] = integ.check_auth(entry["loc"], deep=deep)
    except SetupError as e:
        entry["error"] = str(e)
    except Exception as e:  # noqa: BLE001 - a broken probe must never break /api/state
        entry["error"] = f"Falha ao verificar: {e}"
    with _lock:
        _cache[integ.id] = entry
    return entry


def _probe_many(integs, deep=False):
    threads = [threading.Thread(target=_probe, args=(i, deep), daemon=True) for i in integs]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)


def _group(integ):
    return [i for i in ALL if i.group == integ.group]


def warm():
    """Background probe at startup, so the first /api/state is fast."""
    threading.Thread(target=lambda: (_probe_many(ALL), _changed()), daemon=True, name="integrations-warm").start()


def _entry(integ):
    with _lock:
        e = _cache.get(integ.id)
    if not e or time.time() - e["at"] > PROBE_TTL:
        e = _probe(integ)
    return e


def snapshot(integ, probe=True):
    """Return the integration snapshot, optionally without probing it.

    The normal UI path probes stale integrations. Agent prompts pass
    ``probe=False`` so a vendor CLI health check cannot block a model turn.
    """
    if probe:
        e = _entry(integ)
    else:
        with _lock:
            e = _cache.get(integ.id)
        if not e:
            return None
    with _lock:
        running = _jobs.get(integ.group)
        error = _errors.get(integ.group) or e["error"]
    loc, auth = e["loc"] or {"path": None, "version": None, "requirements": []}, e["auth"]
    installed = bool(loc["requirements"]) and all(r["ok"] for r in loc["requirements"])
    steps = integ.install_steps(loc) if loc["requirements"] else []
    job = running[1] if running else None
    if job:
        state = AUTHENTICATING if job.kind == "login" else SETUP_REQUIRED
    elif error:
        state = ERROR
    elif not installed:
        state = UNCONFIGURED
    elif auth and auth["ok"]:
        state = CONNECTED
    else:
        state = SETUP_REQUIRED

    if job:
        detail = job.message or job.label
    elif error:
        detail = error.splitlines()[0][:240]
    elif not installed:
        missing = [r["label"] for r in loc["requirements"] if not r["ok"]]
        detail = "Falta " + " e ".join(missing) + (" — o CEU pode instalar" if steps and not steps[0].get("blocked") else "")
    elif state == CONNECTED:
        acc = auth.get("account") or {}
        who = acc.get("email") or acc.get("provider") or acc.get("orgName")
        detail = " · ".join(x for x in (auth.get("method"), who, acc.get("plan") or acc.get("subscriptionType")) if x)
        if auth.get("detail"):
            detail += f" · {auth['detail']}" if detail else auth["detail"]
    else:
        detail = (auth or {}).get("detail") or "Falta fazer login."

    actions = []
    if job:
        actions = ["cancel"]
    else:
        if steps:
            actions.append("install")
        elif installed:
            actions += ["login"] if state != CONNECTED else ["validate", "relogin"] + (["logout"] if integ.can_logout else [])
        actions.append("refresh")
    return {
        "id": integ.id, "name": integ.name, "kind": integ.kind, "vendor": integ.vendor, "runtime": integ.runtime,
        "group": integ.group, "state": state, "detail": detail, "error": error,
        "installed": installed, "path": loc["path"], "version": loc["version"], "requirements": loc["requirements"],
        "install_steps": [{k: s.get(k) for k in ("id", "label", "command", "blocked")} for s in steps],
        "account": (auth or {}).get("account") if state == CONNECTED else None,
        "method": (auth or {}).get("method") if state == CONNECTED else None,
        "login_methods": integ.login_methods(loc) if installed else [],
        "auth_note": integ.auth_note, "docs_url": integ.docs_url, "can_logout": integ.can_logout,
        "job": job.snapshot() if job else None, "actions": actions, "checked_at": e["at"],
    }


def describe(refresh=False):
    if refresh:
        _probe_many(ALL)
    else:
        stale = [i for i in ALL if not _cache.get(i.id) or time.time() - _cache[i.id]["at"] > PROBE_TTL]
        if stale:
            _probe_many(stale)
    return [snapshot(i) for i in ALL]


def get(integ_id, refresh=False):
    integ = BY_ID.get(integ_id)
    if not integ:
        return None
    if refresh:
        with _lock:
            _errors.pop(integ.group, None)
        _probe_many(_group(integ))
    return snapshot(integ)


def cached(integ_id):
    """Return a cached snapshot without launching a probe, or ``None``."""
    integ = BY_ID.get(integ_id)
    return snapshot(integ, probe=False) if integ else None


def _start(integ, kind, label, work):
    with _lock:
        if integ.group in _jobs:
            raise SetupError("Já há uma instalação ou login em andamento para esta integração.")
        job = Job(kind, label)
        _jobs[integ.group] = (integ.id, job)
        _errors.pop(integ.group, None)

    def run():
        ok = False
        try:
            work(job)
            ok = True
        except Cancelled:
            pass
        except SetupError as e:
            if not job.cancel.is_set():
                with _lock:
                    _errors[integ.group] = str(e)
        except codex_bridge.CodexError as e:
            if not job.cancel.is_set():
                with _lock:
                    _errors[integ.group] = str(e)
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            with _lock:
                _errors[integ.group] = f"Erro inesperado: {e}"
        finally:
            with _lock:
                _jobs.pop(integ.group, None)
            _probe_many(_group(integ))
            if ok and kind == "login":
                with _lock:
                    connected = (_cache.get(integ.id) or {}).get("auth") or {}
                if connected.get("ok"):
                    try:
                        on_connected(integ.id)
                    except Exception:  # noqa: BLE001
                        pass
                else:
                    with _lock:
                        _errors.setdefault(integ.group, "O login terminou, mas a sessão não foi confirmada. Tente Verificar.")
            _changed()

    threading.Thread(target=run, daemon=True, name=f"integration-{integ.id}-{kind}").start()
    _changed()
    return snapshot(integ)


def install(integ_id):
    integ = BY_ID[integ_id]
    loc = integ.locate()
    steps = integ.install_steps(loc)
    if not steps:
        return get(integ_id, refresh=True)
    blocked = next((s["blocked"] for s in steps if s.get("blocked")), None)
    if blocked:
        raise SetupError(blocked)

    def work(job):
        for step in steps:
            job.check()
            job.say(step["label"] + "…")
            lock = _install_locks[step.get("lock") or step["id"]]
            if not lock.acquire(blocking=False):
                raise SetupError(f"“{step['label']}” já está em andamento em outra integração. Aguarde e verifique de novo.")
            try:
                step["run"](job)
            finally:
                lock.release()
        importlib.invalidate_caches()
        job.say("Instalado. Verificando…")

    return _start(integ, "install", steps[0]["label"], work)


def login(integ_id, method, params):
    integ = BY_ID[integ_id]
    loc = integ.locate()
    if not all(r["ok"] for r in loc["requirements"]):
        raise SetupError(f"{integ.name} ainda não está instalado.")
    methods = {m["id"]: m for m in integ.login_methods(loc)}
    if method not in methods:
        method = next((m["id"] for m in methods.values() if m.get("primary")), None) or next(iter(methods), None)
    if not method:
        raise SetupError("Nenhum método de login disponível.")
    return _start(integ, "login", methods[method]["label"], lambda job: integ.login(job, method, params or {}))


def cancel(integ_id):
    integ = BY_ID[integ_id]
    with _lock:
        running = _jobs.get(integ.group)
    if running:
        running[1].stop()
    return snapshot(integ)


def logout(integ_id):
    integ = BY_ID[integ_id]
    try:
        integ.logout()
    except codex_bridge.CodexError as e:
        raise SetupError(str(e))
    with _lock:
        _errors.pop(integ.group, None)
    _probe_many(_group(integ))
    _changed()
    return snapshot(integ)


def validate(integ_id):
    integ = BY_ID[integ_id]
    with _lock:
        _errors.pop(integ.group, None)
    entry = _probe(integ, deep=True)
    if entry["error"]:
        with _lock:
            _errors[integ.group] = entry["error"]
    others = [i for i in _group(integ) if i is not integ]
    if others:
        _probe_many(others)
    _changed()
    return snapshot(integ)


def report_failure(integ_id, message):
    """A runtime hit an auth failure mid-turn: show it in the hub until the next check."""
    integ = BY_ID.get(integ_id)
    if not integ:
        return
    with _lock:
        _errors[integ.group] = message
    _changed()
