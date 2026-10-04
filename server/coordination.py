"""Coordination: one objective worked on by several executors (docs/coordenacao.md).

Three pieces on top of agents and their tasks (agent_mode.py):

- Calls placed by an agent. A call (calls.py) was something only the user asked for, with `@`.
  Here the agent places one with the `delegate` tool: a request goes to an executor — a Code session
  on the agent's granted folder, run by any enabled model on CEU's own loop or by an external
  harness (code_runtimes.py: Codex SDK, Claude SDK, a REDIR CLI) — in one of three roles:
  investigate and review (read-only), implement. A review is never done by a model that did or
  directed the work under review. The executor acts under the agent's authority: its reads, edits,
  commands and Git actions follow the agent's rules (`decision`), never more. The agent's turn waits
  for the executor and gets its report back as the tool result, approval cards on the way are
  forwarded to the agent's thread, and the call is recorded in agent_calls. The executor's session
  keeps the whole work (its origin is the agent's thread) and is reused by the next call with the
  same executor and role, so a reviewer remembers what it objected to.

- Issues: what the work is unsure about or still has to deal with — problems, hypotheses,
  contradictions, questions, leads, findings. Each records who raised it (the agent, an executor,
  the user), its state (open → resolved | discarded; a finding is just noted) and how it was closed.
  Executors raise them in a block at the end of their report (`QUESTÕES:`), parsed here, so a
  reviewer's objections reach the ledger as the reviewer wrote them, not as the agent summarised
  them. Only the agent or the user closes an issue, always saying how.

- Convergence. A task can be declared done only when none of its issues is open and, if its folder
  changed during the objective, an independent review approved exactly the folder's current content.
  The content is a `fingerprint` (path → blob hash of every file Git doesn't ignore), so committing
  doesn't change it and any edit — by an executor, the agent, the user or anyone else — does. When the
  review is all that's missing, the CEU asks for it itself as the agent declares the task done
  (`settle`): verification is part of the protocol, not something the agent has to remember or dare to do.
"""
import hashlib
import os
import re
import subprocess
import time

from . import calls, code_runtimes, code_tools, db, generation, git_tools

ROLES = {
    # role: (as the agent and people read it, the executor's permission mode; None = from the agent's rules)
    "investigate": ("investigação", "plan"),
    "implement": ("implementação", None),
    "review": ("revisão", "plan"),
}
KINDS = {
    "problem": "problema", "hypothesis": "hipótese", "contradiction": "contradição", "question": "pergunta",
    "lead": "pista", "finding": "achado",
}
_KIND_WORDS = {
    "problema": "problem", "problem": "problem", "bug": "problem", "erro": "problem",
    "hipotese": "hypothesis", "hipótese": "hypothesis", "hypothesis": "hypothesis",
    "contradicao": "contradiction", "contradição": "contradiction", "contradiction": "contradiction",
    "pergunta": "question", "duvida": "question", "dúvida": "question", "question": "question",
    "pista": "lead", "lead": "lead", "investigar": "lead",
    "achado": "finding", "descoberta": "finding", "finding": "finding",
}
STATUS_TEXT = {"open": "aberta", "noted": "registrada", "resolved": "resolvida", "discarded": "descartada"}

_REPORT_CHARS = 12000  # how much of an executor's report goes back to the agent
_DIFF_CHARS = 24000    # how much of the folder's diff a reviewer is briefed with
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0


# ---------------------------------------------------------------- executors

def _models():
    return [(p, m) for p in db.list_providers() if p["enabled"] for m in p["models"]]


def roster():
    """Who the agent can delegate to: [{"runtime", "name", "models": [(ref, label)], "default"}]. CEU's own
    loop takes any enabled model; an external harness, the models of the provider kinds it understands
    (or its own default model)."""
    models = _models()
    out = []
    for rt in code_runtimes.describe_cached():
        if rt["status"] != "ready":
            continue
        kinds = rt.get("model_kinds")
        names = {}
        mine = [(f"{p['id']}::{m['id']}", calls.label(f"{p['id']}::{m['id']}", names)) for p, m in models
                if kinds is None or p["kind"] in kinds]
        if kinds is None and not mine:
            continue
        out.append({"runtime": rt["id"], "name": rt["name"], "models": mine, "default": kinds is not None,
                    "modes": rt["modes"]})
    return out


