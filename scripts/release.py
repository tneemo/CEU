r"""Release do CEU: valida, sincroniza versão, gera builds e registra no Git.

Execute no PowerShell, a partir da raiz do projeto:

    .venv\Scripts\python scripts\release.py --version 0.2.0-rc.1

Antes do commit/tag, o workflow executa compileall, recuperação, lint, build web e
build Tauri. Qualquer falha restaura os arquivos de versão e não cria a release.
O push e a criação da GitHub Release são etapas posteriores e explícitas.
"""

import argparse
import json
import os
import re
import subprocess
import sys


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "web-app")
TAURI_CONF = os.path.join(APP, "src-tauri", "tauri.conf.json")
CARGO_TOML = os.path.join(APP, "src-tauri", "Cargo.toml")
CARGO_LOCK = os.path.join(APP, "src-tauri", "Cargo.lock")
PKG_JSON = os.path.join(APP, "package.json")
PKG_LOCK = os.path.join(APP, "package-lock.json")
VERSION_FILES = [TAURI_CONF, CARGO_TOML, CARGO_LOCK, PKG_JSON, PKG_LOCK]

RELEVANT = (
    "scripts/",
    "server/",
    "web/",
    "web-app/src/",
    "web-app/src-tauri/src/",
    "web-app/src-tauri/capabilities/",
    "web-app/src-tauri/icons/",
    "web-app/public/",
    "web-app/index.html",
    "web-app/vite.config.ts",
    "web-app/tsconfig",
    "requirements.txt",
    "start.bat",
)
IGNORED_FOR_RELEVANCE = {
    "web-app/src-tauri/tauri.conf.json",
    "web-app/src-tauri/Cargo.toml",
    "web-app/src-tauri/Cargo.lock",
    "web-app/package.json",
    "web-app/package-lock.json",
}
GITIGNORE_EXTRA = [
    "node_modules/",
    "web-app/dist/",
    "web-app/src-tauri/target/",
    "web-app/src-tauri/gen/schemas/",
    "*.log",
    ".claude/",
    "agent_id.txt",
]


class Fail(Exception):
    pass


def run(cmd, cwd=ROOT, check=True, capture=False, env=None):
    print("  $", cmd if isinstance(cmd, str) else " ".join(cmd), flush=True)
    result = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        encoding="utf-8",
        errors="replace",
        capture_output=capture,
        env=env,
    )
    if check and result.returncode != 0:
        detail = f"\n{result.stdout}{result.stderr}" if capture else ""
        rendered = cmd if isinstance(cmd, str) else " ".join(cmd)
        raise Fail(f"comando falhou ({result.returncode}): {rendered}{detail}")
    return result


def git(*args, check=True):
    return run(["git", *args], capture=True, check=check)


def current_version():
    with open(TAURI_CONF, encoding="utf-8") as handle:
        return json.load(handle)["version"]


def validate_version(value):
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-rc\.\d+)?", value):
        raise Fail(f"versão fora do formato X.Y.Z ou X.Y.Z-rc.N: {value!r}")
    return value


def wix_version(value):
    """Mapeia SemVer para os quatro inteiros aceitos pelo Windows MSI."""
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?", value)
    if not match:
        raise Fail(f"versão fora do formato suportado pelo MSI: {value!r}")
    build = int(match[4]) if match[4] is not None else 65535
    if build > 65535:
        raise Fail(f"número RC fora do limite do MSI (65535): {value!r}")
    return f"{match[1]}.{match[2]}.{match[3]}.{build}"


def bump_patch(value):
    match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", value)
    if not match:
        raise Fail(f"não é possível subir patch de uma versão pré-release sem --version: {value!r}")
    return f"{match[1]}.{match[2]}.{int(match[3]) + 1}"


