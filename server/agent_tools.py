"""Tool definitions exposed to the model (filesystem + sandboxed code execution),
and their execution. `run_code` uses the isolated WSL2 distro in `sandbox.py`;
the plain file tools operate directly on the conversation's workspace
directory on the host, since that directory is already confined per
conversation and path-traversal-checked.
"""
import os

from . import db, sandbox

WORKSPACE_ROOT = os.path.join(db.DATA_DIR, "workspaces")

TOOLS = [
    {
        "name": "run_code",
        "description": (
            "Executa código Python ou Bash num sandbox isolado (WSL2), com acesso apenas à pasta de "
            "arquivos desta conversa (workspace) como diretório de trabalho. Use para gerar arquivos "
            "(docx, xlsx, pdf, imagens etc.), processar dados ou fazer cálculos. Arquivos criados ou "
            "alterados na pasta de trabalho ficam disponíveis para o usuário baixar. Bibliotecas Python "
            "já instaladas: python-docx, openpyxl, reportlab, fpdf2, pillow, pandas."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "language": {"type": "string", "enum": ["python", "bash"]},
                "code": {"type": "string"},
                "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 60},
            },
            "required": ["language", "code"],
        },
    },
    {
        "name": "write_file",
        "description": "Cria ou sobrescreve um arquivo de texto na pasta de arquivos desta conversa.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {"type": "string", "description": "Caminho relativo dentro da pasta da conversa."},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
    },
    {
        "name": "read_file",
        "description": "Lê o conteúdo de um arquivo de texto da pasta de arquivos desta conversa.",
        "input_schema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
    },
    {
        "name": "list_files",
        "description": "Lista os arquivos presentes na pasta de arquivos desta conversa.",
        "input_schema": {"type": "object", "properties": {}},
    },
]


def enabled_tools():
    """TOOLS filtered by Configurações → Recursos."""
    s = db.get_settings()
    off = set()
    if not s.get("tool_code", True):
        off.add("run_code")
    if not s.get("tool_files", True):
        off.update({"write_file", "read_file", "list_files"})
    return [t for t in TOOLS if t["name"] not in off]


def to_anthropic_tools():
    return [{"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]} for t in enabled_tools()]


def to_openai_tools():
    return [{"type": "function", "function": {"name": t["name"], "description": t["description"],
                                              "parameters": t["input_schema"]}} for t in enabled_tools()]


def workspace_dir(conversation_id):
    path = os.path.join(WORKSPACE_ROOT, conversation_id)
    os.makedirs(path, exist_ok=True)
    return path


def _safe_path(conversation_id, rel):
    base = os.path.normpath(workspace_dir(conversation_id))
    full = os.path.normpath(os.path.join(base, rel or ""))
    if full != base and not full.startswith(base + os.sep):
        raise ValueError(f"Caminho “{rel}” está fora da pasta desta conversa.")
    return full


def _snapshot(base):
    out = {}
    for root, _, files in os.walk(base):
        for name in files:
            p = os.path.join(root, name)
            out[os.path.relpath(p, base)] = os.path.getmtime(p)
    return out


def execute(name, args, conversation_id):
    """Returns {"output": str, "is_error": bool, "files": [relative paths changed]}."""
    try:
        if name == "run_code":
            return _run_code(args, conversation_id)
        if name == "write_file":
            return _write_file(args, conversation_id)
        if name == "read_file":
            return _read_file(args, conversation_id)
        if name == "list_files":
            return _list_files(conversation_id)
        return {"output": f"Ferramenta desconhecida: {name}", "is_error": True, "files": []}
    except Exception as e:  # noqa: BLE001 - a tool failure must surface as a result, never crash the generation
        return {"output": f"Erro ao executar “{name}”: {e}", "is_error": True, "files": []}


def _run_code(args, conversation_id):
    code = args.get("code") or ""
    language = args.get("language") or "python"
    timeout = min(int(args.get("timeout_seconds") or 20), 60)
    base = workspace_dir(conversation_id)
    before = _snapshot(base)
    notice = sandbox.ensure_ready()
    result = sandbox.run(code, language, timeout, base)
    after = _snapshot(base)
    changed = sorted(p for p, mtime in after.items() if before.get(p) != mtime)
    output = result["stdout"]
    if result["stderr"]:
        output += ("\n" if output else "") + "[stderr]\n" + result["stderr"]
    if result["timed_out"]:
        output += "\n[a execução foi interrompida por exceder o tempo limite]"
    is_error = result["exit_code"] not in (0, None) or result["timed_out"]
    if notice:
        output = notice + "\n\n" + output
    return {"output": output.strip() or "(sem saída)", "is_error": is_error, "files": changed}


def _write_file(args, conversation_id):
    rel = args.get("path") or ""
    full = _safe_path(conversation_id, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8") as f:
        f.write(args.get("content") or "")
    return {"output": f"Arquivo “{rel}” salvo.", "is_error": False, "files": [rel]}


def _read_file(args, conversation_id):
    rel = args.get("path") or ""
    full = _safe_path(conversation_id, rel)
    if not os.path.isfile(full):
        return {"output": f"Arquivo “{rel}” não encontrado.", "is_error": True, "files": []}
    with open(full, "rb") as f:
        data = f.read()
    try:
        return {"output": data.decode("utf-8"), "is_error": False, "files": []}
    except UnicodeDecodeError:
        return {"output": f"“{rel}” é um arquivo binário ({len(data)} bytes) — não pode ser lido como texto. "
                          "Use list_files para confirmar que existe; o usuário pode baixá-lo pelo chat.",
               "is_error": True, "files": []}


def _list_files(conversation_id):
    base = workspace_dir(conversation_id)
    names = sorted(os.path.relpath(os.path.join(r, f), base) for r, _, fs in os.walk(base) for f in fs)
    return {"output": "\n".join(names) or "(pasta vazia)", "is_error": False, "files": []}