def describe_roster():
    """The executors as the agent's system prompt lists them."""
    lines = []
    for r in roster():
        names = ", ".join(label for _ref, label in r["models"][:16]) or "nenhum modelo próprio"
        if r["runtime"] == code_runtimes.DEFAULT:
            lines.append(f"- Loop do CEU (ferramentas do Code do CEU): executor = o nome do modelo. Modelos: {names}.")
        else:
            lines.append(f"- {r['name']}: executor = \"{r['runtime']}\" (modelo padrão do harness) ou "
                         f"\"{r['runtime']}/<modelo>\". Modelos: {names}.")
    return "\n".join(lines)


def _norm(s):
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def resolve(spec):
    """An executor from what the agent wrote: "<modelo>" (CEU's loop), "<runtime>" or "<runtime>/<modelo>".
    Returns {"runtime", "model", "label", "modes"}; raises ValueError naming the options."""
    spec = (spec or "").strip()
    if not spec:
        raise ValueError("Diga qual executor chamar (veja a lista de executores).")
    entries = roster()
    by_runtime = {_norm(r["runtime"]): r for r in entries}
    by_runtime.update({_norm(r["name"]): r for r in entries})
    rt, model = None, spec
    if _norm(spec) in by_runtime and _norm(spec) != _norm(code_runtimes.DEFAULT):
        rt, model = by_runtime[_norm(spec)], ""
    elif "/" in spec and _norm(spec.split("/", 1)[0]) in by_runtime:
        head, model = spec.split("/", 1)
        rt = by_runtime[_norm(head)]
    if rt is None:
        rt = next((r for r in entries if r["runtime"] == code_runtimes.DEFAULT), None)
        if rt is None:
            raise ValueError("Nenhum executor disponível.")
    if not model:
        if not rt["default"]:
            raise ValueError(f"Escolha um modelo para {rt['name']}.")
        return {"runtime": rt["runtime"], "model": None, "label": rt["name"], "modes": rt["modes"]}
    want = _norm(model)
    exact = [(ref, label) for ref, label in rt["models"]
             if want in (_norm(ref), _norm(label), _norm(ref.split("::", 1)[1]))]
    found = exact or [(ref, label) for ref, label in rt["models"] if want in _norm(label)]
    if len(found) != 1:
        names = ", ".join(label for _r, label in rt["models"][:16])
        why = "é ambíguo" if found else "não foi encontrado"
        raise ValueError(f"O executor “{spec}” {why}. Em {rt['name']}: {names}.")
    ref, label = found[0]
    if rt["runtime"] != code_runtimes.DEFAULT:
        label = f"{rt['name']} · {label}"
    return {"runtime": rt["runtime"], "model": ref, "label": label, "modes": rt["modes"]}


def _identity(runtime, model):
    """Which model did the work, for the independence rule: the same model reached through another
    provider or harness is still the same model."""
    if model:
        return model.split("::", 1)[1].lower()
    return "harness:" + runtime


# ---------------------------------------------------------------- authority

def delegating_agent(conv):
    """The agent an executor session works for (its origin), or None for a session the user runs."""
    origin = (conv or {}).get("origin") or {}
    return db.get_agent(origin["agent_id"]) if origin.get("agent_id") and origin.get("role") else None


def action_of(name):
    """The agent action class a Code tool belongs to (agent_mode.ACTIONS)."""
    if name in code_tools.EDITS:
        return "host_edit"
    if name == "run_command":
        return "host_command"
    if name in git_tools.TOOLS_BY_NAME:
        if name in git_tools.READ_ONLY:
            return "host_git_read"
        return "host_github_publish" if name in git_tools.GITHUB_PUBLISH else "host_git_write"
    return "host_read"


def decision(agent, name):
    """(action, allow | ask | block) for an executor's tool call: the agent's own rule for that action."""
    from . import agent_mode
    action = action_of(name)
    return action, agent_mode.rules_of(agent)[action]


def implement_mode(agent):
    """The permission mode an implementing executor runs in, for harnesses that only know modes."""
    from . import agent_mode
    rules = agent_mode.rules_of(agent)
    if rules["host_edit"] == "allow":
        return "auto" if rules["host_command"] == "allow" else "accept_edits"
    return "manual"


