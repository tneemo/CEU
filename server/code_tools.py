"""Tools for code sessions: the model works directly in a project folder on the
host (Windows). Every path is confined to the session's project folder; shell
commands run in PowerShell with the folder as working directory.

Unlike `agent_tools` (chat mode), nothing here is sandboxed — that is why
generation.py asks the user before edits and commands, depending on the
session's permission mode (see `needs_approval`).
"""
import difflib
import fnmatch
import os
import re
import shutil
import subprocess
import threading
import time

from . import db, git_tools

IGNORED_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", "target", "dist", "build", ".next",
                ".mypy_cache", ".pytest_cache", ".idea", ".vs"}
MAX_READ_LINES = 2000
MAX_OUTPUT = 30_000       # characters of command output kept for the model and the UI
MAX_MATCHES = 200
READ_ONLY = {"read_file", "list_dir", "glob", "grep"} | git_tools.READ_ONLY
EDITS = {"edit_file", "write_file"}

TOOLS = [
    {
        "name": "read_file",
        "description": "Lê um arquivo de texto do projeto. A saída traz o número de cada linha (`  12→texto`). "
                       "Para arquivos grandes, use offset (linha inicial, 1 = primeira) e limit.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Caminho relativo à pasta do projeto."},
                "offset": {"type": "integer", "minimum": 1},
                "limit": {"type": "integer", "minimum": 1},
            },
            "required": ["path"],
        },
    },
    {
        "name": "list_dir",
        "description": "Lista arquivos e pastas de um diretório do projeto (não recursivo; pastas terminam com /).",
        "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
    },
    {
        "name": "glob",
        "description": "Encontra arquivos do projeto por padrão glob (ex.: `src/**/*.ts`, `**/test_*.py`). "
                       "Ignora o que o .gitignore ignora e pastas como node_modules.",
        "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}}, "required": ["pattern"]},
    },
    {
        "name": "grep",
        "description": "Busca uma expressão regular no conteúdo dos arquivos do projeto e devolve `arquivo:linha: texto`. "
                       "Use `glob` para restringir os arquivos (ex.: `*.py`) e `path` para uma subpasta.",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern": {"type": "string"},
                "path": {"type": "string"},
                "glob": {"type": "string"},
                "ignore_case": {"type": "boolean"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "edit_file",
        "description": "Edita um arquivo trocando um trecho exato (old_string) por outro (new_string). Leia o arquivo antes. "
                       "old_string precisa aparecer exatamente uma vez (inclua linhas de contexto para torná-lo único), "
                       "a menos que replace_all seja true. Preserve a indentação exata.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
                "replace_all": {"type": "boolean"},
            },
            "required": ["path", "old_string", "new_string"],
        },
    },
    {
        "name": "write_file",
        "description": "Cria um arquivo ou substitui todo o conteúdo de um arquivo existente. "
                       "Para mudar partes de um arquivo existente, prefira edit_file.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "content": {"type": "string"}},
            "required": ["path", "content"],
        },
    },
    {
        "name": "run_command",
                "description": "Executa um comando no PowerShell (Windows) com a pasta do projeto como diretório de trabalho e "
                               "devolve a saída (stdout e stderr juntos) e o código de saída. Use para testes, builds, "
                       "instalar dependências etc. Não use para ler, buscar ou editar arquivos: há ferramentas próprias. "
                       "Comandos interativos não funcionam (não há entrada). `description` é uma frase curta, no "
                       "passado ou infinitivo, dizendo o objetivo (ex.: \"Rodar os testes do parser\").",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string"},
                "description": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 600},
            },
            "required": ["command", "description"],
        },
    },
]

# Git/GitHub are harness tools and share this permission/approval path with the
# other native Code tools. The same schemas are exposed, host-prefixed, to agents.
TOOLS.extend(git_tools.TOOLS)
_GIT_TOOL_NAMES = {tool["name"] for tool in git_tools.TOOLS}


