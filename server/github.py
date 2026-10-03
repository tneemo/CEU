"""GitHub connection and REST client for CEU.

Credentials live in the operating system's secret store. This module never writes a
credential to SQLite, a project directory, a URL, or a subprocess argument.
"""
import ctypes
import http.client
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.github.com"
API_VERSION = "2026-03-10"
SERVICE = "CEU/GitHub"
ACCOUNT_SERVICE = "CEU/GitHub/account"
MAX_ASSET_SIZE = 2 * 1024 * 1024 * 1024


class GitHubError(Exception):
    def __init__(self, message, status=502):
        super().__init__(message)
        self.status = status


class WindowsCredentialStore:
    """Small stdlib wrapper over Windows Credential Manager generic credentials."""

    CRED_TYPE_GENERIC = 1
    CRED_PERSIST_LOCAL_MACHINE = 2
    ERROR_NOT_FOUND = 1168

    class _FileTime(ctypes.Structure):
        _fields_ = [("dwLowDateTime", ctypes.c_uint32), ("dwHighDateTime", ctypes.c_uint32)]

    class _Credential(ctypes.Structure):
        pass

    _Credential._fields_ = [
        ("Flags", ctypes.c_uint32), ("Type", ctypes.c_uint32), ("TargetName", ctypes.c_wchar_p),
        ("Comment", ctypes.c_wchar_p), ("LastWritten", _FileTime), ("CredentialBlobSize", ctypes.c_uint32),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)), ("Persist", ctypes.c_uint32),
        ("AttributeCount", ctypes.c_uint32), ("Attributes", ctypes.c_void_p),
        ("TargetAlias", ctypes.c_wchar_p), ("UserName", ctypes.c_wchar_p),
    ]

    def __init__(self):
        if os.name != "nt":
            raise GitHubError("O Credential Manager do Windows não está disponível neste sistema.", 503)
        self._api = ctypes.WinDLL("Advapi32", use_last_error=True)
        self._api.CredWriteW.argtypes = [ctypes.POINTER(self._Credential), ctypes.c_uint32]
        self._api.CredWriteW.restype = ctypes.c_int
        self._api.CredReadW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32,
                                        ctypes.POINTER(ctypes.POINTER(self._Credential))]
        self._api.CredReadW.restype = ctypes.c_int
        self._api.CredDeleteW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32]
        self._api.CredDeleteW.restype = ctypes.c_int
        self._api.CredFree.argtypes = [ctypes.c_void_p]
        self._api.CredFree.restype = None

    @staticmethod
    def _os_error(action):
        code = ctypes.get_last_error()
        return GitHubError(f"O Windows Credential Manager não conseguiu {action} a credencial (erro {code}).", 503)

    def get(self, key=SERVICE):
        out = ctypes.POINTER(self._Credential)()
        if not self._api.CredReadW(key, self.CRED_TYPE_GENERIC, 0, ctypes.byref(out)):
            code = ctypes.get_last_error()
            if code == self.ERROR_NOT_FOUND:
                return None
            raise self._os_error("ler")
        try:
            item = out.contents
            raw = ctypes.string_at(item.CredentialBlob, item.CredentialBlobSize)
            return raw.decode("utf-8")
        finally:
            self._api.CredFree(out)

    def set(self, value, key=SERVICE):
        raw = value.encode("utf-8")
        blob = (ctypes.c_ubyte * len(raw)).from_buffer_copy(raw)
        item = self._Credential()
        item.Flags = 0
        item.Type = self.CRED_TYPE_GENERIC
        item.TargetName = key
        item.Comment = "CEU GitHub authentication"
        item.CredentialBlobSize = len(raw)
        item.CredentialBlob = ctypes.cast(blob, ctypes.POINTER(ctypes.c_ubyte))
        item.Persist = self.CRED_PERSIST_LOCAL_MACHINE
        item.AttributeCount = 0
        item.Attributes = None
        item.TargetAlias = None
        item.UserName = "CEU"
        if not self._api.CredWriteW(ctypes.byref(item), 0):
            raise self._os_error("salvar")

    def delete(self, key=SERVICE):
        if not self._api.CredDeleteW(key, self.CRED_TYPE_GENERIC, 0):
            code = ctypes.get_last_error()
            if code != self.ERROR_NOT_FOUND:
                raise self._os_error("remover")