def executor_note(conv):
    """What an executor session's system prompt adds (generation.code_system_prompt), or None."""
    origin = (conv or {}).get("origin") or {}
    role = origin.get("role")
    if role not in ROLES:
        return None
    text = (f"Você é um executor: o agente “{origin.get('agent_name') or 'do CEU'}” pediu a você uma "
            f"{ROLES[role][0]} dentro de um objetivo maior. Ele lê só o seu relatório final: faça o trabalho "
            "pedido e termine no formato que a mensagem pede (relatório, bloco QUESTÕES e, numa revisão, "
            "VEREDITO). Permissões: as que o usuário deu a esse agente; o que estiver em “perguntar” pausa até ele "
            "responder.")
    if role != "implement":
        text += (" Nesta chamada você não altera nada: nem arquivos nem o repositório, nem por comandos (não há "
                 "ferramentas de edição). Rodar comandos que só leem ou verificam (testes, build, lint, git log) é "
                 "permitido e faz parte do trabalho.")
    return text


# ---------------------------------------------------------------- folder content

def _git(folder, *args, data=None, timeout=60):
    try:
        r = subprocess.run([git_tools._git_exe(), *args], cwd=folder, input=data, capture_output=True,
                           timeout=timeout, creationflags=_NO_WINDOW)
    except (OSError, subprocess.SubprocessError, git_tools.GitToolError):
        return None
    return r.stdout if r.returncode == 0 else None


def _paths(raw):
    return [p for p in (raw or b"").decode("utf-8", "replace").split("\0") if p]


def fingerprint(folder):
    """A hash of the folder's content as Git sees it (every file it doesn't ignore), or None outside a
    repository. Staging or committing leaves it unchanged; editing, creating or deleting a file changes it.
    Nothing is written to the repository (hash-object without -w)."""
    if not folder or _git(folder, "rev-parse", "--is-inside-work-tree") is None:
        return None
    content = {}
    for line in (_git(folder, "ls-files", "-s", "-z") or b"").decode("utf-8", "replace").split("\0"):
        if "\t" in line:
            meta, path = line.split("\t", 1)
            content[path] = meta.split()[1]
    for path in _paths(_git(folder, "ls-files", "-d", "-z")):
        content.pop(path, None)
    touched = sorted(set(_paths(_git(folder, "diff", "--name-only", "-z"))) |
                     set(_paths(_git(folder, "ls-files", "-o", "--exclude-standard", "-z"))))
    touched = [p for p in touched if os.path.isfile(os.path.join(folder, p))]
    if touched:
        shas = (_git(folder, "hash-object", "--stdin-paths", data="\n".join(touched).encode()) or b"").split()
        for path, sha in zip(touched, shas):
            content[path] = sha.decode()
    digest = hashlib.sha256()
    for path in sorted(content):
        digest.update(f"{path}\0{content[path]}\n".encode("utf-8", "replace"))
    return digest.hexdigest()[:16]


def head(folder):
    raw = _git(folder, "rev-parse", "HEAD")
    return raw.decode().strip() if raw else None


def changes(folder, since=None):
    """What a reviewer is briefed with: the folder's state against the commit the objective started on
    (or HEAD), including new files. "" outside a repository."""
    if _git(folder, "rev-parse", "--is-inside-work-tree") is None:
        return ""
    base = since or "HEAD"
    parts = []
    status = (_git(folder, "status", "--short") or b"").decode("utf-8", "replace").strip()
    parts.append("git status --short:\n" + (status or "(nada pendente)"))
    if since and since != head(folder):
        log = (_git(folder, "log", "--oneline", f"{since}..HEAD") or b"").decode("utf-8", "replace").strip()
        if log:
            parts.append(f"Commits desde o início do objetivo:\n{log}")
    stat = (_git(folder, "diff", "--stat", base) or b"").decode("utf-8", "replace").strip()
    if stat:
        parts.append(f"git diff --stat {base[:12]}:\n{stat}")
    diff = (_git(folder, "diff", base) or b"").decode("utf-8", "replace")
    if diff.strip():
        cut = len(diff) > _DIFF_CHARS
        parts.append(f"git diff {base[:12]}" + (" (cortado: leia o resto com as suas ferramentas)" if cut else "")
                     + ":\n" + diff[:_DIFF_CHARS])
    return "\n\n".join(parts)


# ---------------------------------------------------------------- issues

def kind_of(word):
    w = _norm(word).strip("*_ ")
    return w if w in KINDS else _KIND_WORDS.get(w)