def sync_version(new):
    """Reescreve somente os campos de versão, preservando o restante dos arquivos."""

    def substitute(path, pattern, replacement, count=1):
        with open(path, encoding="utf-8", newline="") as handle:
            text = handle.read()
        output, found = re.subn(pattern, replacement, text, count=count, flags=re.M)
        if found != count:
            relative = os.path.relpath(path, ROOT)
            raise Fail(f"não achei a versão em {relative} (esperava {count}, achei {found})")
        with open(path, "w", encoding="utf-8", newline="") as handle:
            handle.write(output)

    substitute(TAURI_CONF, r'^(\s*"version":\s*)"[^"]+"', rf'\g<1>"{new}"')
    substitute(
        TAURI_CONF,
        r'("wix":\s*\{\s*"version":\s*)"[^"]+"',
        rf'\g<1>"{wix_version(new)}"',
    )
    substitute(CARGO_TOML, r'^(version\s*=\s*)"[^"]+"', rf'\g<1>"{new}"')
    substitute(CARGO_LOCK, r'(name = "ceu"\r?\nversion = )"[^"]+"', rf'\g<1>"{new}"')
    substitute(PKG_JSON, r'^(\s*"version":\s*)"[^"]+"', rf'\g<1>"{new}"')
    substitute(PKG_LOCK, r'^(\s*"version":\s*)"[^"]+"', rf'\g<1>"{new}"', count=2)


def changed_paths(since_tag):
    paths = set()
    if since_tag:
        paths.update(git("diff", "--name-only", since_tag, "HEAD").stdout.splitlines())
    status = git("status", "--porcelain", "-uall").stdout
    for line in status.splitlines():
        if line.strip():
            path = line[3:].strip().strip('"')
            paths.add(path.split(" -> ")[-1])
    return {path.replace("\\", "/") for path in paths if path}


def relevant(paths):
    return sorted(path for path in paths if path not in IGNORED_FOR_RELEVANCE and path.startswith(RELEVANT))


def cmd_init(args):
    if os.path.isdir(os.path.join(ROOT, ".git")):
        print("Já é um repositório Git; nada a fazer.")
        return
    version = current_version()
    gitignore = os.path.join(ROOT, ".gitignore")
    lines = open(gitignore, encoding="utf-8").read().splitlines() if os.path.exists(gitignore) else []
    lines += [entry for entry in GITIGNORE_EXTRA if entry not in lines]
    with open(gitignore, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines) + "\n")
    run(["git", "init", "-b", "main"])
    if not git("config", "user.email", check=False).stdout.strip() or not git("config", "user.name", check=False).stdout.strip():
        raise Fail("configure git user.name e user.email antes de criar o commit-base")
    git("add", "-A")
    staged = git("diff", "--cached", "--name-only").stdout.splitlines()
    bad = [path for path in staged if path.startswith(("data/", ".venv/", "web-app/node_modules/", "web-app/dist/"))]
    if bad:
        raise Fail(f"arquivos que não deveriam ir para o repositório: {bad[:5]}")
    message = f"chore: commit-base do CEU v{version}"
    if args.trailer:
        message += f"\n\n{args.trailer}"
    git("commit", "-m", message)
    git("tag", "-a", f"v{version}", "-m", f"CEU v{version} (base)")
    print(f"Repositório criado: {len(staged)} arquivos, tag v{version}.")


def validate(args):
    print("\n[1/4] validação")
    python = sys.executable
    run([python, "-m", "compileall", "-q", "server", "scripts"])
    for script in ("test_startup.py", "test_calls.py", "test_coordination.py", "test_git_tools.py", "test_suggestion_language.py"):
        run([python, os.path.join("scripts", script)])
    if not args.skip_recovery:
        run([python, os.path.join("scripts", "verify_recovery.py"), "--real-db"])
    run(["node", os.path.join("scripts", "test_i18n.cjs")])
    npm = "npm.cmd" if os.name == "nt" else "npm"
    run([npm, "run", "lint"], cwd=APP)
    run([npm, "run", "build"], cwd=APP)


def build(args):
    print("\n[3/4] build de produção")
    npm = "npm.cmd" if os.name == "nt" else "npm"
    if args.skip_tauri:
        print("  Bundle Tauri omitido; frontend já compilado na validação.")
        return
    if os.environ.get("MSYSTEM"):
        raise Fail("rode do PowerShell, não do Git Bash: o link.exe do Git pode quebrar o build Tauri")
    env = os.environ.copy()
    env.setdefault("CARGO_TARGET_DIR", os.path.join(APP, "src-tauri", "target"))
    npx = "npx.cmd" if os.name == "nt" else "npx"
    bundles = ["--bundles", "nsis"] if os.name == "nt" else []
    run([npx, "tauri", "build", *bundles], cwd=APP, env=env)


