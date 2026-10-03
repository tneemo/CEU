"""Native, reusable Git/GitHub tools for Code sessions and agents.

Local Git runs the detected host executable with argv (never a shell). GitHub calls
are delegated to :mod:`server.github`, so their transport and credentials are
replaceable in offline tests.
"""
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse

from . import github

MAX_OUTPUT = 30_000
READ_ONLY = {"git_detect", "git_status", "git_diff", "git_log", "github_status", "github_get_repo"}
GIT_WRITE = {"git_init", "git_add", "git_commit", "git_branch", "git_tag", "git_remote"}
GITHUB_PUBLISH = {"github_create_repo", "github_push", "github_create_release", "github_upload_asset"}
TOOLS = [
    {"name": "git_detect", "description": "Detecta Git no host e informa se a pasta escolhida é a raiz de um repositório.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "git_init", "description": "Inicializa um repositório Git na raiz da pasta do projeto, se ela não estiver dentro de outro repositório.",
     "input_schema": {"type": "object", "properties": {"branch": {"type": "string", "description": "Branch inicial (padrão: main)"}}}},
    {"name": "git_status", "description": "Mostra branch, upstream e alterações staged, unstaged e não rastreadas.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "git_diff", "description": "Mostra diff staged ou unstaged; paths limita os caminhos relativos à raiz do projeto.",
     "input_schema": {"type": "object", "properties": {"staged": {"type": "boolean"}, "paths": {"type": "array", "items": {"type": "string"}}}}},
    {"name": "git_add", "description": "Adiciona caminhos ao index Git. Use paths=['.'] para incluir tudo na pasta do projeto, respeitando .gitignore.",
     "input_schema": {"type": "object", "properties": {"paths": {"type": "array", "items": {"type": "string"}}}, "required": ["paths"]}},
    {"name": "git_commit", "description": "Cria um commit com as alterações staged. O usuário precisa aprovar a operação conforme as permissões atuais.",
     "input_schema": {"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]}},
    {"name": "git_branch", "description": "Lista branches, cria, troca ou apaga uma branch local (a exclusão só funciona se já estiver integrada).",
     "input_schema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "create", "switch", "delete"]}, "name": {"type": "string"}}, "required": ["action"]}},
    {"name": "git_tag", "description": "Lista tags, cria uma tag anotada ou apaga uma tag local.",
     "input_schema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "create", "delete"]}, "name": {"type": "string"}, "message": {"type": "string"}}, "required": ["action"]}},
    {"name": "git_log", "description": "Lista commits recentes com SHA completo, autor, data e assunto.",
     "input_schema": {"type": "object", "properties": {"count": {"type": "integer", "minimum": 1, "maximum": 100}}}},
    {"name": "git_remote", "description": "Lista remotes ou adiciona, atualiza e remove um remote HTTPS/SSH/local, sem credenciais embutidas. github_push usa remote HTTPS de github.com.",
     "input_schema": {"type": "object", "properties": {"action": {"type": "string", "enum": ["list", "set", "remove"]}, "name": {"type": "string"}, "url": {"type": "string"}}, "required": ["action"]}},
    {"name": "github_status", "description": "Informa se a conta GitHub está conectada ao CEU; nunca revela o token.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "github_create_repo", "description": "Cria um repositório na conta conectada. Privado por padrão; retorna URL HTTPS para configurar como remote.",
     "input_schema": {"type": "object", "properties": {"name": {"type": "string"}, "private": {"type": "boolean"}, "description": {"type": "string"}}, "required": ["name"]}},
    {"name": "github_get_repo", "description": "Consulta um repositório. Se owner/repo forem omitidos, tenta inferi-los do remote origin.",
     "input_schema": {"type": "object", "properties": {"owner": {"type": "string"}, "repo": {"type": "string"}, "remote": {"type": "string"}}}},
    {"name": "github_push", "description": "Publica uma branch ou tag local no remote HTTPS do GitHub; nunca força atualização. Requer aprovação de publicação.",
     "input_schema": {"type": "object", "properties": {"remote": {"type": "string"}, "ref": {"type": "string", "description": "Branch/tag local; padrão: branch atual"}}, "required": []}},
    {"name": "github_create_release", "description": "Cria uma release GitHub para uma tag existente ou para um commit. Requer aprovação de publicação.",
     "input_schema": {"type": "object", "properties": {"owner": {"type": "string"}, "repo": {"type": "string"}, "tag": {"type": "string"}, "name": {"type": "string"}, "body": {"type": "string"}, "target_commitish": {"type": "string"}, "draft": {"type": "boolean"}, "prerelease": {"type": "boolean"}}, "required": ["tag"]}},
    {"name": "github_upload_asset", "description": "Anexa um arquivo da pasta do projeto a uma release existente. Artefatos acima de 2 GiB são recusados. Requer aprovação de publicação.",
     "input_schema": {"type": "object", "properties": {"tag": {"type": "string"}, "path": {"type": "string"}, "name": {"type": "string"}, "owner": {"type": "string"}, "repo": {"type": "string"}}, "required": ["tag", "path"]}},
]
TOOLS_BY_NAME = {tool["name"]: tool for tool in TOOLS}


class GitToolError(Exception):
    pass


def approval_class(name):
    if name in GIT_WRITE:
        return "git_write"
    if name in GITHUB_PUBLISH:
        return "github_publish"
    return None


def _remote_summary_url(raw):
    if not isinstance(raw, str) or not raw.strip():
        return ""
    value = raw.strip()
    if re.fullmatch(r"git@[A-Za-z0-9.-]+:[^\s]+", value):
        return value
    try:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme and parsed.hostname:
            host = parsed.hostname + (f":{parsed.port}" if parsed.port else "")
            safe = urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                safe += " [credenciais e parâmetros ocultos]"
            return safe
    except ValueError:
        pass
    if any(ord(ch) < 32 or ord(ch) == 127 for ch in value):
        return "[URL ocultada]"
    basename = re.split(r"[\\/]", value.rstrip("\\/"))[-1]
    return f"[caminho local: {basename}]" if basename else "[caminho local]"


def summary(name, args):
    a = args or {}
    names = {
        "git_init": "Inicializar repositório Git",
        "git_add": "Adicionar caminhos ao index Git: " + ", ".join(a.get("paths") or []),
        "git_commit": "Criar commit: " + (a.get("message") or "")[:160],
        "git_branch": f"Branch Git ({a.get('action', '')}): {a.get('name', '')}",
        "git_tag": f"Tag Git ({a.get('action', '')}): {a.get('name', '')}",
        "git_remote": f"Remote Git ({a.get('action', '')}): {a.get('name', '')} "
                      f"{_remote_summary_url(a.get('url'))}",
        "github_create_repo": f"Criar repositório GitHub {'privado' if a.get('private') is not False else 'público'}: {a.get('name', '')}",
        "github_push": f"Publicar {a.get('ref') or 'branch atual'} em {a.get('remote') or 'origin'}",
        "github_create_release": f"Criar release GitHub {a.get('tag', '')}",
        "github_upload_asset": f"Anexar {a.get('path', '')} à release {a.get('tag', '')}",
    }
    return github.redact(names.get(name, name), _token_for_redaction())


def _ok(output, **meta):
    secret = _token_for_redaction()
    return {"output": _sanitize(output, secret), "is_error": False, "files": [], "meta": _scrub(meta, secret)}


def _err(output, **meta):
    secret = _token_for_redaction()
    return {"output": _sanitize(output, secret), "is_error": True, "files": [], "meta": _scrub(meta, secret)}


def _scrub(value, secret=None):
    if isinstance(value, str):
        return github.redact(value, secret)
    if isinstance(value, dict):
        return {key: _scrub(item, secret) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item, secret) for item in value]
    if isinstance(value, tuple):
        return tuple(_scrub(item, secret) for item in value)
    return value


def _clip(text):
    if len(text) <= MAX_OUTPUT:
        return text
    return text[:MAX_OUTPUT // 2] + f"\n… ({len(text) - MAX_OUTPUT} caracteres omitidos) …\n" + text[-MAX_OUTPUT // 2:]


def _git_exe():
    path = shutil.which("git")
    if not path and os.name == "nt":
        for candidate in (r"C:\Program Files\Git\cmd\git.exe", r"C:\Program Files (x86)\Git\cmd\git.exe"):
            if os.path.isfile(candidate):
                path = candidate
                break
    if not path:
        raise GitToolError("Git não foi encontrado pelo CEU. Instale Git para Windows, feche e reabra o CEU para "
                           "atualizar o PATH. Nenhum comando alternativo foi executado.")
    return path


def git_available():
    try:
        _git_exe()
        return True
    except GitToolError:
        return False


def _git_env(with_github_auth=False):
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GCM_INTERACTIVE"] = "never"
    if with_github_auth:
        count = int(env.get("GIT_CONFIG_COUNT", "0") or 0)
        helper = os.path.join(os.path.dirname(__file__), "git_credential.py").replace("\\", "/")
        python = sys.executable.replace("\\", "/")
        # Empty entry resets system/global helpers; the CEU helper is the only source.
        env[f"GIT_CONFIG_KEY_{count}"] = "credential.helper"
        env[f"GIT_CONFIG_VALUE_{count}"] = ""
        env[f"GIT_CONFIG_KEY_{count + 1}"] = "credential.helper"
        env[f"GIT_CONFIG_VALUE_{count + 1}"] = f'!"{python}" "{helper}"'
        env["GIT_CONFIG_COUNT"] = str(count + 2)
    return env


def _sanitize(text, secret=None):
    text = github.redact(text, secret)
    return _clip(text)


def _run_git(root, args, timeout=60, input_text=None, with_github_auth=False, secret=None, disable_hooks=False):
    hook_dir = None
    try:
        command = [_git_exe()]
        if disable_hooks:
            hook_dir = tempfile.TemporaryDirectory(prefix="ceu-git-hooks-")
            command += ["-c", f"core.hooksPath={hook_dir.name}"]
        command += list(args)
        result = subprocess.run(command, cwd=root, input=input_text, capture_output=True, text=True,
                                encoding="utf-8", errors="replace", timeout=timeout,
                                creationflags=0x08000000 if os.name == "nt" else 0,
                                env=_git_env(with_github_auth))
    except subprocess.TimeoutExpired:
        raise GitToolError(f"Git excedeu {timeout} s e foi interrompido. Verifique a rede e o estado do repositório.") from None
    except OSError as exc:
        raise GitToolError(f"Não foi possível iniciar Git ({type(exc).__name__}). Verifique a instalação no host.") from None
    finally:
        if hook_dir is not None:
            hook_dir.cleanup()
    if secret is None:
        secret = _token_for_redaction()
    stdout, stderr = _sanitize(result.stdout or "", secret).strip(), _sanitize(result.stderr or "", secret).strip()
    return result.returncode, stdout, stderr


def _need_git(root, args, **kwargs):
    code, out, err = _run_git(root, args, **kwargs)
    if code:
        detail = err or out or f"Git encerrou com código {code}."
        lowered = detail.lower()
        if "author identity unknown" in lowered or "please tell me who you are" in lowered:
            detail += " Configure git config --global user.name e git config --global user.email e tente de novo."
        if "not a git repository" in lowered:
            detail = "Esta pasta não está em um repositório. Execute git_init primeiro."
        if "pathspec" in lowered and "did not match" in lowered:
            detail += " Confira se o caminho existe e é relativo à pasta do projeto."
        raise GitToolError(detail)
    return out


def _repo_info(root):
    code, top, _ = _run_git(root, ["rev-parse", "--show-toplevel"])
    if code:
        return None
    return os.path.normcase(os.path.realpath(top.strip()))


def _repo(root):
    top = _repo_info(root)
    if not top:
        raise GitToolError("Esta pasta não tem um repositório Git. Use git_init para inicializá-la.")
    chosen = os.path.normcase(os.path.realpath(root))
    if top != chosen:
        raise GitToolError(f"A pasta escolhida está dentro do repositório {top}. Selecione a raiz desse repositório "
                           "no CEU para evitar versionar arquivos fora da pasta concedida.")
    return top


def _pathspecs(root, paths):
    if not isinstance(paths, list) or not paths:
        raise GitToolError("Informe ao menos um caminho relativo à pasta do projeto.")
    if len(paths) > 500:
        raise GitToolError("Informe no máximo 500 caminhos por chamada.")
    out = []
    for raw in paths:
        if not isinstance(raw, str) or not raw.strip() or "\0" in raw:
            raise GitToolError("Cada caminho precisa ser um texto relativo não vazio.")
        p = os.path.normpath(raw.strip().strip('"'))
        absolute = os.path.realpath(p if os.path.isabs(p) else os.path.join(root, p))
        if not _within(root, absolute):
            raise GitToolError(f"O caminho “{raw}” está fora da pasta do projeto.")
        if os.path.isabs(p):
            p = os.path.relpath(p, root)
        out.append(p.replace("\\", "/"))
    return out


def _within(root, path):
    try:
        return os.path.commonpath((os.path.normcase(root), os.path.normcase(path))) == os.path.normcase(root)
    except ValueError:  # different Windows drives
        return False


def _repo_slug(owner, repo):
    if (not isinstance(owner, str) or not isinstance(repo, str) or not owner or not repo or
            not re.fullmatch(r"[A-Za-z0-9_.-]+", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]+", repo)):
        raise GitToolError("Informe owner e repo com nomes válidos do GitHub.")
    if owner in (".", "..") or repo in (".", ".."):
        raise GitToolError("Owner/repo inválido.")
    return owner, repo.removesuffix(".git")


def _parse_github_remote(url):
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme != "https" or parsed.hostname != "github.com" or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise GitToolError("O remote precisa ser HTTPS de github.com, sem usuário, senha, query ou fragmento. Use git_remote "
                           "para configurar a URL clone HTTPS retornada pelo GitHub.")
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) != 2:
        raise GitToolError("Não consegui extrair owner/repo da URL do remote GitHub.")
    return _repo_slug(parts[0], parts[1])


def _validate_remote_url(raw):
    url = raw.strip()
    if not url or any(ord(ch) < 32 or ord(ch) == 127 for ch in url):
        raise GitToolError("Informe uma URL remote sem espaços de controle.")
    # Local bare repositories and filesystem paths are valid Git remotes.
    if (os.path.isabs(url) or url.startswith((".", "\\", "/")) or
            re.match(r"^[A-Za-z]:[\\/]", url) or ("://" not in url and "@" not in url)):
        return url
    if re.fullmatch(r"git@[A-Za-z0-9.-]+:[^\s]+", url):
        return url
    try:
        parsed = urllib.parse.urlsplit(url)
        valid = (parsed.scheme in ("https", "ssh", "git") and parsed.hostname and not parsed.password and
                 not parsed.query and not parsed.fragment and
                 (parsed.scheme != "https" or not parsed.username))
    except ValueError:
        valid = False
    if not valid:
        raise GitToolError("Remote inválido. Use URL HTTPS/SSH sem senha ou token, formato git@host:path ou caminho "
                           "local. Credenciais devem ficar fora da URL.")
    return url


def _remote_url(root, remote):
    _remote_name(remote)
    return _need_git(root, ["remote", "get-url", remote])


def _remote_name(remote):
    if not isinstance(remote, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", remote):
        raise GitToolError("Nome de remote inválido.")
    return remote


def _github_client():
    return github.client()


def _resolve_repo(ctx, args):
    owner, repo = args.get("owner"), args.get("repo")
    if owner and repo:
        return _repo_slug(owner, repo)
    _repo(ctx.root)
    remote = args.get("remote") or "origin"
    return _parse_github_remote(_remote_url(ctx.root, remote))


def _status(root):
    raw = _need_git(root, ["status", "--porcelain=v1", "-b", "-z", "--untracked-files=normal"])
    entries = raw.split("\0") if raw else []
    header = entries.pop(0) if entries else ""
    branch_info = header[3:] if header.startswith("## ") else ""
    branch, upstream, ahead, behind = branch_info, None, 0, 0
    if "..." in branch_info:
        branch, tail = branch_info.split("...", 1)
        upstream = re.split(r"\s+\[", tail, 1)[0]
    match = re.search(r"\[([^]]+)\]", branch_info)
    if match:
        ahead_match = re.search(r"ahead (\d+)", match.group(1))
        behind_match = re.search(r"behind (\d+)", match.group(1))
        ahead, behind = int(ahead_match.group(1)) if ahead_match else 0, int(behind_match.group(1)) if behind_match else 0
    changes = []
    i = 0
    while i < len(entries):
        item = entries[i]
        i += 1
        if len(item) < 4:
            continue
        xy, path = item[:2], item[3:]
        original = None
        if "R" in xy or "C" in xy:
            original = entries[i] if i < len(entries) else None
            i += 1
        changes.append({"index_status": xy[0], "worktree_status": xy[1], "path": path,
                        "renamed_from": original})
    return {"branch": branch or None, "upstream": upstream, "ahead": ahead, "behind": behind,
            "clean": not changes, "changes": changes}


def _remote_list(root):
    names = _need_git(root, ["remote"]).splitlines()
    result = []
    for name in names:
        _remote_name(name)
        fetch = _need_git(root, ["remote", "get-url", name])
        code, push, _ = _run_git(root, ["remote", "get-url", "--push", name])
        result.append({"name": name, "fetch_url": _safe_url(fetch), "push_url": _safe_url(push if code == 0 else fetch)})
    return result


def _safe_url(value):
    try:
        parsed = urllib.parse.urlsplit(value.strip())
        if parsed.scheme and parsed.hostname:
            host = parsed.hostname
            if parsed.port:
                host += ":" + str(parsed.port)
            return urllib.parse.urlunsplit((parsed.scheme, host, parsed.path, "", ""))
    except ValueError:
        pass
    return value.strip()


def _token_for_redaction():
    try:
        return github.credential_store().get()
    except github.GitHubError:
        return None


def _local_tool(name, args, ctx):
    root = os.path.realpath(ctx.root)
    if name == "git_detect":
        exe = None
        try:
            exe = _git_exe()
        except GitToolError:
            return _ok("Git não foi encontrado pelo CEU. Instale Git para Windows e reabra o CEU.",
                       installed=False, is_repository=False, root=None)
        top = _repo_info(root)
        return _ok(f"Git disponível: {exe}. " + (f"Raiz do repositório: {top}." if top else "Esta pasta ainda não é um repositório."),
                   installed=True, is_repository=bool(top), root=top, selected_root=root,
                   supported_root=bool(top and top == os.path.normcase(root)))
    if name == "git_init":
        if _repo_info(root):
            raise GitToolError("A pasta já está dentro de um repositório Git. Nenhum repositório aninhado foi criado.")
        branch = (args.get("branch") or "main").strip()
        _need_git(root, ["check-ref-format", "--branch", branch])
        output = _need_git(root, ["init", "--initial-branch", branch])
        return _ok(f"Repositório Git inicializado em {root}, branch {branch}.", root=root, branch=branch,
                   git_output=output)
    _repo(root)
    if name == "git_status":
        status = _status(root)
        return _ok(json.dumps(status, ensure_ascii=False), **status)
    if name == "git_diff":
        command = ["diff", "--no-ext-diff", "--no-color", "--unified=3"]
        if args.get("staged"):
            command.append("--cached")
        paths = args.get("paths") or []
        if paths:
            command += ["--", *_pathspecs(root, paths)]
        diff = _need_git(root, command)
        secret = _token_for_redaction()
        diff = _sanitize(diff or "(diff vazio)", secret)
        return _ok(diff, staged=bool(args.get("staged")), paths=paths, truncated=len(diff) >= MAX_OUTPUT)
    if name == "git_add":
        paths = _pathspecs(root, args.get("paths"))
        _need_git(root, ["add", "--", *paths])
        status = _status(root)
        return _ok(f"Adicionados ao index: {', '.join(paths)}. Branch {status['branch']}; "
                   f"{len(status['changes'])} caminho(s) alterado(s).", paths=paths, branch=status["branch"],
                   changed=len(status["changes"]))
    if name == "git_commit":
        message = (args.get("message") or "").strip()
        if not message or len(message) > 20_000:
            raise GitToolError("A mensagem do commit precisa ter de 1 a 20.000 caracteres.")
        _need_git(root, ["commit", "-F", "-"], input_text=message + "\n")
        sha = _need_git(root, ["rev-parse", "HEAD"])
        subject = _need_git(root, ["log", "-1", "--format=%s"])
        branch = _need_git(root, ["branch", "--show-current"]) or None
        return _ok(f"Commit criado: {sha} · {subject}", commit_sha=sha, branch=branch, subject=subject)
    if name == "git_branch":
        action, branch = args.get("action"), (args.get("name") or "").strip()
        if action == "list":
            text = _need_git(root, ["branch", "--list", "--format=%(refname:short)"])
            current = _need_git(root, ["branch", "--show-current"]) or None
            return _ok(text or "(nenhuma branch)", branches=text.splitlines(), current=current)
        if not branch:
            raise GitToolError("Informe name para criar, trocar ou apagar uma branch.")
        _need_git(root, ["check-ref-format", "--branch", branch])
        if action == "create":
            _need_git(root, ["branch", "--", branch])
        elif action == "switch":
            _need_git(root, ["switch", "--", branch])
        elif action == "delete":
            _need_git(root, ["branch", "-d", "--", branch])
        else:
            raise GitToolError("action precisa ser list, create, switch ou delete.")
        current = _need_git(root, ["branch", "--show-current"]) or None
        return _ok(f"Branch {branch}: {action}. Branch atual: {current or '(detached HEAD)' }.",
                   action=action, branch=branch, current=current)
    if name == "git_tag":
        action, tag = args.get("action"), (args.get("name") or "").strip()
        if action == "list":
            text = _need_git(root, ["tag", "--list", "--sort=-version:refname"])
            return _ok(text or "(nenhuma tag)", tags=text.splitlines())
        if not tag:
            raise GitToolError("Informe name para criar ou apagar uma tag.")
        _need_git(root, ["check-ref-format", f"refs/tags/{tag}"])
        if action == "create":
            msg = (args.get("message") or f"Release {tag}").strip()
            _need_git(root, ["tag", "--annotate", "--message", msg, "--", tag])
        elif action == "delete":
            _need_git(root, ["tag", "--delete", "--", tag])
        else:
            raise GitToolError("action precisa ser list, create ou delete.")
        if action == "create":
            sha = _need_git(root, ["rev-parse", f"refs/tags/{tag}^{{}}"])
        else:
            sha = None
        return _ok(f"Tag {tag} {('criada' if action == 'create' else 'apagada')}.", tag=tag, action=action,
                   commit_sha=sha)
    if name == "git_log":
        count = min(max(int(args.get("count") or 10), 1), 100)
        raw = _need_git(root, ["log", f"-{count}", "--format=%H%x1f%s%x1f%an%x1f%aI%x1e"])
        commits = []
        for row in raw.split("\x1e"):
            fields = row.strip().split("\x1f", 3)
            if len(fields) == 4:
                commits.append({"sha": fields[0], "subject": fields[1], "author": fields[2], "date": fields[3]})
        return _ok(json.dumps(commits, ensure_ascii=False), commits=commits)
    if name == "git_remote":
        action, remote = args.get("action"), (args.get("name") or "origin").strip()
        if action == "list":
            remotes = _remote_list(root)
            return _ok(json.dumps(remotes, ensure_ascii=False), remotes=remotes)
        _remote_name(remote)
        if action == "set":
            url = (args.get("url") or "").strip()
            clean = _validate_remote_url(url)
            code, _, _ = _run_git(root, ["remote", "get-url", remote])
            if code == 0:
                _need_git(root, ["remote", "set-url", remote, clean])
            else:
                _need_git(root, ["remote", "add", remote, clean])
        elif action == "remove":
            _need_git(root, ["remote", "remove", remote])
        else:
            raise GitToolError("action precisa ser list, set ou remove.")
        remotes = _remote_list(root)
        return _ok(f"Remote {remote}: {action}.", remotes=remotes)
    raise GitToolError(f"Ferramenta Git local desconhecida: {name}.")


def _github_tool(name, args, ctx):
    if name == "github_status":
        status = github.describe()
        return _ok(json.dumps(status, ensure_ascii=False), **status)
    client = _github_client()
    if name == "github_create_repo":
        repo_name = (args.get("name") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repo_name) or repo_name in (".", ".."):
            raise GitToolError("Informe um nome de repositório válido (1–100 letras, números, ponto, hífen ou _).")
        private = args.get("private", True)
        if private is None:
            private = True
        if not isinstance(private, bool):
            raise GitToolError("private precisa ser true ou false; omitir mantém o repositório privado.")
        data = client.create_repo(repo_name, private, (args.get("description") or "")[:350])
        return _ok(f"Repositório criado: {data.get('html_url')} ({'privado' if data.get('private') else 'público'}). "
                   f"Configure o remote com git_remote action=set, name=origin, url={data.get('clone_url')}.",
                   repository=data, repo_url=data.get("html_url"), remote_url=data.get("clone_url"))
    if name == "github_get_repo":
        owner, repo = _resolve_repo(ctx, args)
        data = client.get_repo(owner, repo)
        return _ok(f"{data.get('full_name')}: {data.get('html_url')} ({'privado' if data.get('private') else 'público'}).",
                   repository=data, repo_url=data.get("html_url"))
    if name == "github_push":
        root = _repo(os.path.realpath(ctx.root))
        remote = (args.get("remote") or "origin").strip()
        _remote_name(remote)
        owner, repo = _parse_github_remote(_remote_url(root, remote))
        push_urls = _need_git(root, ["remote", "get-url", "--push", "--all", remote]).splitlines()
        if len(push_urls) != 1:
            raise GitToolError("O remote tem mais de um destino de push. Configure um único destino HTTPS do GitHub.")
        push_owner, push_repo = _parse_github_remote(push_urls[0])
        if (push_owner.lower(), push_repo.lower()) != (owner.lower(), repo.lower()):
            raise GitToolError("O destino efetivo de push não corresponde ao remote GitHub validado. Revise pushurl e a configuração url.*.pushInsteadOf.")
        ref = (args.get("ref") or "").strip()
        if not ref:
            branch = _need_git(root, ["branch", "--show-current"])
            if not branch:
                raise GitToolError("HEAD está detached. Troque para uma branch ou informe uma tag em ref.")
            ref = branch
        elif ref.startswith("refs/tags/"):
            ref = ref[len("refs/tags/"):]
        elif ref.startswith("refs/heads/"):
            ref = ref[len("refs/heads/"):]
        if not ref:
            raise GitToolError("Informe uma branch ou tag local para publicar.")
        branch_ref_valid = _run_git(root, ["check-ref-format", f"refs/heads/{ref}"])[0] == 0
        tag_ref_valid = _run_git(root, ["check-ref-format", f"refs/tags/{ref}"])[0] == 0
        if not (branch_ref_valid or tag_ref_valid):
            raise GitToolError("O nome informado não é uma branch/tag Git válida.")
        code, commit, _ = _run_git(root, ["rev-parse", "--verify", f"refs/heads/{ref}^{{commit}}"])
        kind = "branch" if code == 0 else "tag"
        if kind == "tag":
            code, commit, _ = _run_git(root, ["rev-parse", "--verify", f"refs/tags/{ref}^{{commit}}"])
            if code:
                raise GitToolError(f"Não encontrei branch nem tag local chamada {ref}.")
        token = github.credential_store().get()
        if not token:
            raise github.GitHubError("GitHub não está conectado. Abra Configurações → GitHub e conecte um token.", 401)
        spec = f"refs/{'heads' if kind == 'branch' else 'tags'}/{ref}:refs/{'heads' if kind == 'branch' else 'tags'}/{ref}"
        push_args = ["push", "--porcelain"]
        if kind == "branch":
            push_args.append("--set-upstream")
        push_args += [remote, spec]
        _need_git(root, push_args, timeout=600, with_github_auth=True, secret=token, disable_hooks=True)
        url = f"https://github.com/{owner}/{repo}"
        result = {"commit_sha": commit, "ref": ref, "ref_type": kind, "tag": ref if kind == "tag" else None,
                  "remote": remote, "remote_url": f"https://github.com/{owner}/{repo}.git", "repo_url": url}
        return _ok(f"{kind.capitalize()} {ref} publicada em {url}. Commit {commit}.", **result)
    if name == "github_create_release":
        owner, repo = _resolve_repo(ctx, args)
        tag = (args.get("tag") or "").strip()
        if not tag or len(tag) > 255 or any(ch.isspace() for ch in tag):
            raise GitToolError("Informe uma tag de release válida (sem espaços; até 255 caracteres).")
        target = (args.get("target_commitish") or "").strip()
        if not target:
            code, target, _ = _run_git(ctx.root, ["rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"])
            if code:
                target = _need_git(ctx.root, ["rev-parse", "HEAD"])
        release = client.create_release(owner, repo, tag, args.get("name") or tag,
                                        (args.get("body") or "")[:125_000], target,
                                        args.get("draft", False), args.get("prerelease", False))
        commit = None
        if _repo_info(os.path.realpath(ctx.root)):
            code, sha, _ = _run_git(ctx.root, ["rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"])
            if code == 0:
                commit = sha
        return _ok(f"Release {tag} criada: {release.get('html_url')}", tag=tag, commit_sha=commit,
                   release=release, release_url=release.get("html_url"), repo_url=f"https://github.com/{owner}/{repo}")
    if name == "github_upload_asset":
        owner, repo = _resolve_repo(ctx, args)
        tag = (args.get("tag") or "").strip()
        path = args.get("path") or ""
        if not tag:
            raise GitToolError("Informe a tag da release.")
        root = os.path.realpath(ctx.root)
        raw = path.strip().strip('"')
        full = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(root, raw))
        if not _within(root, full):
            raise GitToolError("O artefato precisa estar dentro da pasta do projeto concedida ao agente.")
        if not os.path.isfile(full):
            raise GitToolError(f"Artefato não encontrado: {path}.")
        release = client.get_release_by_tag(owner, repo, tag)
        filename = os.path.basename(args.get("name") or full)
        if not filename or filename in (".", "..") or any(ch in filename for ch in ("/", "\\", "\0")):
            raise GitToolError("Informe um nome simples para o artefato, sem caminho.")
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        asset = client.upload_asset(owner, repo, release["id"], full, filename, content_type,
                                    cancel=getattr(ctx, "cancel", None))
        asset["path"] = os.path.relpath(full, root).replace(os.sep, "/")
        return _ok(f"Artefato publicado: {asset.get('name')} ({asset.get('size')} bytes) · "
                   f"{asset.get('browser_download_url')}", tag=tag, release_url=release.get("html_url"),
                   repo_url=f"https://github.com/{owner}/{repo}", artifacts_published=[asset], artifact=asset)
    raise GitToolError(f"Ferramenta GitHub desconhecida: {name}.")


def execute(name, args, ctx):
    try:
        if name.startswith("git_"):
            return _local_tool(name, args or {}, ctx)
        if name.startswith("github_"):
            return _github_tool(name, args or {}, ctx)
        return _err(f"Ferramenta Git/GitHub desconhecida: {name}.")
    except github.GitHubError as exc:
        return _err(str(exc), status=exc.status)
    except GitToolError as exc:
        return _err(str(exc))
    except (OSError, ValueError, TypeError, subprocess.SubprocessError) as exc:
        detail = github.redact(str(exc), _token_for_redaction())
        return _err(f"Falha ao executar {name} ({type(exc).__name__}): {detail}. Confira os argumentos, o estado "
                    "do projeto e a conexão GitHub. Nenhum fallback inseguro foi usado.")