class KeyringCredentialStore:
    """Use only the platform keyring backend; never accept plaintext file backends."""

    def __init__(self):
        try:
            if sys.platform == "darwin":
                from keyring.backends.macOS import Keyring
            else:
                from keyring.backends.SecretService import Keyring
            self._keyring = Keyring()
            if not self._keyring.priority:
                raise RuntimeError("backend sem suporte")
        except Exception as exc:  # dependency, desktop keychain, or DBus session unavailable
            raise GitHubError(
                "O cofre seguro do sistema não está disponível. Instale as dependências do CEU e inicie uma sessão "
                "de usuário com o cofre do sistema desbloqueado. Nenhuma credencial foi salva.", 503
            ) from exc

    def get(self, key=SERVICE):
        try:
            return self._keyring.get_password(key, "CEU")
        except Exception as exc:
            raise GitHubError("Não foi possível ler a credencial do cofre seguro do sistema.", 503) from exc

    def set(self, value, key=SERVICE):
        try:
            self._keyring.set_password(key, "CEU", value)
        except Exception as exc:
            raise GitHubError("Não foi possível salvar no cofre seguro do sistema. Nenhuma credencial foi salva.", 503) from exc

    def delete(self, key=SERVICE):
        try:
            self._keyring.delete_password(key, "CEU")
        except Exception as exc:
            # Missing entry and unavailable vault are intentionally distinguished.
            if "password not found" not in str(exc).lower():
                raise GitHubError("Não foi possível remover a credencial do cofre seguro do sistema.", 503) from exc


_store = None


def credential_store():
    global _store
    if _store is None:
        _store = WindowsCredentialStore() if os.name == "nt" else KeyringCredentialStore()
    return _store


def _json_or_empty(data):
    if not data:
        return {}
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return {}


def redact(text, token=None):
    text = str(text or "")
    if token:
        text = text.replace(token, "[segredo ocultado]")
    # GitHub token prefixes are scrubbed as a second guard against accidental echo.
    return re.sub(r"\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b",
                  "[segredo GitHub ocultado]", text)