class Ctx:
    """What a tool call needs from the running generation."""

    def __init__(self, root, turn_id, cancel=None, on_output=None):
        self.root = os.path.normpath(root)
        self.turn_id = turn_id
        self.cancel = cancel
        self.on_output = on_output or (lambda text: None)


def tools_for(mode):
    """Plan mode explores only: no edit tools are offered at all."""
    if mode == "plan":
        return [t for t in TOOLS if t["name"] not in EDITS and
                (t["name"] not in _GIT_TOOL_NAMES or t["name"] in git_tools.READ_ONLY)]
    return TOOLS


# ---------------------------------------------------------------- approval policy

def command_prefix(command):
    """The part of a command an 'always allow' rule keys on: the first two words of
    the first pipeline stage (`git status`, `npm run`, `pytest -q` → `pytest -q`)."""
    first = re.split(r"[|;&]", command.strip(), 1)[0].strip()
    words = first.split()
    return " ".join(words[:2]) if words else ""


def rule_for(name, args):
    """(tool, pattern) an 'always allow' answer records for this call."""
    if name in _GIT_TOOL_NAMES:
        kind = git_tools.approval_class(name)
        return kind, kind or ""
    if name in EDITS:
        return "edit", ""
    return "run_command", command_prefix(args.get("command") or "")


def needs_approval(name, args, mode, rules):
    """None when the call can run right away; otherwise the reason to ask."""
    if name in READ_ONLY:
        return None
    if mode == "auto":
        return None
    if name in _GIT_TOOL_NAMES:
        if name in git_tools.READ_ONLY:
            return None
        kind = git_tools.approval_class(name) or "unknown"
        if any(r["tool"] == kind and r["pattern"] == kind for r in rules):
            return None
        return kind
    if name in EDITS:
        if mode == "accept_edits" or any(r["tool"] == "edit" for r in rules):
            return None
        return "edit"
    if name == "run_command":
        cmd = (args.get("command") or "").strip()
        # A rule matches on the first pipeline stage only, so `git status; rm -rf x`
        # never rides on a "git status" rule.
        if not re.search(r"[|;&`\n]|\$\(", cmd):
            for r in rules:
                if r["tool"] == "run_command" and r["pattern"] and (cmd == r["pattern"] or cmd.startswith(r["pattern"] + " ")):
                    return None
        return "command"
    return "unknown"


# ---------------------------------------------------------------- execution

def execute(name, args, ctx):
    """Returns {"output": str, "is_error": bool, "files": [], "meta": dict}."""
    try:
        if name in _GIT_TOOL_NAMES:
            return git_tools.execute(name, args, ctx)
        fn = {
            "read_file": _read_file, "list_dir": _list_dir, "glob": _glob, "grep": _grep,
            "edit_file": _edit_file, "write_file": _write_file, "run_command": _run_command,
        }.get(name)
        if not fn:
            return _err(f"Ferramenta desconhecida: {name}")
        return fn(args, ctx)
    except ToolError as e:
        return _err(str(e))
    except Exception as e:  # noqa: BLE001 - a failing tool must come back as a result, never kill the turn
        return _err(f"Erro ao executar “{name}”: {e}")


class ToolError(Exception):
    pass


def _ok(output, **meta):
    return {"output": output, "is_error": False, "files": [], "meta": meta}


def _err(output, **meta):
    return {"output": output, "is_error": True, "files": [], "meta": meta}


def resolve(ctx, rel):
    rel = (rel or "").strip().strip('"')
    full = os.path.normpath(rel if os.path.isabs(rel) else os.path.join(ctx.root, rel))
    if os.path.normcase(full) != os.path.normcase(ctx.root) and not os.path.normcase(full).startswith(os.path.normcase(ctx.root) + os.sep):
        raise ToolError(f"“{rel}” está fora da pasta do projeto ({ctx.root}).")
    return full


def relpath(ctx, full):
    return os.path.relpath(full, ctx.root).replace(os.sep, "/")


def read_text(full):
    with open(full, "rb") as f:
        data = f.read()
    if b"\0" in data[:8000]:
        raise ToolError(f"“{os.path.basename(full)}” é um arquivo binário ({len(data)} bytes).")
    try:
        return data.decode("utf-8"), data
    except UnicodeDecodeError:
        return data.decode("latin-1"), data


