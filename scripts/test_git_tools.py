"""Offline tests for native Git/GitHub tools; all Git repositories are temporary."""
import os
import subprocess
import sys
import tempfile
from types import SimpleNamespace
from unittest.mock import patch

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import agent_mode, code_tools, github, git_tools


TOKEN = "test-token-that-must-never-reach-the-model-0123456789"
SHA = "0123456789abcdef0123456789abcdef01234567"


def check(condition, message):
    if not condition:
        raise AssertionError(message)
    print("  OK", message)


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, encoding="utf-8",
                          check=True).stdout.strip()


def call(name, args, ctx):
    result = git_tools.execute(name, args, ctx)
    if result["is_error"]:
        raise AssertionError(f"{name} falhou: {result['output']}")
    return result


class FakeStore:
    def get(self, key=github.SERVICE):
        return "ceu-test-user" if key == github.ACCOUNT_SERVICE else TOKEN

    def set(self, value, key=github.SERVICE):
        return None

    def delete(self, key=github.SERVICE):
        return None


class FakeGitHubClient:
    def __init__(self):
        self.calls = []

    def create_repo(self, name, private=True, description=""):
        self.calls.append(("create_repo", name, private))
        return {"id": 8, "name": name, "full_name": "ceu-test-user/" + name, "private": private,
                "html_url": "https://github.com/ceu-test-user/" + name,
                "clone_url": "https://github.com/ceu-test-user/" + name + ".git",
                "default_branch": "main"}

    def get_repo(self, owner, repo):
        self.calls.append(("get_repo", owner, repo))
        return {"full_name": owner + "/" + repo, "html_url": f"https://github.com/{owner}/{repo}", "private": True}

    def create_release(self, owner, repo, tag, name, body, target_commitish="", draft=False, prerelease=False):
        self.calls.append(("create_release", owner, repo, tag, target_commitish, prerelease))
        return {"id": 9, "tag_name": tag, "name": name, "html_url": f"https://github.com/{owner}/{repo}/releases/tag/{tag}",
                "draft": draft, "prerelease": prerelease}

    def get_release_by_tag(self, owner, repo, tag):
        self.calls.append(("get_release_by_tag", owner, repo, tag))
        return {"id": 9, "tag_name": tag, "html_url": f"https://github.com/{owner}/{repo}/releases/tag/{tag}"}

    def upload_asset(self, owner, repo, release_id, file_path, name, content_type, cancel=None):
        self.calls.append(("upload_asset", owner, repo, release_id, name, content_type))
        return {"id": 10, "name": name, "size": os.path.getsize(file_path), "content_type": content_type,
                "browser_download_url": f"https://github.com/{owner}/{repo}/releases/download/v0.2.0-rc.1/{name}"}


