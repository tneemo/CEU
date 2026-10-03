"""Isolated WSL2 distro used to run model-generated code.

The distro (`ceu-sandbox`) is separate from the user's own WSL distros: it's
imported fresh from an official Ubuntu rootfs, never copied from the user's
personal distro, so nothing of the user's `$HOME` ends up inside it. It has no
access to the Windows filesystem (`automount` disabled in `/etc/wsl.conf`) —
the only way files move in or out is a tar stream over stdin/stdout, built and
extracted by `run()` below, scoped to a single conversation's workspace
directory.

This is real VM-level isolation (WSL2 runs its own Linux kernel), which is a
meaningful boundary compared to a bare subprocess — but it is not a hardened
security sandbox (no gVisor/Firecracker-style syscall filtering), and network
access from inside the distro is not blocked. Treat it as "safe from an
accidental `rm -rf /` or an infinite loop", not as "safe to run code from an
untrusted stranger".
"""
import io
import os
import subprocess
import tarfile
import threading
import urllib.request

DISTRO = os.environ.get("CEU_SANDBOX_DISTRO", "ceu-sandbox")
ROOTFS_URL = "https://cloud-images.ubuntu.com/wsl/releases/24.04/current/ubuntu-noble-wsl-amd64-wsl.rootfs.tar.gz"
INSTALL_DIR = os.environ.get(
    "CEU_SANDBOX_DIR",
    os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "CEU", "sandbox"),
)
MEM_LIMIT_KB = 2_000_000  # ~2GB virtual memory ceiling per run, best-effort via ulimit

_lock = threading.Lock()
_ready = False


class SandboxError(Exception):
    pass


def _decode_wsl_output(raw):
    # wsl.exe writes UTF-16LE (with or without a BOM) whenever stdout is redirected/piped,
    # regardless of console code page.
    body = raw[2:] if raw[:2] == b"\xff\xfe" else raw
    try:
        return body.decode("utf-16-le")
    except UnicodeDecodeError:
        return raw.decode("utf-8", errors="ignore")


def _distros():
    out = subprocess.run(["wsl.exe", "--list", "--quiet"], capture_output=True, timeout=15)
    text = _decode_wsl_output(out.stdout)
    return {line.strip().replace("\x00", "") for line in text.splitlines() if line.strip()}


def _wsl(*args, input_bytes=None, timeout=60, user="sandbox"):
    return subprocess.run(["wsl.exe", "-d", DISTRO, "-u", user, "--", *args],
                          input=input_bytes, capture_output=True, timeout=timeout)


def ensure_ready():
    """Idempotent. Returns a human-readable notice the first time it provisions
    the distro (slow: downloads + installs), otherwise None."""
    global _ready
    if _ready:
        return None
    with _lock:
        if _ready:
            return None
        if DISTRO in _distros():
            _ready = True
            return None
        _provision()
        _ready = True
        return "Preparando o sandbox de execução de código pela primeira vez (pode levar alguns minutos)…"


def _provision():
    os.makedirs(INSTALL_DIR, exist_ok=True)
    tar_path = os.path.join(INSTALL_DIR, "rootfs.tar.gz")
    try:
        urllib.request.urlretrieve(ROOTFS_URL, tar_path)
        subprocess.run(["wsl.exe", "--import", DISTRO, INSTALL_DIR, tar_path, "--version", "2"],
                       check=True, timeout=300)
    finally:
        if os.path.exists(tar_path):
            os.remove(tar_path)
    setup = (
        "set -e\n"
        "printf '[automount]\\nenabled=false\\n[boot]\\nsystemd=false\\n"
        "[interop]\\nappendWindowsPath=false\\nenabled=false\\n' > /etc/wsl.conf\n"
        "id -u sandbox >/dev/null 2>&1 || useradd -m -s /bin/bash sandbox\n"
        "apt-get update -qq\n"
        "DEBIAN_FRONTEND=noninteractive apt-get install -qq -y python3 python3-pip python3-venv >/dev/null\n"
        "pip3 install --break-system-packages -q python-docx openpyxl reportlab fpdf2 pillow pandas\n"
    )
    proc = subprocess.run(["wsl.exe", "-d", DISTRO, "-u", "root", "--", "bash", "-lc", setup],
                         capture_output=True, timeout=900)
    if proc.returncode != 0:
        raise SandboxError("Falha ao preparar o sandbox: " + proc.stderr.decode("utf-8", errors="replace"))
    subprocess.run(["wsl.exe", "--shutdown"], timeout=30)