def add_issue(agent, task, kind, title, detail="", raised_by=None, call_id=None):
    """Records an issue; returns (issue, "new" | "same" | "reopened"). The same title as one of the objective's
    issues is the same issue: still open, nothing changes; already closed, it opens again — whoever raised it
    again (a reviewer, typically) says it isn't settled."""
    kind = kind_of(kind) or "problem"
    title = " ".join((title or "").split())[:200]
    if not title:
        raise ValueError("Dê um título à questão.")
    who = raised_by or agent["name"]
    key = _norm(title).rstrip(".")
    same = next((i for i in db.list_issues(agent["id"], task["id"]) if _norm(i["title"]).rstrip(".") == key),
                None) if task else None
    if same:
        if same["status"] in ("open", "noted") or kind == "finding":
            return same, "same"
        issue = db.update_issue(same["id"], {
            "status": "open", "closed_by": None,
            "resolution": f"Reaberta por {who}" + (f": {_clip(detail, 600)}" if detail else ".")
                          + (f" (antes: {_clip(same['resolution'], 400)})" if same.get("resolution") else "")})
        generation.bus.publish({"type": "agent", "agent_id": agent["id"]})
        return issue, "reopened"
    issue = db.create_issue(agent["id"], task["id"] if task else None, kind, title, (detail or "").strip()[:4000],
                            who, call_id, status="noted" if kind == "finding" else "open")
    generation.bus.publish({"type": "agent", "agent_id": agent["id"]})
    return issue, "new"


def issue_line(i, detail=False):
    line = f"- [{i['id']}] ({KINDS.get(i['kind'], i['kind'])}, {STATUS_TEXT.get(i['status'], i['status'])}) {i['title']}"
    line += f" — levantada por {i['raised_by']}"
    if i["detail"] and (detail or i["status"] == "open"):
        line += "\n  " + _clip(i["detail"], 900 if detail else 300)
    if i.get("resolution"):
        line += "\n  Resolução: " + _clip(i["resolution"], 600 if detail else 200)
    return line


def _clip(text, n):
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[:n - 1] + "…"


def issues_block(agent_id, task_id, closed=8):
    """The objective's ledger for a prompt: every open issue, then the most recently closed ones."""
    items = db.list_issues(agent_id, task_id)
    open_ = [i for i in items if i["status"] == "open"]
    rest = sorted((i for i in items if i["status"] != "open"), key=lambda i: i["updated_at"], reverse=True)[:closed]
    out = []
    if open_:
        out.append("Em aberto:\n" + "\n".join(issue_line(i) for i in open_))
    if rest:
        out.append("Fechadas recentemente:\n" + "\n".join(issue_line(i) for i in rest))
    return "\n".join(out)


_BLOCK = re.compile(r"^\s*[#>*_ ]*quest(?:õ|o)es\s*[*_]*\s*:?\s*[*_]*\s*$", re.I | re.M)
_ITEM = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+(.+)$")
_VERDICT = re.compile(r"veredito\s*[*_]*\s*:\s*[*_]*\s*([a-zçãõáéíóú ]+)", re.I)


def parse_report(text):
    """(issues [(kind, title, detail)], verdict approved | changes | None) from an executor's report."""
    text = text or ""
    verdict = None
    for m in _VERDICT.finditer(text):
        word = _norm(m.group(1))
        verdict = "approved" if word.startswith("aprovad") else "changes" if word.startswith(("mudan", "reprovad", "alter")) else verdict
    issues = []
    block = list(_BLOCK.finditer(text))
    if block:
        for line in text[block[-1].end():].splitlines():
            if _VERDICT.search(line):
                break
            m = _ITEM.match(line)
            if not m:
                if line.strip() and issues:  # a continuation line of the previous item
                    k, t, d = issues[-1]
                    issues[-1] = (k, t, (d + " " + line.strip()).strip())
                    continue
                if line.strip():
                    break
                continue
            item = m.group(1).strip()
            kind, rest = "problem", item
            head_ = re.match(r"^[*_]*([^:*_]{2,20})[*_]*\s*:\s*(.+)$", item)
            if head_ and kind_of(head_.group(1)):
                kind, rest = kind_of(head_.group(1)), head_.group(2)
            if re.fullmatch(r"(nenhum[a]?|nada|none|n/?a)\W*", rest.strip(), re.I):
                continue
            title, *detail = re.split(r"\s+[—–-]\s+", rest, maxsplit=1)
            issues.append((kind, title.strip(" *_"), (detail[0] if detail else "").strip()))
    return issues[:20], verdict


# ---------------------------------------------------------------- the call