def _read_file(args, ctx):
    full = resolve(ctx, args.get("path"))
    if os.path.isdir(full):
        raise ToolError(f"“{args.get('path')}” é uma pasta. Use list_dir.")
    if not os.path.isfile(full):
        raise ToolError(f"Arquivo “{args.get('path')}” não encontrado.")
    text, _ = read_text(full)
    lines = text.splitlines()
    start = max(int(args.get("offset") or 1), 1)
    limit = min(int(args.get("limit") or MAX_READ_LINES), MAX_READ_LINES)
    chunk = lines[start - 1:start - 1 + limit]
    out = "\n".join(f"{i:>6}→{line[:2000]}" for i, line in enumerate(chunk, start))
    rest = len(lines) - (start - 1 + len(chunk))
    if rest > 0:
        out += f"\n… (mais {rest} linhas; use offset={start + len(chunk)})"
    if not lines:
        out = "(arquivo vazio)"
    return _ok(out, path=relpath(ctx, full), lines=len(chunk), total=len(lines))


def _list_dir(args, ctx):
    full = resolve(ctx, args.get("path") or ".")
    if not os.path.isdir(full):
        raise ToolError(f"Pasta “{args.get('path')}” não encontrada.")
    entries = sorted(os.scandir(full), key=lambda e: (not e.is_dir(), e.name.lower()))
    out = [e.name + ("/" if e.is_dir() else "") for e in entries]
    return _ok("\n".join(out) or "(pasta vazia)", path=relpath(ctx, full), count=len(out))


def project_files(root):
    """Relative paths ('/'-separated) of the project's files, honouring .gitignore when it's a git repo."""
    if os.path.isdir(os.path.join(root, ".git")) and shutil.which("git"):
        try:
            r = subprocess.run(["git", "ls-files", "-co", "--exclude-standard", "-z"], cwd=root, capture_output=True,
                               timeout=20, creationflags=_NO_WINDOW)
            if r.returncode == 0:
                return [p for p in r.stdout.decode("utf-8", "replace").split("\0") if p]
        except (OSError, subprocess.SubprocessError):
            pass
    out = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in IGNORED_DIRS]
        for f in files:
            out.append(os.path.relpath(os.path.join(dirpath, f), root).replace(os.sep, "/"))
        if len(out) > 50_000:
            break
    return out


def _glob_match(path, pattern):
    # fnmatch's * already crosses '/', so '**/' only needs to also match zero directories.
    pattern = pattern.replace("\\", "/").lstrip("./")
    if fnmatch.fnmatch(path, pattern):
        return True
    if pattern.startswith("**/") and fnmatch.fnmatch(path, pattern[3:]):
        return True
    return "/" not in pattern and fnmatch.fnmatch(path.rsplit("/", 1)[-1], pattern)


def _glob(args, ctx):
    pattern = (args.get("pattern") or "").strip()
    if not pattern:
        raise ToolError("Informe um padrão.")
    hits = [p for p in project_files(ctx.root) if _glob_match(p, pattern)]
    hits.sort(key=lambda p: -_mtime(os.path.join(ctx.root, p)))
    shown = hits[:MAX_MATCHES]
    out = "\n".join(shown) or "(nenhum arquivo)"
    if len(hits) > len(shown):
        out += f"\n… (mais {len(hits) - len(shown)})"
    return _ok(out, count=len(hits))


def _mtime(p):
    try:
        return os.path.getmtime(p)
    except OSError:
        return 0


