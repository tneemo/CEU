r"""Teste ponta a ponta da coordenação (server/coordination.py): um agente conduz um objetivo com
executores de outros modelos, questões e o portão de conclusão.

Isolado como o test_calls: copia server/ para uma pasta temporária (banco novo lá dentro), sobe o
servidor do CEU num thread e usa um provedor falso compatível com a API da OpenAI que faz três papéis,
um por modelo — nenhum modelo real é chamado:

  Orquestra      o modelo do agente: segue um roteiro de chamadas de ferramenta (raise_issue, delegate,
                 resolve_issue, update_task) conforme o número de rodadas já feitas;
  Implementador  executor que corrige um bug num repositório Git temporário (write_file);
  Revisora       executora que revisa: na primeira vez pede mudanças (com uma questão), depois aprova.

    .venv\Scripts\python scripts\test_coordination.py

Cobre: delegação para um executor (sessão do Code com origem no agente), a autoridade do agente sobre
o executor (aprovação encaminhada ao fio da tarefa, "sempre permitir" virando regra do agente), a
regra de independência da revisão, questões vindas do relatório do executor, a reutilização da sessão
do revisor, o portão de conclusão (questões abertas, conteúdo da pasta revisado) e a continuação
automática de uma tarefa que termina sem cumprir o portão. Sai com código 0 se tudo passar.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODELS = [("orq", "Orquestra"), ("impl", "Implementador"), ("rev", "Revisora")]

BUGGY = "def soma(a, b):\n    return abs(a) + b\n"
FIXED = "def soma(a, b):\n    return a + b\n"
TEST = "from calc import soma\n\n\ndef test_negativos():\n    assert soma(-1, -2) == -3\n"


def _ids(text, pattern):
    return re.findall(pattern, text)


class Fake:
    """An OpenAI-compatible /chat/completions playing one role per model, recording every request."""

    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()

    def respond(self, body):
        msgs = body["messages"]
        model = body["model"]
        last_user = next((m["content"] for m in reversed(msgs) if m["role"] == "user"), "") or ""
        after_user = msgs[max(i for i, m in enumerate(msgs) if m["role"] == "user"):]
        tool_text = "\n".join(m["content"] or "" for m in msgs if m["role"] == "tool")
        if model == "orq":
            rounds = sum(1 for m in msgs if m["role"] == "assistant" and m.get("tool_calls"))
            if "SEM CONCLUIR" in msgs[1]["content"]:
                if rounds == 0:
                    return [("raise_issue", {"kind": "question", "title": "versão a publicar?"})]
                return "Parei sem concluir."
            if "AUTO REVISÃO" in msgs[1]["content"]:
                if rounds == 0:
                    return [("host_write_file", {"path": "NOTAS.md", "content": "notas da release\n"})]
                if rounds == 1:
                    return [("update_task", {"state": "done"})]
                return "Pronto."
            steps = [
                [("raise_issue", {"kind": "problem", "title": "soma() erra com negativos",
                                  "detail": "calc.py usa abs(a)"})],
                [("delegate", {"role": "review", "executor": "Orquestra", "request": "revise"})],
                [("delegate", {"role": "implement", "executor": "Implementador", "request": "CORRIJA soma() em calc.py"})],
                [("delegate", {"role": "review", "executor": "Implementador", "request": "revise"})],
                [("update_task", {"state": "done"})],
                [("delegate", {"role": "review", "executor": "Revisora", "request": "Revise a correção de soma()."})],
                [("delegate", {"role": "implement", "executor": "Implementador", "request": "ADICIONE TESTE de negativos"})],
                [("resolve_issue", {"id": i, "status": "resolved", "resolution": "corrigido e testado"})
                 for i in _ids(tool_text, r"Questão \[(\w+)\] em aberto") + _ids(tool_text, r"- \[(\w+)\] \(problema\)")],
                [("delegate", {"role": "review", "executor": "Revisora", "request": "Revise de novo."})],
                [("update_task", {"state": "done", "progress": "soma corrigida, teste adicionado, revisão aprovada"})],
            ]
            return steps[rounds] if rounds < len(steps) else "Objetivo concluído."
        if "VEREDITO:" in last_user and model != "rev":  # a review asked of another model: it approves
            return "Li o diff e rodei os testes.\n\nVEREDITO: aprovado"
        if model == "impl":
            if not any(m["role"] == "tool" for m in after_user):
                if "ADICIONE TESTE" in last_user:
                    return [("write_file", {"path": "test_calc.py", "content": TEST})]
                return [("write_file", {"path": "calc.py", "content": FIXED})]
            return "Feito.\n\nQUESTÕES:\n- achado: calc.py não tinha testes — só havia a função"
        if model == "rev":
            if any(m["role"] == "assistant" for m in msgs):  # a second review in the same session
                return "Conferi o teste novo e a correção.\n\nVEREDITO: aprovado"
            return ("A correção está certa, mas nada a protege.\n\nQUESTÕES:\n"
                    "- problema: falta teste para negativos — test_calc.py não existe\n\nVEREDITO: mudanças")
        return "?"

    def serve(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def _json(self, data):
                data = json.dumps(data).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._json({"data": [{"id": m} for m, _ in MODELS]})

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                if not body.get("stream") or body.get("max_tokens") == 400:  # titles, suggestions
                    return self._json({"choices": [{"message": {"role": "assistant", "content": "Título"}}]})
                with fake.lock:
                    fake.requests.append(body)
                out = fake.respond(body)
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                end = {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 2}}
                if isinstance(out, list):
                    calls = [{"index": i, "id": "call_" + uuid.uuid4().hex[:8], "type": "function",
                              "function": {"name": n, "arguments": json.dumps(a)}} for i, (n, a) in enumerate(out)]
                    self.wfile.write(f"data: {json.dumps({'choices': [{'delta': {'tool_calls': calls}}]})}\n\n".encode())
                    end["choices"][0]["finish_reason"] = "tool_calls"
                else:
                    chunk = {"model": body["model"], "choices": [{"delta": {"content": out}}]}
                    self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.write(f"data: {json.dumps(end)}\n\ndata: [DONE]\n\n".encode())

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv.server_address[1]

    def of(self, model):
        with self.lock:
            return [r for r in self.requests if r["model"] == model]


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=True).stdout


def driver(tmp):
    sys.path.insert(0, tmp)
    from http.server import ThreadingHTTPServer
    from server import coordination, db, generation, main as ceu

    failures = []

    def ok(cond, msg):
        print(("OK    " if cond else "FALHA ") + msg, flush=True)
        if not cond:
            failures.append(msg)

    fake = Fake()
    fport = fake.serve()
    db.init()
    prov = db.create_provider("openai", "custom", "Falso", f"http://127.0.0.1:{fport}/v1", "x",
                              [{"id": m, "name": n} for m, n in MODELS])
    ORQ, IMPL, REV = (f"{prov['id']}::{m}" for m, _ in MODELS)
    db.update_settings({"default_model": ORQ})
    srv = ThreadingHTTPServer(("127.0.0.1", 0), ceu.Handler)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"

    def api(method, path, body=None):
        req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return {"_status": e.code, **json.loads(e.read() or b"{}")}

    def wait(cond, timeout=60, what="condição"):
        t0 = time.time()
        while time.time() - t0 < timeout:
            v = cond()
            if v:
                return v
            time.sleep(0.2)
        raise TimeoutError(what)

    proj = tempfile.mkdtemp(prefix="ceu-coord-")
    git(proj, "init", "-q")
    git(proj, "config", "user.email", "t@t")
    git(proj, "config", "user.name", "t")
    with open(os.path.join(proj, "calc.py"), "w", newline="\n") as f:
        f.write(BUGGY)
    git(proj, "add", ".")
    git(proj, "commit", "-qm", "base")

    # ------------------------------------------------ the objective
    print("\n# 1. Um objetivo conduzido com executores")
    agent = api("POST", "/api/agents", {"name": "Release", "instructions": "cuide das releases", "model": ORQ,
                                        "host_folder": proj})
    aid = agent["id"]
    ok(agent["rules"] == {} and coordination.decision(db.get_agent(aid), "write_file") == ("host_edit", "ask"),
       "regras padrão: edições do agente (e dos executores) pedem aprovação")
    fp0 = coordination.fingerprint(proj)
    task = api("POST", f"/api/agents/{aid}/tasks", {"title": "Corrigir soma", "instructions": "Corrija soma() e garanta "
                                                    "que está testado.", "schedule": None, "start_now": True})
    tid, tconv = task["id"], task["conversation_id"]
    ok(task["status"] == "running", "a tarefa começou")
    ok((db.get_task(tid)["baseline"] or {}).get("fingerprint") == fp0, "linha de base: o conteúdo da pasta no início do objetivo")

    sysprompt = wait(lambda: fake.of("orq") and fake.of("orq")[0]["messages"][0]["content"], what="1º turno")
    ok("Executores disponíveis" in sysprompt and "Implementador" in sysprompt and "Revisora" in sysprompt,
       "o agente vê a equipe de executores no prompt")
    ok(any(t["function"]["name"] == "delegate" for t in fake.of("orq")[0]["tools"]), "delegate é oferecida (há pasta concedida)")

    # the implementer asks to write calc.py: the card reaches the task's thread and the agent's inbox
    det = wait(lambda: (lambda d: d if any(a.get("kind") == "executor" for a in d["approvals"]) else None)(
        api("GET", f"/api/agents/{aid}")), what="aprovação do executor")
    appr = next(a for a in det["approvals"] if a.get("kind") == "executor")
    ok(appr["request"]["name"] == "write_file" and appr["request"]["action"] == "host_edit",
       "a edição do executor pede aprovação pela regra do agente (host_edit)")
    ok(det["agent"]["pending"] >= 1, "a aprovação do executor conta em “Esperando você”")
    orch = next(m for m in api("GET", f"/api/conversations/{tconv}")["messages"] if m["status"] == "streaming")
    g = generation.get(orch["id"])
    fwd = [e for e in g.events if e["type"] == "approval"]
    ok(fwd and fwd[-1]["request"].get("executor_call_id") == appr["request"]["call_id"],
       "o cartão do executor é encaminhado ao fio da tarefa, na chamada delegate")
    r = api("POST", f"/api/messages/{orch['id']}/approval", {"call_id": fwd[-1]["request"]["call_id"], "decision": "always"})
    ok(r.get("ok") is True, "responder no fio da tarefa responde ao executor")

    final = wait(lambda: (lambda t: t if t["status"] not in ("running", "waiting") else None)(db.get_task(tid)),
                 timeout=90, what="fim da tarefa")
    ok(final["status"] == "done", f"a tarefa termina concluída (status {final['status']})")
    ok(db.get_agent(aid)["rules"].get("host_edit") == "allow", "“sempre permitir” no cartão do executor vira regra do agente")

    orq = fake.of("orq")
    tools = [m for m in orq[-1]["messages"] if m["role"] == "tool"]
    texts = [m["content"] for m in tools]
    ok(len(texts) >= 10, f"o roteiro do orquestrador rodou inteiro ({len(texts)} resultados)")
    ok("quem dirige o trabalho não o revisa" in texts[1], "revisão pelo próprio modelo do agente é recusada")
    ok("Implementador (implementação) terminou" in texts[2] and "(achado)" in texts[2],
       "o relatório do implementador volta ao agente, com o achado registrado")
    ok("implementou parte deste trabalho" in texts[3], "quem implementou não revisa")
    ok("Ainda não dá para concluir" in texts[4] and "em aberto" in texts[4] and "revisão" in texts[4],
       "o portão recusa concluir com questão aberta e mudança sem revisão")
    ok("Veredito: mudanças necessárias" in texts[5] and "(problema) falta teste para negativos" in texts[5],
       "a objeção da revisora vira questão com o nome dela")
    ok("Veredito: aprovado" in texts[-2] or any("Veredito: aprovado" in t for t in texts), "a segunda revisão aprova")
    ok("Ainda não dá" not in texts[-1], "com tudo fechado e o conteúdo atual aprovado, a tarefa conclui")

    with open(os.path.join(proj, "calc.py")) as f:
        ok(f.read() == FIXED, "o executor corrigiu o arquivo na pasta do agente")
    ok(os.path.isfile(os.path.join(proj, "test_calc.py")), "o executor criou o teste")

    calls_ = db.list_calls(aid, tid)
    ok([c["role"] for c in calls_] == ["implement", "review", "implement", "review"],
       "chamadas registradas: implementação, revisão, implementação, revisão (recusadas não contam)")
    reviews = [c for c in calls_ if c["role"] == "review"]
    ok(reviews[0]["verdict"] == "changes" and reviews[1]["verdict"] == "approved", "vereditos registrados")
    ok(reviews[1]["fingerprint"] == coordination.fingerprint(proj) != fp0, "a aprovação vale para o conteúdo atual da pasta")
    ok(reviews[0]["conversation_id"] == reviews[1]["conversation_id"], "a revisora continua a mesma sessão (lembra o que pediu)")
    impls = [c for c in calls_ if c["role"] == "implement"]
    ok(impls[0]["conversation_id"] == impls[1]["conversation_id"], "o implementador continua a mesma sessão")
    rs = db.get_conversation(reviews[0]["conversation_id"])
    is_ = db.get_conversation(impls[0]["conversation_id"])
    ok(rs["kind"] == "code" and rs["permission_mode"] == "plan" and rs["origin"]["agent_id"] == aid
       and rs["origin"]["conversation_id"] == tconv, "o revisor roda numa sessão do Code em modo plano, com origem na tarefa")
    ok(is_["permission_mode"] == "accept_edits", "o implementador passa a editar direto depois da regra do agente mudar")
    rev_reqs = fake.of("rev")
    ok(not any(t["function"]["name"] in ("write_file", "edit_file") for t in rev_reqs[0]["tools"]),
       "a revisora não recebe ferramentas de edição")
    brief = next(m["content"] for m in rev_reqs[0]["messages"] if m["role"] == "user")
    ok("git diff" in brief and "-    return abs(a) + b" in brief and "revisor independente" in brief,
       "a revisora recebe o diff calculado pelo CEU e o papel de revisora")
    ok("soma() erra com negativos" in brief, "a revisora recebe as questões do objetivo")
    ok("Executor" in rev_reqs[0]["messages"][0]["content"] or "executor" in rev_reqs[0]["messages"][0]["content"],
       "o prompt de sistema da sessão diz que ela é um executor")

    issues = db.list_issues(aid, tid)
    by_kind = {}
    for i in issues:
        by_kind.setdefault(i["kind"], []).append(i)
    ok(len(issues) == 3 and not [i for i in issues if i["status"] == "open"], "três questões, nenhuma aberta no fim")
    ok(by_kind["problem"][1]["raised_by"] == "Revisora" and by_kind["problem"][1]["call_id"] == reviews[0]["id"],
       "a questão da revisão guarda a autoria e a chamada de origem")
    ok(by_kind["finding"][0]["status"] == "noted" and by_kind["finding"][0]["raised_by"] == "Implementador",
       "um achado fica registrado, sem entrar na pauta")
    det = api("GET", f"/api/agents/{aid}")
    ok(len(det["issues"]) == 3 and len(det["calls"]) == 4, "o detalhe do agente traz questões e chamadas")
    kinds = [e["kind"] for e in db.list_log(aid, task_id=tid)]
    ok(kinds[0] == "done", "o diário registra a conclusão")

    # ------------------------------------------------ the gate also holds when a run just ends
    print("\n# 2. Uma execução que termina sem cumprir o portão continua")
    t2 = api("POST", f"/api/agents/{aid}/tasks", {"title": "Sem concluir", "instructions": "SEM CONCLUIR",
                                                  "schedule": None, "start_now": True})
    t2 = wait(lambda: (lambda t: t if t["status"] not in ("running",) else None)(db.get_task(t2["id"])), what="tarefa 2")
    ok(t2["status"] == "idle" and (t2["outcome"] or {}).get("why") == "gate" and t2["next_run_at"],
       "sem update_task e com questão aberta, a tarefa não é dada como concluída: continua em seguida")
    ok("Ainda não concluída" in (t2["progress"] or ""), "o motivo fica no estado da tarefa")
    db.update_task(t2["id"], {"status": "paused", "next_run_at": None})  # keep the scheduler away

    # ------------------------------------------------ the CEU asks for the final review itself
    print("\n# 3. O agente mudou a pasta e pede para concluir: o CEU pede a revisão sozinho")
    t3 = api("POST", f"/api/agents/{aid}/tasks", {"title": "Notas", "instructions": "AUTO REVISÃO", "schedule": None,
                                                  "start_now": True})
    t3 = wait(lambda: (lambda t: t if t["status"] not in ("running",) else None)(db.get_task(t3["id"])), timeout=90,
              what="tarefa 3")
    ok(t3["status"] == "done", f"a tarefa conclui depois da revisão automática (status {t3['status']})")
    auto = db.list_calls(aid, t3["id"])
    ok(len(auto) == 1 and auto[0]["role"] == "review" and auto[0]["verdict"] == "approved"
       and auto[0]["label"] == "Implementador", "revisão escolhida pelo CEU: outro modelo, que não coordenou nem implementou")
    ok(auto[0]["fingerprint"] == coordination.fingerprint(proj), "a revisão automática aprovou o conteúdo atual")
    last = [m["content"] for m in fake.of("orq")[-1]["messages"] if m["role"] == "tool"][-1]
    ok("Revisão final automática" in last and "Veredito: aprovado" in last, "o agente recebe o relatório da revisão final")
    rows = [r for m in db.list_messages(t3["conversation_id"]) if m["role"] == "tool_result"
            for r in m.get("tool_results") or [] if r["name"] == "update_task"]
    ok(rows and rows[-1]["meta"].get("executor") == "Implementador" and rows[-1]["meta"].get("verdict") == "approved"
       and rows[-1]["meta"].get("conversation_id") == auto[0]["conversation_id"],
       "o resultado de update_task diz quem revisou, o veredito e onde está a sessão (para a interface)")

    # ------------------------------------------------ the user's hand on the ledger
    print("\n# 4. O usuário fecha e reabre questões")
    q = next(i for i in db.list_issues(aid, t2["id"]) if i["status"] == "open")
    r = api("PATCH", f"/api/issues/{q['id']}", {"status": "resolved"})
    ok(r.get("_status") == 400, "fechar exige dizer como")
    r = api("PATCH", f"/api/issues/{q['id']}", {"status": "discarded", "resolution": "a versão é 0.2.0"})
    ok(r["status"] == "discarded" and r["closed_by"] == "você", "o usuário descarta com motivo")
    r = api("PATCH", f"/api/issues/{q['id']}", {"status": "open"})
    ok(r["status"] == "open" and r["resolution"] is None, "e pode reabrir")
    a, t = db.get_agent(aid), db.get_task(tid)
    closed = next(i for i in db.list_issues(aid, tid) if i["raised_by"] == "Revisora")
    again, how = coordination.add_issue(a, t, "problema", closed["title"].upper() + ".", "ainda falha", "Revisora")
    ok(how == "reopened" and again["id"] == closed["id"] and again["status"] == "open" and "Reaberta por Revisora"
       in again["resolution"], "uma questão fechada levantada de novo por um executor é reaberta, não duplicada")
    db.update_issue(closed["id"], {"status": "resolved", "resolution": "ok"})

    # ------------------------------------------------ the gate follows the folder's content
    print("\n# 5. O portão segue o conteúdo da pasta")
    fin = db.get_task(tid)
    ok(coordination.gate(fin, db.get_agent(aid)) is not None,
       "outra tarefa mudou a pasta depois: a aprovação do objetivo antigo não cobre o conteúdo novo")
    fin = db.get_task(t3["id"])
    ok(coordination.gate(fin, db.get_agent(aid)) is None, "objetivo concluído: portão livre")
    git(proj, "add", ".")
    git(proj, "commit", "-qm", "fix")
    ok(coordination.gate(fin, db.get_agent(aid)) is None, "commit não muda o conteúdo: a aprovação continua valendo")
    with open(os.path.join(proj, "calc.py"), "a", newline="\n") as f:
        f.write("# mudança depois da revisão\n")
    ok("nenhuma revisão independente aprovou" in (coordination.gate(fin, db.get_agent(aid)) or ""),
       "qualquer mudança depois da aprovação exige nova revisão")

    shutil.rmtree(proj, ignore_errors=True)
    print()
    if failures:
        print(f"{len(failures)} falha(s).")
        sys.exit(1)
    print("Tudo certo.")
    sys.exit(0)


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--driver":
        return driver(sys.argv[2])
    tmp = tempfile.mkdtemp(prefix="ceu-coord-srv-")
    try:
        shutil.copytree(os.path.join(ROOT, "server"), os.path.join(tmp, "server"), ignore=shutil.ignore_patterns("__pycache__"))
        os.makedirs(os.path.join(tmp, "data"))
        code = subprocess.call([sys.executable, os.path.abspath(__file__), "--driver", tmp],
                               env={**os.environ, "CEU_DATA_DIR": os.path.join(tmp, "data"), "PYTHONIOENCODING": "utf-8"})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