class GitHubClient:
    """Minimal injectable REST client. `opener` is replaceable by offline tests."""

    def __init__(self, token, opener=None, timeout=30):
        self._token = token
        self._opener = opener or urllib.request.urlopen
        self.timeout = timeout

    def request(self, method, path, body=None):
        url = API + path
        payload = json.dumps(body).encode("utf-8") if body is not None else None
        headers = {
            "Accept": "application/vnd.github+json", "Authorization": "Bearer " + self._token,
            "X-GitHub-Api-Version": API_VERSION, "User-Agent": "CEU",
        }
        if payload is not None:
            headers["Content-Type"] = "application/json; charset=utf-8"
        request = urllib.request.Request(url, data=payload, headers=headers, method=method)
        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw = response.read()
                return _json_or_empty(raw), dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            detail = _json_or_empty(exc.read())
            message = detail.get("message", "") if isinstance(detail, dict) else ""
            status = exc.code
            if status == 401:
                raise GitHubError("GitHub recusou a credencial. Reconecte com um token válido e as permissões "
                                  "necessárias.", 401) from None
            if status == 403 and (exc.headers.get("X-RateLimit-Remaining") == "0"):
                raise GitHubError("Limite da API do GitHub atingido. Aguarde a renovação do limite e tente de novo.", 429) from None
            if status == 403:
                hint = (" Verifique as permissões do token e a aprovação exigida pela organização." if
                        "resource not accessible" in str(message).lower() else "")
                raise GitHubError(redact(f"GitHub negou a ação (403): {message or 'permissão insuficiente'}.{hint}",
                                         self._token), 403) from None
            if status == 404:
                raise GitHubError("Repositório ou release não encontrado, ou o token não tem acesso a esse recurso.", 404) from None
            if status == 409:
                raise GitHubError(redact(f"GitHub informou conflito: {message or 'o recurso mudou; consulte o estado atual'}.",
                                         self._token), 409) from None
            if status == 422 and "user/repos" in path:
                raise GitHubError("Não foi possível criar o repositório. O nome pode já existir; escolha outro nome "
                                  "ou consulte github_get_repo. Confira Repository creation: write (ou Administration: "
                                  "write) no token.", 422) from None
            raise GitHubError(redact(f"A API do GitHub respondeu HTTP {status}: {message or 'erro sem detalhes'}.",
                                     self._token), 502) from None
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # Don't include the underlying exception: it can contain request internals.
            raise GitHubError(f"Não foi possível alcançar api.github.com ({type(exc).__name__}). Verifique a rede e "
                              "tente novamente.", 503) from None

    def get_user(self):
        data, _ = self.request("GET", "/user")
        if not data.get("login"):
            raise GitHubError("GitHub não retornou o perfil autenticado. Confira o token e tente novamente.", 502)
        return {"login": data["login"], "html_url": data.get("html_url")}

    def create_repo(self, name, private=True, description=""):
        data, _ = self.request("POST", "/user/repos", {
            "name": name, "private": bool(private), "description": description,
        })
        return self._repo(data)

    def get_repo(self, owner, repo):
        data, _ = self.request("GET", f"/repos/{urllib.parse.quote(owner, safe='')}/{urllib.parse.quote(repo, safe='')}")
        return self._repo(data)

    @staticmethod
    def _repo(data):
        return {key: data.get(key) for key in ("id", "name", "full_name", "private", "html_url", "clone_url",
                                                "ssh_url", "default_branch", "owner") if key in data}

    def create_release(self, owner, repo, tag, name, body, target_commitish="", draft=False, prerelease=False):
        payload = {"tag_name": tag, "name": name or tag, "body": body, "draft": bool(draft),
                   "prerelease": bool(prerelease)}
        if target_commitish:
            payload["target_commitish"] = target_commitish
        data, _ = self.request("POST", f"/repos/{urllib.parse.quote(owner, safe='')}/"
                                     f"{urllib.parse.quote(repo, safe='')}/releases", payload)
        return {key: data.get(key) for key in ("id", "tag_name", "name", "html_url", "draft", "prerelease", "assets")
                if key in data}

    def get_release_by_tag(self, owner, repo, tag):
        path = (f"/repos/{urllib.parse.quote(owner, safe='')}/{urllib.parse.quote(repo, safe='')}/releases/tags/"
                f"{urllib.parse.quote(tag, safe='')}")
        data, _ = self.request("GET", path)
        return {key: data.get(key) for key in ("id", "tag_name", "name", "html_url", "draft", "prerelease")
                if key in data}

    def upload_asset(self, owner, repo, release_id, file_path, name, content_type, cancel=None):
        size = os.path.getsize(file_path)
        if size > MAX_ASSET_SIZE:
            raise GitHubError("O instalador excede o limite GitHub de 2 GiB por artefato.", 413)
        owner_q, repo_q = urllib.parse.quote(owner, safe=""), urllib.parse.quote(repo, safe="")
        path = (f"/repos/{owner_q}/{repo_q}/releases/{int(release_id)}/assets?"
                f"name={urllib.parse.quote(name, safe='')}")
        conn = http.client.HTTPSConnection("uploads.github.com", timeout=max(self.timeout, 120),
                                            context=ssl.create_default_context())
        try:
            conn.putrequest("POST", path)
            conn.putheader("Accept", "application/vnd.github+json")
            conn.putheader("Authorization", "Bearer " + self._token)
            conn.putheader("X-GitHub-Api-Version", API_VERSION)
            conn.putheader("User-Agent", "CEU")
            conn.putheader("Content-Type", content_type)
            conn.putheader("Content-Length", str(size))
            conn.endheaders()
            with open(file_path, "rb") as handle:
                while True:
                    if cancel is not None and cancel.is_set():
                        raise GitHubError("Upload interrompido pelo usuário.", 499)
                    chunk = handle.read(1024 * 1024)
                    if not chunk:
                        break
                    conn.send(chunk)
            response = conn.getresponse()
            data = _json_or_empty(response.read())
            if response.status not in (200, 201):
                message = data.get("message", "") if isinstance(data, dict) else ""
                if response.status == 401:
                    raise GitHubError("GitHub recusou a credencial durante o upload. Reconecte o GitHub.", 401)
                if response.status == 403:
                    raise GitHubError("GitHub recusou o upload. Confirme Contents: write e o acesso ao repositório.", 403)
                if response.status == 404:
                    raise GitHubError("Release não encontrada ou o token não tem acesso ao repositório.", 404)
                raise GitHubError(redact(f"Falha no upload da release (HTTP {response.status}): "
                                         f"{message or 'erro sem detalhes'}.", self._token), 502)
            return {key: data.get(key) for key in ("id", "name", "label", "state", "content_type", "size",
                                                    "browser_download_url", "url") if key in data}
        except GitHubError:
            raise
        except (OSError, http.client.HTTPException, TimeoutError) as exc:
            raise GitHubError(f"A conexão do upload foi interrompida ({type(exc).__name__}). Verifique o estado da "
                              "release antes de tentar novamente.", 503) from None
        finally:
            conn.close()