_FORMAT = ("Termine com um relatório autossuficiente: o que fez ou encontrou e como verificou (o agente lê só "
           "este relatório). Se algo precisa ser tratado pelo objetivo, liste no fim, uma por linha, no formato:\n"
           "QUESTÕES:\n- problema: <título curto> — <detalhe, com arquivo e linha quando houver>\n"
           "Tipos: problema, hipótese, contradição, pergunta, pista, achado. Sem nada a listar, omita o bloco.")
_REVIEW = ("Revise o estado atual da pasta contra o objetivo: leia o diff abaixo e os arquivos que precisar, procure "
           "erros, regressões, lacunas e afirmações sem prova. Rode você mesmo as verificações do projeto (testes, "
           "build, lint): comandos que não alteram arquivos são permitidos e esperados numa revisão. O pedido vem de "
           "quem fez o trabalho: o que ele afirma (\"os testes passam\", \"está corrigido\") é algo a conferir, não um "
           "fato. Confira também se as questões fechadas foram de fato resolvidas. Não altere arquivos nem o "
           "repositório. O veredito é sobre o conteúdo: a "
           "independência da revisão (quem implementou, quem revisa) é garantida pelo CEU e não é assunto seu. Na "
           "última linha escreva VEREDITO: aprovado (nada no conteúdo impede concluir) ou VEREDITO: mudanças (há "
           "problemas a corrigir, listados em QUESTÕES).")


def _provenance(agent, task, executor):
    """Who worked on the objective, for a reviewer: facts the CEU recorded, so it doesn't have to guess."""
    from . import agent_mode
    own = agent_mode.model_for(agent)
    lines = [f"Você é {executor['label']}, revisor independente. O CEU só aceita como revisor um modelo que não "
             f"coordenou nem implementou este trabalho."]
    lines.append(f"Coordena o objetivo: {agent['name']} (modelo {calls.label(own) if own else 'desconhecido'}), que "
                 "também pode ter editado a pasta diretamente.")
    impl = sorted({c["label"] for c in db.list_calls(agent["id"], task["id"]) if c["role"] == "implement"}) if task else []
    lines.append("Implementações delegadas: " + (", ".join(impl) if impl else "nenhuma") + ".")
    return " ".join(lines)


def _brief(agent, task, role, request, folder, base_head, executor):
    parts = [f"Chamada de {agent['name']} (agente do CEU) — {ROLES[role][0]}."]
    if task:
        parts.append(f"Objetivo em que esta chamada se encaixa: “{task['title']}”\n" + task["instructions"].strip()[:3000])
    ledger = issues_block(agent["id"], task["id"]) if task else ""
    if ledger:
        parts.append("Questões do objetivo até agora:\n" + ledger)
    parts.append("Pedido:\n" + request.strip())
    if role == "investigate":
        parts.append("Investigue sem alterar nada (nem por comandos).")
    elif role == "implement":
        parts.append("Faça as mudanças que o pedido pede, seguindo as convenções do projeto, e verifique o que fez "
                     "(testes, build, o próprio programa) quando fizer sentido. Não faça commit, push nem publique "
                     "nada se o pedido não pedir explicitamente.")
    else:
        parts.append(_provenance(agent, task, executor) + "\n" + _REVIEW)
        diff = changes(folder, base_head)
        parts.append("Estado da pasta (calculado pelo CEU agora):\n" + (diff or "A pasta não é um repositório Git: "
                                                                        "inspecione os arquivos citados no pedido."))
    parts.append(_FORMAT)
    return "\n\n".join(parts)


def _session(origin_id, key, role):
    row = db.conn().execute(
        """SELECT id FROM conversations WHERE kind='code' AND deleted_at IS NULL
             AND json_extract(origin, '$.conversation_id')=? AND json_extract(origin, '$.executor')=?
             AND json_extract(origin, '$.role')=? ORDER BY updated_at DESC LIMIT 1""", (origin_id, key, role)).fetchone()
    return db.get_conversation(row["id"]) if row else None


def check_independent(agent, task, executor):
    """Raises ValueError when `executor` did or directed the work a review is about."""
    from . import agent_mode
    me = _identity(executor["runtime"], executor["model"])
    own = agent_mode.model_for(agent)
    if own and _identity("", own) == me:
        raise ValueError(f"{executor['label']} é o seu próprio modelo: quem dirige o trabalho não o revisa. "
                         "Escolha outro executor para a revisão.")
    if not task:
        return
    since = 0
    for c in db.list_calls(agent["id"], task["id"]):
        if c["role"] == "review" and c["verdict"] == "approved":
            since = c["created_at"]
    for c in db.list_calls(agent["id"], task["id"]):
        if c["role"] == "implement" and c["created_at"] >= since and _identity(c["runtime"], c["model"]) == me:
            raise ValueError(f"{executor['label']} implementou parte deste trabalho: a revisão precisa de outro "
                             "modelo. Escolha outro executor.")