def _setup(tar_bytes, code, script):
    """Recreates /home/sandbox/work, extracts the tarred workspace into it and writes
    the code file. Returns None on success, or a diagnostic string on failure."""
    steps = [
        # chmod first: a previous round's files may have landed non-writable (e.g. after
        # round-tripping permission bits through the host filesystem), which would make a
        # plain `rm -rf` fail and wedge every future run.
        (["bash", "-lc", "chmod -R u+rwX /home/sandbox/work 2>/dev/null; rm -rf /home/sandbox/work"], None, 10),
        (["mkdir", "-p", "/home/sandbox/work"], None, 10),
        (["bash", "-lc", "tar -xf - -C /home/sandbox/work"], tar_bytes, 30),
        (["bash", "-lc", f"cat > {script}"], code.encode("utf-8"), 10),
    ]
    for args, data, timeout in steps:
        try:
            proc = _wsl(*args, input_bytes=data, timeout=timeout)
        except subprocess.TimeoutExpired:
            return f"comando '{' '.join(args)}' expirou"
        if proc.returncode != 0:
            return f"comando '{' '.join(args)}' falhou: {proc.stderr.decode('utf-8', errors='replace')}"
    check = _wsl("test", "-f", script, timeout=10)
    if check.returncode != 0:
        return f"“{script}” não foi criado no sandbox."
    return None


def _sane_mode(tarinfo):
    """Normalizes permission bits when crossing the Windows<->Linux tar boundary.
    Round-tripping a directory's real (often odd, sometimes non-writable) Windows
    stat mode through tar can leave it non-writable on either side; every entry
    gets a fixed, always-writable-by-owner mode instead of whatever the source
    filesystem reported."""
    tarinfo.mode = 0o755 if tarinfo.isdir() else 0o644
    tarinfo.uid = tarinfo.gid = 0
    tarinfo.uname = tarinfo.gname = ""
    return tarinfo


def run(code, language, timeout, workspace_dir):
    """Runs `code` inside the sandbox with `workspace_dir`'s contents as cwd.
    Files created/changed end up copied back into `workspace_dir`. Returns
    {"stdout", "stderr", "exit_code", "timed_out"}."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        tar.add(workspace_dir, arcname=".", filter=_sane_mode)
    tar_bytes = buf.getvalue()

    ext = "py" if language == "python" else "sh"
    runner = "python3" if language == "python" else "bash"
    script = f"/home/sandbox/work/__code__.{ext}"

    problem = _setup(tar_bytes, code, script)
    if problem:
        problem = _setup(tar_bytes, code, script)  # transient WSL hiccups (e.g. cold boot) resolve on a retry
    if problem:
        return {"stdout": "", "stderr": f"Falha ao preparar o sandbox: {problem}", "exit_code": -1, "timed_out": False}

    cmd = (f"cd /home/sandbox/work && ulimit -v {MEM_LIMIT_KB} 2>/dev/null; "
          f"timeout {int(timeout)}s {runner} {script}")
    try:
        proc = _wsl("bash", "-lc", cmd, timeout=timeout + 10)
        stdout = proc.stdout.decode("utf-8", errors="replace")
        stderr = proc.stderr.decode("utf-8", errors="replace")
        exit_code = proc.returncode
        timed_out = exit_code == 124
    except subprocess.TimeoutExpired:
        stdout, stderr, exit_code, timed_out = "", "", -1, True

    tarred = _wsl("bash", "-lc", "rm -f /home/sandbox/work/__code__.* && tar -cf - -C /home/sandbox/work .",
                 timeout=30)
    if tarred.returncode == 0 and tarred.stdout:
        with tarfile.open(fileobj=io.BytesIO(tarred.stdout), mode="r") as tar:
            tar.extractall(workspace_dir, filter=lambda ti, _p: _sane_mode(ti))

    return {"stdout": stdout, "stderr": stderr, "exit_code": exit_code, "timed_out": timed_out}