def connect(token):
    """Validate first, then persist. A failed login never replaces a working credential."""
    token = (token or "").strip()
    if not token or any(ord(ch) < 32 or ord(ch) == 127 for ch in token):
        raise GitHubError("Cole um token GitHub válido. O valor não pode conter espaços de controle.", 400)
    store = credential_store()
    user = GitHubClient(token).get_user()
    try:
        store.set(token)
        store.set(user["login"], ACCOUNT_SERVICE)
    except Exception:
        try:
            store.delete()
            store.delete(ACCOUNT_SERVICE)
        except Exception:
            pass
        raise GitHubError("Não foi possível guardar a credencial no cofre seguro do sistema.", 503) from None
    return {"connected": True, "account": user["login"], "available": True,
            "detail": "Token validado e salvo no cofre seguro do sistema."}


def disconnect():
    store = credential_store()
    store.delete()
    store.delete(ACCOUNT_SERVICE)
    return {"connected": False, "account": None, "available": True, "detail": "GitHub desconectado."}


def validate():
    user = client().get_user()
    return {"connected": True, "account": user["login"], "available": True,
            "detail": "Credencial aceita pelo GitHub."}


def describe():
    try:
        store = credential_store()
        token = store.get()
        account = store.get(ACCOUNT_SERVICE) if token else None
        return {"connected": bool(token), "account": account or None, "available": True,
                "detail": "Token salvo no cofre seguro do sistema." if token else "Conecte uma conta GitHub."}
    except GitHubError as exc:
        return {"connected": False, "account": None, "available": False, "detail": str(exc)}


def client():
    token = credential_store().get()
    if not token:
        raise GitHubError("GitHub não está conectado. Abra Configurações → GitHub e conecte um token.", 401)
    return GitHubClient(token)


def credential_helper(input_text, get_token=None):
    """Implements Git's credential-helper protocol without writing secrets to disk."""
    fields = {}
    for line in (input_text or "").splitlines():
        if not line:
            continue
        key, sep, value = line.partition("=")
        if sep:
            fields[key] = value
    if fields.get("protocol") != "https" or fields.get("host", "").lower() not in ("github.com", "www.github.com"):
        return ""
    token = (get_token or (lambda: credential_store().get()))()
    if not token:
        return ""
    return "username=x-access-token\npassword=" + token + "\n\n"


def _reset_for_tests():
    global _store
    _store = None