def delegate(g, conv, agent, task, args, call_id):
    """The `delegate` tool: runs the request on an executor and waits for its report. Returns a tool result."""
    from . import agent_mode
    role = args.get("role") or "implement"
    if role not in ROLES:
        return _fail("role deve ser investigate, implement ou review.")
    request = (args.get("request") or "").strip()
    if not request:
        return _fail("Escreva o pedido para o executor.")
    folder = agent_mode.host_folder(agent)
    if not folder:
        return _fail("Delegar exige uma pasta concedida a você: os executores trabalham nela.")
    try:
        executor = resolve(args.get("executor"))
        if role == "review":
            check_independent(agent, task, executor)
    except ValueError as e:
        return _fail(str(e))
    mode = ROLES[role][1] or implement_mode(agent)
    if mode not in executor["modes"]:
        return _fail(f"{executor['label']} não roda no modo que esta chamada exige ({mode}). Escolha outro executor.")
    if task:
        baseline(task, agent)
        task = db.get_task(task["id"])
    base_head = ((task or {}).get("baseline") or {}).get("head")
    key = f"{executor['runtime']}|{executor['model'] or ''}"
    row = db.create_call(agent["id"], task["id"] if task else None, conv["id"], role, executor["runtime"],
                         executor["model"], executor["label"], request[:8000])
    before = fingerprint(folder) if role == "review" else None
    origin = {"conversation_id": conv["id"], "message_id": g.message_id, "title": task["title"] if task else agent["name"],
              "agent_id": agent["id"], "agent_name": agent["name"], "task_id": task["id"] if task else None,
              "role": role, "executor": key, "call_id": row["id"]}
    session = _session(conv["id"], key, role)
    if session and generation.active_for(session["id"]):
        db.update_call(row["id"], {"status": "error", "result": "executor ocupado", "finished_at": time.time()})
        return _fail(f"{executor['label']} ainda está trabalhando na chamada anterior.")
    if session:
        session = db.update_conversation(session["id"], {"origin": origin, "permission_mode": mode})
    else:
        title = f"{ROLES[role][0].capitalize()} · {executor['label']} · {origin['title']}"[:120]
        session = db.create_conversation(executor["model"], None, kind="code", project_path=folder,
                                         permission_mode=mode, runtime=executor["runtime"], title=title, origin=origin)
    user = db.create_message(session["id"], session["current_leaf_id"], "user",
                             content=_brief(agent, task, role, request, folder, base_head, executor))
    asst = generation.launch(session, user["id"], executor["model"], None)
    db.update_call(row["id"], {"conversation_id": session["id"], "message_id": asst["id"]})
    generation.bus.publish({"type": "conversation", "conversation_id": session["id"]})
    generation.bus.publish({"type": "agent", "agent_id": agent["id"]})
    g.push({"type": "tool_output", "call_id": call_id,
            "text": f"{executor['label']} começou ({ROLES[role][0]}) na sessão “{session['title']}”.\n"})
    final = _follow(g, asst["id"], call_id, executor["label"])
    return _finish(agent, task, row, executor, role, session, final, folder, before)


def _fail(text):
    return {"output": text, "is_error": True, "files": [], "meta": {}}


def _follow(g, mid, call_id, label):
    """Waits for the executor's turn, forwarding its approval cards to the agent's thread (answered there,
    the decision goes to the executor). Stopping the agent's turn stops the executor."""
    current, cursor = None, 0
    try:
        while True:
            if g.cancel.is_set():
                generation.stop(mid)
                for _ in range(50):
                    if db.get_message(mid)["status"] != "streaming":
                        break
                    time.sleep(0.1)
                return db.get_message(mid)
            t = generation.get(mid)
            if t is not current:
                current, cursor = t, 0
            if t:
                events, cursor, done = t.wait(cursor, timeout=1.0)
                for ev in events:
                    if ev["type"] == "approval":
                        req = dict(ev["request"], call_id=call_id, executor_call_id=ev["request"]["call_id"],
                                   executor=label)
                        g.forward = (call_id, t, ev["request"]["call_id"])
                        g.push({"type": "approval", "request": req})
                        generation.bus.publish({"type": "approval", "conversation_id": g.conversation_id,
                                                "message_id": g.message_id, "state": "pending"})
                    elif ev["type"] == "approval_done" and g.forward:
                        g.forward = None
                        g.push({"type": "approval_done", "call_id": call_id})
                if not done:
                    continue
            m = db.get_message(mid)
            if m["status"] != "streaming":
                return m
            time.sleep(0.3)
    finally:
        if g.forward:
            g.forward = None
            g.push({"type": "approval_done", "call_id": call_id})