def _grep(args, ctx):
    try:
        rx = re.compile(args.get("pattern") or "", re.IGNORECASE if args.get("ignore_case") else 0)
    except re.error as e:
        raise ToolError(f"Expressão regular inválida: {e}")
    sub = relpath(ctx, resolve(ctx, args.get("path") or "."))
    sub = "" if sub == "." else sub.rstrip("/") + "/"
    file_glob = args.get("glob")
    hits, files_hit = [], set()
    for rel in project_files(ctx.root):
        if sub and not rel.startswith(sub):
            continue
        if file_glob and not _glob_match(rel, file_glob):
            continue
        full = os.path.join(ctx.root, rel)
        try:
            if os.path.getsize(full) > 2_000_000:
                continue
            with open(full, "rb") as f:
                data = f.read()
        except OSError:
            continue
        if b"\0" in data[:8000]:
            continue
        for n, line in enumerate(data.decode("utf-8", "replace").splitlines(), 1):
            if rx.search(line):
                hits.append(f"{rel}:{n}: {line.strip()[:300]}")
                files_hit.add(rel)
                if len(hits) >= MAX_MATCHES:
                    break
        if len(hits) >= MAX_MATCHES:
            hits.append(f"… (parado em {MAX_MATCHES} resultados; refine a busca)")
            break
    return _ok("\n".join(hits) or "(nenhum resultado)", count=len(hits), files=len(files_hit))


def make_diff(rel, before, after):
    a, b = before.splitlines(), after.splitlines()
    lines = list(difflib.unified_diff(a, b, "a/" + rel, "b/" + rel, n=3, lineterm=""))
    added = sum(1 for l in lines if l.startswith("+") and not l.startswith("+++"))
    removed = sum(1 for l in lines if l.startswith("-") and not l.startswith("---"))
    return "\n".join(lines), added, removed


def _write(ctx, full, text, newline):
    """Writes `text` (with \\n line breaks) using the file's original line-ending style,
    after snapshotting the previous content for this turn's 'Desfazer'."""
    before = None
    if os.path.isfile(full):
        with open(full, "rb") as f:
            before = f.read()
    db.save_checkpoint(ctx.turn_id, full, before)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    data = (text.replace("\n", "\r\n") if newline == "\r\n" else text).encode("utf-8")
    with open(full, "wb") as f:
        f.write(data)


def _edit_file(args, ctx):
    full = resolve(ctx, args.get("path"))
    if not os.path.isfile(full):
        raise ToolError(f"Arquivo “{args.get('path')}” não encontrado. Para criar, use write_file.")
    text, _ = read_text(full)
    newline = "\r\n" if "\r\n" in text else "\n"
    text = text.replace("\r\n", "\n")
    old = (args.get("old_string") or "").replace("\r\n", "\n")
    new = (args.get("new_string") or "").replace("\r\n", "\n")
    if not old:
        raise ToolError("old_string está vazio.")
    if old == new:
        raise ToolError("old_string e new_string são iguais.")
    count = text.count(old)
    if count == 0:
        raise ToolError("old_string não foi encontrado no arquivo. Leia o arquivo de novo e copie o trecho exato.")
    if count > 1 and not args.get("replace_all"):
        raise ToolError(f"old_string aparece {count} vezes. Inclua mais contexto para torná-lo único ou use replace_all.")
    after = text.replace(old, new) if args.get("replace_all") else text.replace(old, new, 1)
    _write(ctx, full, after, newline)
    rel = relpath(ctx, full)
    diff, added, removed = make_diff(rel, text, after)
    r = _ok(f"“{rel}” editado (+{added} −{removed}).", path=rel, diff=diff, added=added, removed=removed)
    r["files"] = [rel]
    return r


def _write_file(args, ctx):
    full = resolve(ctx, args.get("path"))
    if os.path.isdir(full):
        raise ToolError(f"“{args.get('path')}” é uma pasta.")
    existed = os.path.isfile(full)
    before, newline = "", "\n"
    if existed:
        before, _ = read_text(full)
        newline = "\r\n" if "\r\n" in before else "\n"
        before = before.replace("\r\n", "\n")
    content = (args.get("content") or "").replace("\r\n", "\n")
    _write(ctx, full, content, newline)
    rel = relpath(ctx, full)
    diff, added, removed = make_diff(rel, before, content)
    verb = "atualizado" if existed else "criado"
    r = _ok(f"“{rel}” {verb} (+{added} −{removed}).", path=rel, diff=diff, added=added, removed=removed, created=not existed)
    r["files"] = [rel]
    return r