def cmd_release(args):
    old = current_version()
    if args.dry_run:
        # Validation is useful on a clean checkout and with edited manifests too.
        # It must not require a new version/tag or silently skip documentation-only work.
        if args.version:
            validate_version(args.version)
        print(f"Validação local do CEU {old}; sem alterar versão, commit ou tag.")
        validate(args)
        build(args)
        print("\n--dry-run: validação concluída; nenhum commit/tag criado.")
        return
    if not os.path.exists(os.path.join(ROOT, ".git")):
        raise Fail("não é um repositório Git — rode `release.py init` primeiro")
    new = validate_version(args.version) if args.version else bump_patch(old)
    tag = f"v{new}"
    last = git("describe", "--tags", "--abbrev=0", "--match", "v*", check=False).stdout.strip() or None
    print(f"Versão atual {old} (última tag: {last or 'nenhuma'}) -> {new}")

    if git("rev-parse", "-q", "--verify", f"refs/tags/{tag}", check=False).returncode == 0:
        raise Fail(f"a tag {tag} já existe")
    if not git("branch", "--show-current").stdout.strip():
        raise Fail("HEAD solto (detached); faça checkout de um branch")
    lock = git("rev-parse", "--git-path", "index.lock", check=False).stdout.strip()
    if lock and os.path.exists(lock):
        raise Fail("há uma operação Git concorrente: index.lock existe")

    dirty = {
        line[3:].strip().strip('"').replace("\\", "/")
        for line in git("status", "--porcelain").stdout.splitlines()
        if line.strip()
    }
    touched = {os.path.relpath(path, ROOT).replace("\\", "/") for path in VERSION_FILES} & dirty
    if touched:
        raise Fail(f"arquivos de versão com mudança não commitada: {sorted(touched)} — commite antes")
    files = relevant(changed_paths(last))
    if not files:
        print("Nenhuma alteração de código relevante desde a última release; nada a fazer.")
        return
    print(f"{len(files)} arquivo(s) relevante(s) mudaram, ex.: {files[:5]}")

    validate(args)

    print(f"\n[2/4] versão {old} -> {new}")
    snapshots = {path: open(path, "rb").read() for path in VERSION_FILES}
    try:
        sync_version(new)
        build(args)
        print("\n[4/4] Git")
        git("add", "-A")
        message = f"release: {tag}"
        if args.trailer:
            message += f"\n\n{args.trailer}"
        git("commit", "-m", message)
        git("tag", "-a", tag, "-m", f"CEU {tag}")
    except BaseException:
        head_is_release = git("log", "-1", "--format=%s", check=False).stdout.strip() == f"release: {tag}"
        if head_is_release:
            git("reset", "--soft", "HEAD~1", check=False)
        for path, data in snapshots.items():
            with open(path, "wb") as handle:
                handle.write(data)
        git("reset", "-q", check=False)
        print("\nFalhou: arquivos de versão restaurados, sem commit/tag.", file=sys.stderr)
        raise

    short = git("rev-parse", "--short", "HEAD").stdout.strip()
    print(f"\nRelease {tag} registrada ({short}). Sem push — publique com `git push --follow-tags`.")
    target = os.path.abspath(os.environ.get("CARGO_TARGET_DIR") or os.path.join(APP, "src-tauri", "target"))
    bundle = os.path.join(target, "release", "bundle")
    if not args.skip_tauri and os.path.isdir(bundle):
        print(f"Instaladores em {bundle}")


def main():
    parser = argparse.ArgumentParser(description="Release do CEU")
    parser.add_argument("command", nargs="?", choices=["release", "init"], default="release")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-recovery", action="store_true")
    parser.add_argument("--skip-tauri", action="store_true")
    parser.add_argument("--version", help="versão RC ou estável (ex.: 0.2.0-rc.1)")
    parser.add_argument("--trailer", help="linha final das mensagens de commit")
    args = parser.parse_args()
    try:
        (cmd_init if args.command == "init" else cmd_release)(args)
    except Fail as error:
        print(f"\nERRO: {error}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