def _finish(agent, task, row, executor, role, session, final, folder, before):
    status = final["status"] if final["status"] in ("complete", "error", "stopped") else "stopped"
    report = (final.get("content") or "").strip()
    patch = {"status": status, "result": report[:20000] or final.get("error"), "finished_at": time.time()}
    lines = []
    raised = []
    verdict = None
    if status == "complete":
        found, verdict = parse_report(report)
        for kind, title, detail in found:
            try:
                issue, how = add_issue(agent, task, kind, title, detail, executor["label"], row["id"])
            except ValueError:
                continue
            if how != "same":
                raised.append(dict(issue, how=how))
        if role == "review":
            after = fingerprint(folder)
            patch["verdict"] = verdict
            patch["fingerprint"] = before if before and before == after else None
            if verdict is None:
                lines.append("Veredito: não informado (a revisão não terminou com “VEREDITO: …”). Ela não conta "
                             "como aprovação.")
            else:
                lines.append("Veredito: " + ("aprovado." if verdict == "approved" else "mudanças necessárias."))
            if before and before != after:
                lines.append("A pasta mudou durante a revisão: esta aprovação não vale para o estado atual. Peça "
                             "outra revisão quando nada mais estiver mudando.")
    db.update_call(row["id"], patch)
    generation.bus.publish({"type": "agent", "agent_id": agent["id"]})
    head_ = f"{executor['label']} ({ROLES[role][0]}) "
    if status == "error":
        return {"output": head_ + "falhou: " + (final.get("error") or "erro desconhecido") +
                (f"\n\nO que produziu antes de falhar:\n{report[:_REPORT_CHARS]}" if report else ""),
                "is_error": True, "files": [], "meta": _meta(row, session, final, role, None)}
    if status == "stopped":
        return {"output": head_ + "foi interrompido antes de terminar." +
                (f"\n\nO que produziu até ali:\n{report[:_REPORT_CHARS]}" if report else ""),
                "is_error": True, "files": [], "meta": _meta(row, session, final, role, None)}
    out = head_ + "terminou. Relatório:\n" + (report[:_REPORT_CHARS] or "(vazio)")
    if len(report) > _REPORT_CHARS:
        out += "\n[relatório cortado; o restante está na sessão do executor]"
    if raised:
        out += "\n\nQuestões registradas a partir do relatório:\n" + "\n".join(
            f"- [{i['id']}] ({KINDS[i['kind']]}) {i['title']}" + (" — REABERTA: estava fechada" if i["how"] == "reopened" else "")
            for i in raised)
    if lines:
        out += "\n\n" + "\n".join(lines)
    return {"output": out, "is_error": False, "files": [], "meta": _meta(row, session, final, role, verdict, raised)}


def _meta(row, session, final, role, verdict, raised=()):
    return {"call": row["id"], "conversation_id": session["id"], "message_id": final["id"], "role": role,
            "executor": row["label"], "verdict": verdict, "issues": [i["id"] for i in raised]}


def pending_approvals(agent_id):
    """Approval cards executors of this agent are waiting on (they block the executor's turn)."""
    out = []
    for c in db.conn().execute("SELECT * FROM agent_calls WHERE agent_id=? AND status='running'", (agent_id,)):
        t = generation.get(c["message_id"]) if c["message_id"] else None
        if t and t.pending and not t.done:
            out.append({"id": "x" + c["id"], "kind": "executor", "conversation_id": c["conversation_id"],
                        "message_id": c["message_id"], "request": t.pending, "created_at": c["created_at"],
                        "where": c["label"]})
    return out


# ---------------------------------------------------------------- convergence

def baseline(task, agent):
    """Records where the folder stood when the objective started (once): its content and commit."""
    from . import agent_mode
    if task.get("baseline"):
        return
    folder = agent_mode.host_folder(agent)
    fp = fingerprint(folder) if folder else None
    if fp:
        db.update_task(task["id"], {"baseline": {"fingerprint": fp, "head": head(folder), "at": time.time()}})