# ---------------------------------------------------------------- shell

_NO_WINDOW = 0x0800_0000 if os.name == "nt" else 0


def _shell():
    return shutil.which("pwsh") or shutil.which("powershell") or "powershell"


def kill_tree(proc):
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, creationflags=_NO_WINDOW)
    try:
        proc.kill()
    except OSError:
        pass


def _clip(text):
    if len(text) <= MAX_OUTPUT:
        return text
    half = MAX_OUTPUT // 2
    return text[:half] + f"\n\n… ({len(text) - MAX_OUTPUT} caracteres omitidos) …\n\n" + text[-half:]


def _run_command(args, ctx):
    command = (args.get("command") or "").strip()
    if not command:
        raise ToolError("Comando vazio.")
    timeout = min(int(args.get("timeout_seconds") or 120), 600)
    prelude = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; "
    proc = subprocess.Popen(
        [_shell(), "-NoProfile", "-NonInteractive", "-Command", prelude + command],
        cwd=ctx.root, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        creationflags=_NO_WINDOW,
    )
    chunks = []
    size = [0]

    def pump():
        # Read in small pieces so the UI sees output as it happens.
        while True:
            b = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
            if not b:
                break
            text = b.decode("utf-8", "replace")
            chunks.append(text)
            size[0] += len(text)
            if size[0] <= MAX_OUTPUT * 4:
                ctx.on_output(text)

    reader = threading.Thread(target=pump, daemon=True)
    reader.start()
    started = time.time()
    timed_out = cancelled = False
    while proc.poll() is None:
        if ctx.cancel is not None and ctx.cancel.is_set():
            cancelled = True
            kill_tree(proc)
            break
        if time.time() - started > timeout:
            timed_out = True
            kill_tree(proc)
            break
        time.sleep(0.05)
    proc.wait()
    reader.join(timeout=2)
    output = _clip("".join(chunks).replace("\r\n", "\n")).rstrip()
    code = proc.returncode
    ms = int((time.time() - started) * 1000)
    tail = ""
    if timed_out:
        tail = f"\n[interrompido: passou do limite de {timeout} s]"
    elif cancelled:
        tail = "\n[interrompido pelo usuário]"
    text = (output or "(sem saída)") + tail + f"\n[código de saída: {code}]"
    r = {"output": text, "is_error": bool(code) or timed_out or cancelled, "files": [],
         "meta": {"command": command, "exit_code": code, "ms": ms, "timed_out": timed_out, "output": output}}
    return r


# ---------------------------------------------------------------- project info

def git_info(root):
    """{'branch': str|None, 'status': str} — best effort, empty when not a repo."""
    if not shutil.which("git"):
        return {"branch": None, "status": ""}
    try:
        b = subprocess.run(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=root, capture_output=True, timeout=5,
                           creationflags=_NO_WINDOW)
        if b.returncode != 0:
            return {"branch": None, "status": ""}
        s = subprocess.run(["git", "status", "--short"], cwd=root, capture_output=True, timeout=10, creationflags=_NO_WINDOW)
        return {"branch": b.stdout.decode().strip(), "status": s.stdout.decode("utf-8", "replace").strip()}
    except (OSError, subprocess.SubprocessError):
        return {"branch": None, "status": ""}


def project_instructions(root):
    for name in ("AGENTS.md", "CLAUDE.md"):
        p = os.path.join(root, name)
        if os.path.isfile(p):
            try:
                with open(p, encoding="utf-8", errors="replace") as f:
                    return name, f.read()[:20_000]
            except OSError:
                pass
    return None, ""


def undo_turn(turn_id):
    """Restores every file the turn edited to its content before the turn. Returns the restored paths."""
    restored = []
    for cp in db.list_checkpoints(turn_id):
        path, before = cp["path"], cp["before"]
        try:
            if before is None:
                if os.path.isfile(path):
                    os.remove(path)
            else:
                with open(path, "wb") as f:
                    f.write(before)
            restored.append(path)
        except OSError:
            pass
    db.delete_checkpoints(turn_id)
    return restored