def main():
    with tempfile.TemporaryDirectory(prefix="ceu-git-tools-") as root:
        ctx = SimpleNamespace(root=root, turn_id="test", cancel=None)
        detected = call("git_detect", {}, ctx)
        check(detected["meta"]["installed"] and not detected["meta"]["is_repository"],
              "detecta Git instalado e pasta sem repositório")

        initialized = call("git_init", {}, ctx)
        check(initialized["meta"]["branch"] == "main", "inicializa branch main na raiz escolhida")
        git(root, "config", "user.name", "Teste CEU")
        git(root, "config", "user.email", "ceu-tests@example.invalid")
        with open(os.path.join(root, "untracked.txt"), "w", encoding="utf-8") as f:
            f.write("não staged\n")
        untracked = call("git_status", {}, ctx)["meta"]
        check(any(c["path"] == "untracked.txt" and c["index_status"] == "?" for c in untracked["changes"]),
              "status distingue arquivo não rastreado")
        os.remove(os.path.join(root, "untracked.txt"))
        with open(os.path.join(root, "README.md"), "w", encoding="utf-8") as f:
            f.write("versão inicial\n")
        staged = call("git_add", {"paths": ["README.md"]}, ctx)
        check(staged["meta"]["changed"] == 1, "adiciona arquivo ao index")
        diff = call("git_diff", {"staged": True}, ctx)
        check("versão inicial" in diff["output"], "diff staged retorna patch")
        commit = call("git_commit", {"message": "chore: commit de teste"}, ctx)
        check(len(commit["meta"]["commit_sha"]) == 40, "commit devolve SHA completo")
        check(call("git_status", {}, ctx)["meta"]["clean"], "status reporta árvore limpa após commit")
        check(call("git_log", {"count": 5}, ctx)["meta"]["commits"][0]["sha"] == commit["meta"]["commit_sha"],
              "log devolve SHA e assunto estruturados")

        call("git_branch", {"action": "create", "name": "release-test"}, ctx)
        check("release-test" in call("git_branch", {"action": "list"}, ctx)["meta"]["branches"],
              "cria e lista branch")
        call("git_branch", {"action": "switch", "name": "release-test"}, ctx)
        check(call("git_branch", {"action": "list"}, ctx)["meta"]["current"] == "release-test",
              "troca branch atual")
        call("git_branch", {"action": "switch", "name": "main"}, ctx)
        call("git_branch", {"action": "delete", "name": "release-test"}, ctx)

        call("git_tag", {"action": "create", "name": "v0.2.0-rc.1", "message": "Release de teste"}, ctx)
        check("v0.2.0-rc.1" in call("git_tag", {"action": "list"}, ctx)["meta"]["tags"], "cria e lista tag anotada")
        call("git_tag", {"action": "delete", "name": "v0.2.0-rc.1"}, ctx)
        with patch("server.git_tools.github.credential_store", return_value=FakeStore()):
            remote = call("git_remote", {"action": "set", "name": "origin",
                                          "url": "https://github.com/ceu-test-user/projeto.git"}, ctx)
            check(remote["meta"]["remotes"][0]["fetch_url"].endswith("projeto.git"), "configura e lista remote HTTPS limpo")
            rejected = git_tools.execute("git_remote", {"action": "set", "name": "origin",
                                                          "url": "https://user:secret@github.com/conta/repo.git"}, ctx)
            check(rejected["is_error"] and "credenciais" in rejected["output"].lower() and
                  "secret" not in rejected["output"], "recusa URL de remote com credenciais embutidas")
            generic_remote = call("git_remote", {"action": "set", "name": "origin",
                                                    "url": "https://git.example/team/projeto.git"}, ctx)
            check(generic_remote["meta"]["remotes"][0]["fetch_url"] ==
                  "https://git.example/team/projeto.git", "configura remote HTTPS de qualquer servidor Git")

        outside = git_tools.execute("git_add", {"paths": ["../fora.txt"]}, ctx)
        check(outside["is_error"] and "fora da pasta" in outside["output"], "recusa pathspec fora do projeto")
        nested = os.path.join(root, "subpasta")
        os.makedirs(nested)
        nested_result = git_tools.execute("git_init", {}, SimpleNamespace(root=nested, turn_id="test", cancel=None))
        check(nested_result["is_error"] and "repositório" in nested_result["output"],
              "recusa criar repositório aninhado fora da raiz concedida")

        fake = FakeGitHubClient()
        with patch("server.git_tools._github_client", return_value=fake), \
             patch("server.git_tools.github.credential_store", return_value=FakeStore()):
            created = call("github_create_repo", {"name": "projeto"}, ctx)
            check(created["meta"]["repo_url"] == "https://github.com/ceu-test-user/projeto",
                  "cria repositório por cliente remoto falso")
            check(fake.calls[0] == ("create_repo", "projeto", True), "repo de teste fica privado quando private é omitido")
            queried = call("github_get_repo", {"owner": "ceu-test-user", "repo": "projeto"}, ctx)
            check(queried["meta"]["repository"]["full_name"] == "ceu-test-user/projeto", "consulta repo via cliente falso")
            release = call("github_create_release", {"owner": "ceu-test-user", "repo": "projeto",
                                                         "tag": "v0.2.0-rc.1", "prerelease": True}, ctx)
            check(release["meta"]["release_url"].endswith("v0.2.0-rc.1"), "cria release sem rede")
            artifact = os.path.join(root, "ceu-setup.exe")
            with open(artifact, "wb") as f:
                f.write(b"test installer bytes")
            uploaded = call("github_upload_asset", {"owner": "ceu-test-user", "repo": "projeto",
                                                        "tag": "v0.2.0-rc.1", "path": "ceu-setup.exe"}, ctx)
            check(uploaded["meta"]["artifacts_published"][0]["name"] == "ceu-setup.exe",
                  "anexa artefato usando upload falso")

            push_calls = []
            push_url = ["https://attacker.example/coletor.git"]

            def fake_git(_root, args, **kwargs):
                args = list(args)
                push_calls.append((args, kwargs))
                if args == ["rev-parse", "--show-toplevel"]:
                    return 0, root, ""
                if args == ["remote", "get-url", "origin"]:
                    return 0, "https://github.com/ceu-test-user/projeto.git", ""
                if args == ["remote", "get-url", "--push", "--all", "origin"]:
                    return 0, push_url[0], ""
                if args[0] == "check-ref-format":
                    return 0, "", ""
                if args == ["rev-parse", "--verify", "refs/heads/v0.2.0-rc.1^{commit}"]:
                    return 1, "", ""
                if args == ["rev-parse", "--verify", "refs/tags/v0.2.0-rc.1^{commit}"]:
                    return 0, SHA, ""
                if args[0] == "push":
                    return 0, "", ""
                raise AssertionError("Unexpected git in push test: " + repr(args))

            with patch("server.git_tools._run_git", side_effect=fake_git):
                blocked = git_tools.execute("github_push", {"remote": "origin", "ref": "v0.2.0-rc.1"}, ctx)
                check(blocked["is_error"] and not any(pair[0][0] == "push" for pair in push_calls),
                      "recusa pushurl apontando para outro host antes de executar Git")
                push_url[0] = "https://github.com/outra-conta/outro-repo.git"
                mismatched = git_tools.execute("github_push", {"remote": "origin", "ref": "v0.2.0-rc.1"}, ctx)
                check(mismatched["is_error"] and "destino efetivo de push" in mismatched["output"] and
                      not any(pair[0][0] == "push" for pair in push_calls),
                      "recusa pushurl de outro repositório GitHub antes de executar Git")
                push_url[0] = "https://github.com/ceu-test-user/projeto.git"
                pushed = call("github_push", {"remote": "origin", "ref": "v0.2.0-rc.1"}, ctx)
            push = next(pair for pair in push_calls if pair[0][0] == "push")
            check(pushed["meta"]["commit_sha"] == SHA and pushed["meta"]["tag"] == "v0.2.0-rc.1",
                  "push retorna SHA, tag, remote e URL com executor falso")
            check(push[1]["with_github_auth"] and push[1]["secret"] == TOKEN,
                  "push usa helper CEU autenticado sem publicar de verdade")
            check(push[1]["disable_hooks"], "push nativo não executa hooks do projeto com acesso à credencial")
            check(TOKEN not in pushed["output"] and TOKEN not in repr(pushed["meta"]),
                  "segredo nunca aparece no resultado estruturado")

            captured = {}

            def fake_subprocess(command, **_kwargs):
                hooks_path = command[2].split("=", 1)[1]
                captured.update(command=command, empty_hooks=os.path.isdir(hooks_path) and not os.listdir(hooks_path))
                return subprocess.CompletedProcess(command, 0, "", "")

            with patch("server.git_tools._git_exe", return_value="git"), \
                 patch("server.git_tools.subprocess.run", side_effect=fake_subprocess):
                git_tools._run_git(root, ["push"], disable_hooks=True)
            check(captured["command"][1] == "-c" and
                  captured["command"][2].startswith("core.hooksPath=") and captured["empty_hooks"],
                  "runner aplica um core.hooksPath temporário e vazio no push")

        with patch("server.git_tools.github.credential_store", return_value=FakeStore()):
            removed = call("git_remote", {"action": "remove", "name": "origin"}, ctx)
            check(not removed["meta"]["remotes"], "remove remote funciona após aprovação")

        helper = github.credential_helper("protocol=https\nhost=github.com\n\n", lambda: TOKEN)
        check("password=" + TOKEN in helper and github.credential_helper(
            "protocol=https\nhost=example.com\n\n", lambda: TOKEN) == "", "helper só atende HTTPS de github.com")

        safe_summary = git_tools.summary("git_remote", {"action": "set", "name": "origin",
                                                         "url": f"https://user:{TOKEN}@github.com/a/b.git"})
        check(TOKEN not in safe_summary and "https://github.com/a/b.git" in safe_summary,
              "resumo de aprovação mostra o destino sem credenciais")
        plan_names = {x["name"] for x in code_tools.tools_for("plan")}
        check("git_status" in plan_names and "git_commit" not in plan_names, "modo plan expõe somente leitura Git")
        check(code_tools.needs_approval("git_commit", {}, "manual", []) == "git_write" and
              code_tools.needs_approval("github_push", {}, "accept_edits", []) == "github_publish",
              "Code pede aprovação para mutação Git e publicação mesmo em accept_edits")
        agent_tools = {x["name"] for x in agent_mode.tools_for({"kind": "agent"},
                                                               {"host_folder": root, "rules": {}}, None)}
        check("host_git_status" in agent_tools and "host_github_create_repo" in agent_tools,
              "agente recebe ferramentas Git/GitHub no computador concedido")

    print("Git/GitHub tools: todos os testes passaram; nenhuma operação remota real foi executada.")


if __name__ == "__main__":
    main()