def gate_reasons(task, agent):
    """What still keeps an objective from being done: [(code, text)], code "open" (issues still open) or
    "review" (the folder changed during the objective and no independent review approved its current content).
    Empty when nothing does. Research tasks and tasks that neither changed a folder nor used issues pass."""
    from . import agent_mode
    if not task or task.get("kind") == "research":
        return []
    reasons = []
    open_ = [i for i in db.list_issues(agent["id"], task["id"]) if i["status"] == "open"]
    if open_:
        reasons.append(("open", f"{len(open_)} questão(ões) em aberto: "
                        + "; ".join(f"[{i['id']}] {i['title']}" for i in open_[:6])
                        + ". Resolva ou descarte cada uma com resolve_issue (dizendo por quê)."))
    calls_ = db.list_calls(agent["id"], task["id"])
    approved = [c for c in calls_ if c["role"] == "review" and c["verdict"] == "approved" and c["status"] == "complete"]
    folder = agent_mode.host_folder(agent)
    base = (task.get("baseline") or {}).get("fingerprint")
    now_fp = fingerprint(folder) if folder and base else None
    if now_fp:
        if now_fp != base and not any(c["fingerprint"] == now_fp for c in approved):
            reasons.append(("review", "A pasta mudou durante o objetivo e nenhuma revisão independente aprovou o "
                                      "conteúdo atual dela."))
    else:
        last_impl = max((c["created_at"] for c in calls_ if c["role"] == "implement"), default=None)
        if last_impl and not any(c["created_at"] > last_impl for c in approved):
            reasons.append(("review", "Houve implementação depois da última revisão aprovada."))
    return reasons


def gate(task, agent):
    """Why the objective can't be declared done yet, as one text, or None."""
    return " ".join(text for _code, text in gate_reasons(task, agent)) or None


def pick_reviewer(agent, task):
    """An independent reviewer the CEU can call by itself: the one this objective already used (it remembers
    what it asked for), else another model of the agent's own provider, else any model on CEU's loop."""
    from . import agent_mode
    previous = [c for c in db.list_calls(agent["id"], task["id"]) if c["role"] == "review"] if task else []
    candidates = []
    for c in reversed(previous):
        spec = c["label"] if c["runtime"] == code_runtimes.DEFAULT else f"{c['runtime']}/{(c['model'] or '').split('::')[-1]}"
        candidates.append(spec.rstrip("/"))
    own = agent_mode.model_for(agent) or ""
    loop = next((r for r in roster() if r["runtime"] == code_runtimes.DEFAULT), {"models": []})
    mine = [ref for ref, _l in loop["models"] if own and ref.split("::")[0] == own.split("::")[0]]
    candidates += mine + [ref for ref, _l in loop["models"] if ref not in mine]
    for spec in candidates:
        try:
            executor = resolve(spec)
            check_independent(agent, task, executor)
            return executor
        except ValueError:
            continue
    return None


def settle(g, conv, agent, task, call_id):
    """Before an objective is declared done: when the only thing missing is the independent review, the CEU
    asks for it itself (the agent may have asked earlier, choosing the reviewer). Returns (still missing or
    None, what the review said or "", the review's tool-result meta or {})."""
    from . import agent_mode
    reasons = gate_reasons(task, agent)
    if [c for c, _t in reasons] != ["review"]:
        return (" ".join(t for _c, t in reasons) or None), "", {}
    if agent_mode.rules_of(agent)["delegate"] != "allow":
        return reasons[0][1] + " Peça uma revisão com delegate role=review.", "", {}
    executor = pick_reviewer(agent, task)
    if not executor:
        return reasons[0][1] + " Não há outro modelo disponível para revisar: peça ao usuário.", "", {}
    res = delegate(g, conv, agent, task, {
        "role": "review", "executor": executor["label"] if executor["runtime"] == code_runtimes.DEFAULT
        else f"{executor['runtime']}/{(executor['model'] or '').split('::')[-1]}".rstrip("/"),
        "request": "Revisão final pedida pelo CEU antes de dar o objetivo como concluído: confira se o estado atual "
                   "da pasta cumpre o objetivo por inteiro."}, call_id)
    return gate(db.get_task(task["id"]), agent), "Revisão final automática — " + res["output"], res.get("meta") or {}
