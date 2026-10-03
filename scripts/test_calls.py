r"""Testes ponta a ponta das chamadas (calls.py), da delegação (delegate.py) e das Rooms (rooms.py).

Isolado como o verify_recovery: copia server/ para uma pasta temporária (banco novo lá dentro) e
sobe o servidor do CEU num thread, numa porta livre. Os modelos são um provedor falso compatível com
a API da OpenAI (também num thread) que responde de forma determinística e registra exatamente o que
cada participante recebeu — nenhum modelo real é chamado.

    .venv\Scripts\python scripts\test_calls.py

Fluxos cobertos (pela API HTTP, como o cliente faz):
  1. Chat → @modelo → Chat (e um chat sem chamadas continua idêntico ao de antes);
  2. Chat → @Code e Chat → @Agent, com o resultado voltando à conversa de origem;
  3. Rooms: A → B → C → A, A → B → C → B, A → B → C em 2 rodadas, A → B → A (A fala duas vezes
     seguidas), finale, ferramentas desligadas, interrupção e templates.
Sai com código 0 se tudo passar.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

MODELS = [("alpha", "Luna"), ("beta", "Astra"), ("gamma", "Claude Sonnet"), ("qwen-1b", "Qwen 1B")]


# ---------------------------------------------------------------- fake provider

class Fake:
    """An OpenAI-compatible /chat/completions that answers "<Nome> #n" and records every request."""

    def __init__(self):
        self.requests = []
        self.lock = threading.Lock()

    def serve(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):  # /models
                data = json.dumps({"data": [{"id": m} for m, _ in MODELS]}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                text_all = json.dumps(body["messages"], ensure_ascii=False)
                # titles and starter cards (providers.complete_short) aren't turns of the conversation
                aux = body.get("max_tokens") == 400 or not body.get("stream")
                name = dict(MODELS).get(body["model"], body["model"])
                with fake.lock:
                    if not aux:
                        fake.requests.append(body)
                    n = sum(1 for r in fake.requests if r["model"] == body["model"])
                reply = "Título de teste" if aux else f"{name} #{n}"
                if "DEVAGAR" in text_all and not aux:
                    time.sleep(4)
                if not body.get("stream"):
                    data = json.dumps({"choices": [{"message": {"role": "assistant", "content": reply}}]}).encode()
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                end = {"choices": [{"delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 1, "completion_tokens": 2}}
                if "CRIE NOTAS.md" in text_all and not any(m["role"] == "tool" for m in body["messages"]):
                    # a Code turn that edits a file: in manual mode CEU asks the user first
                    args = json.dumps({"path": "NOTAS.md", "content": "oi\n"})
                    call = {"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                            "function": {"name": "write_file", "arguments": args}}]}
                    self.wfile.write(f"data: {json.dumps({'choices': [{'delta': call}]})}\n\n".encode())
                    end["choices"][0]["finish_reason"] = "tool_calls"
                    self.wfile.write(f"data: {json.dumps(end)}\n\ndata: [DONE]\n\n".encode())
                    return
                try:
                    for piece in (reply[:3], reply[3:]):
                        chunk = {"model": body["model"], "choices": [{"delta": {"content": piece}}]}
                        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                        self.wfile.flush()
                    self.wfile.write(f"data: {json.dumps(end)}\n\ndata: [DONE]\n\n".encode())
                except OSError:  # the turn was stopped and CEU closed the stream
                    pass

        srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        srv.daemon_threads = True
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        return srv.server_address[1]

    def take(self):
        with self.lock:
            out, self.requests = self.requests, []
        return out


# ---------------------------------------------------------------- driver (runs inside the copy)

def driver(tmp):
    sys.path.insert(0, tmp)
    from http.server import ThreadingHTTPServer
    from server import db, main as ceu, rooms

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
    ref = {m: f"{prov['id']}::{m}" for m, _ in MODELS}
    A, B, C, Q = ref["alpha"], ref["beta"], ref["gamma"], ref["qwen-1b"]
    db.update_settings({"default_model": A})
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

    def settle(cid, timeout=40):
        t0 = time.time()
        while time.time() - t0 < timeout:
            d = api("GET", f"/api/conversations/{cid}")
            if not any(m["status"] == "streaming" for m in d["messages"]) and not d["conversation"].get("room_running"):
                return d
            time.sleep(0.2)
        raise TimeoutError(cid)

    def path_of(d):
        msgs = {m["id"]: m for m in d["messages"]}
        out, mid = [], d["conversation"]["current_leaf_id"]
        while mid:
            out.append(msgs[mid])
            mid = msgs[mid]["parent_id"]
        return out[::-1]

    def roles(req):
        return [m["role"] for m in req["messages"]]

    def falas(req):
        """Who appears inside <fala de="…"> in the request, in order."""
        import re
        text = "\n".join(m["content"] if isinstance(m["content"], str) else "" for m in req["messages"] if m["role"] == "user")
        return re.findall(r'<fala de="([^"]+)">', text)

    def chat(cid, content, call=None, model=A, parent=None):
        return api("POST", "/api/chat", {"conversation_id": cid, "parent_id": parent, "content": content,
                                         "attachments": [], "model": model, "effort": None, "call": call})

    # ------------------------------------------------ 1. Chat → @modelo → Chat
    print("\n# 1. Chat → @modelo → Chat")
    r = chat(None, "Olá")
    cid = r["conversation"]["id"]
    settle(cid)
    req = fake.take()
    ok(len(req) == 1 and roles(req[0]) == ["system", "user"], "chat simples: system + user")
    ok("Participantes" not in req[0]["messages"][0]["content"], "chat sem chamadas: nenhuma nota de participantes")
    ok(bool(req[0].get("tools")), "chat simples mantém as ferramentas do Chat")
    d = settle(cid)
    chat(cid, "E agora?", parent=path_of(d)[-1]["id"])
    d = settle(cid)
    req = fake.take()
    ok(roles(req[0]) == ["system", "user", "assistant", "user"], "chat sem chamadas: histórico intacto (user/assistant)")
    r = chat(cid, "o que acha?", call={"surface": "chat", "target": B}, parent=path_of(d)[-1]["id"])
    d = settle(cid)
    req = fake.take()
    ok(req[0]["model"] == "beta", "@Astra: quem responde é Astra")
    ok(roles(req[0]) == ["system", "user"] and falas(req[0]) == ["Luna", "Luna"], "Astra vê as falas de Luna como texto atribuído, em ordem")
    ok(bool(req[0].get("tools")), "@modelo continua recebendo as ferramentas do Chat (comportamento mantido)")
    p = path_of(d)
    ok(p[-1]["call"]["target"] == B and p[-1]["model"] == B and p[-1]["content"] == "Astra #1", "resposta de Astra registrada com autoria")
    ok(d["conversation"]["model"] == A, "a conversa continua com o modelo dela (Luna)")
    chat(cid, "e você, Luna?", parent=p[-1]["id"])
    d = settle(cid)
    req = fake.take()
    ok(roles(req[0]) == ["system", "user", "assistant", "user", "assistant", "user"] and falas(req[0]) == ["Astra"],
       "Luna vê os próprios turnos como assistant e Astra como fala")
    ok("[@Astra]" in req[0]["messages"][-1]["content"] or "[@Astra]" in json.dumps(req[0]["messages"], ensure_ascii=False),
       "a mensagem dirigida a Astra aparece marcada [@Astra] para Luna")

    # ------------------------------------------------ 2a. Chat → @Code → Chat
    print("\n# 2a. Chat → @Code → Chat")
    proj = tempfile.mkdtemp(prefix="ceu-proj-")
    folder = os.path.basename(proj)
    p = path_of(d)
    r = chat(cid, "crie um README", call={"surface": "code", "target": proj}, parent=p[-1]["id"])
    reply_id = r["assistant"]["id"]
    ok(r["assistant"]["call"]["surface"] == "code", "a resposta de origem nasce como chamada delegada")
    d = settle(cid)
    req = fake.take()
    reply = next(m for m in d["messages"] if m["id"] == reply_id)
    ok(reply["status"] == "complete", f"resposta delegada concluída ({reply['status']} {reply.get('error') or ''})")
    link = reply["call"]
    ok(bool(link.get("conversation_id")), "a resposta registra a sessão de Code onde o trabalho rodou")
    code = api("GET", f"/api/conversations/{link['conversation_id']}")
    ok(code["conversation"]["kind"] == "code" and code["conversation"]["project_path"] == os.path.normpath(proj),
       "uma sessão de Code foi criada na pasta escolhida")
    ok((code["conversation"]["origin"] or {}).get("conversation_id") == cid, "a sessão de Code sabe de onde veio")
    ok(code["conversation"]["permission_mode"] == "manual", "permissão padrão da sessão delegada: manual")
    brief = next(m for m in code["messages"] if m["role"] == "user")["content"]
    ok("<conversa>" in brief and "crie um README" in brief and "Astra #1" in brief, "o briefing leva o pedido e a conversa atribuída")
    final = [m for m in code["messages"] if m["role"] == "assistant"][-1]
    ok(reply["content"] == final["content"] and final["content"].startswith("Luna"), "o resultado do Code voltou como resposta na origem")
    code_req = req[-1]
    ok(any(t["function"]["name"] == "edit_file" for t in code_req.get("tools") or []),
       "o Code trabalha com as ferramentas do Code (não as do Chat)")
    ok("Participantes" not in code_req["messages"][0]["content"], "a sessão de Code não vira conversa multi-participante")
    chat(cid, "ficou bom?", parent=reply_id)
    d = settle(cid)
    req = fake.take()
    ok(f"Code · {folder}" in falas(req[0]), "no Chat, o resultado aparece como fala de “Code · pasta”, não como de Luna")
    p = path_of(d)
    r = chat(cid, "agora adicione testes", call={"surface": "code", "target": proj}, parent=p[-1]["id"])
    d = settle(cid)
    fake.take()
    reply2 = next(m for m in d["messages"] if m["id"] == r["assistant"]["id"])
    ok(reply2["call"]["conversation_id"] == link["conversation_id"], "segunda chamada ao mesmo projeto continua a mesma sessão")
    code = api("GET", f"/api/conversations/{link['conversation_id']}")
    brief2 = [m for m in code["messages"] if m["role"] == "user"][-1]["content"]
    ok("ficou bom?" in brief2 and "crie um README" not in brief2, "o novo briefing só traz o que veio depois da chamada anterior")

    # an approval inside the delegated session shows up and is answered in the origin conversation
    p = path_of(d)
    r = chat(cid, "CRIE NOTAS.md", call={"surface": "code", "target": proj}, parent=p[-1]["id"])
    origin_reply = r["assistant"]["id"]
    seen = []

    def listen():
        with urllib.request.urlopen(base + f"/api/stream/{origin_reply}", timeout=20) as s:
            for raw in s:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("data:"):
                    ev = json.loads(line[5:])
                    seen.append(ev)
                    if ev.get("type") in ("approval", "done"):
                        return
    th = threading.Thread(target=listen, daemon=True)
    th.start()
    th.join(15)
    appr = next((e for e in seen if e.get("type") == "approval"), None)
    ok(bool(appr) and appr["request"]["name"] == "write_file", "o cartão de aprovação do Code chega na conversa de origem")
    if appr:
        res = api("POST", f"/api/messages/{origin_reply}/approval", {"call_id": appr["request"]["call_id"], "decision": "allow"})
        ok(res.get("ok") is True, "aprovar na origem é repassado à sessão de Code")
    d = settle(cid)
    fake.take()
    ok(os.path.isfile(os.path.join(proj, "NOTAS.md")), "a edição aprovada foi feita na pasta do projeto")
    reply3 = next(m for m in d["messages"] if m["id"] == origin_reply)
    ok(reply3["status"] == "complete" and reply3["content"], "e o resultado voltou à origem depois da aprovação")

    # ------------------------------------------------ 2b. Chat → @Agent → Chat
    print("\n# 2b. Chat → @Agent → Chat")
    agent = api("POST", "/api/agents", {"name": "Pesquisador", "instructions": "pesquise", "model": C})
    aid = (agent.get("agent") or agent)["id"]
    fake.take()
    p = path_of(d)
    r = chat(cid, "pesquise o tema", call={"surface": "agent", "target": aid}, parent=p[-1]["id"])
    d = settle(cid, 60)
    req = fake.take()
    reply = next(m for m in d["messages"] if m["id"] == r["assistant"]["id"])
    ok(reply["status"] == "complete" and reply["content"].startswith("Claude Sonnet"),
       f"o resultado da tarefa do agente voltou à origem ({reply['status']}: {reply['content'][:40]})")
    tconv = api("GET", f"/api/conversations/{reply['call']['conversation_id']}")
    ok(tconv["conversation"]["kind"] == "agent_task" and (tconv["conversation"]["origin"] or {}).get("conversation_id") == cid,
       "o trabalho rodou numa tarefa do agente que sabe de onde veio")
    ok(any(t["function"]["name"] == "save_note" for t in req[-1].get("tools") or []), "o agente trabalha com as ferramentas dele")
    det = api("GET", f"/api/agents/{aid}")
    log = json.dumps(det, ensure_ascii=False)
    ok("Pedida numa conversa do Chat" in log, "o diário do agente registra a origem do pedido")
    ok(any(t["status"] == "done" for t in det.get("tasks") or []), "a tarefa de uma chamada única termina como concluída")

    # ------------------------------------------------ 3. Rooms
    print("\n# 3. Rooms")

    def room(order, rounds=1, finale=(), tools=False, opener="Tema: ponte."):
        conv = api("POST", "/api/rooms", {"room": {"order": order, "rounds": rounds, "finale": list(finale), "tools": tools}})
        assert "_status" not in conv, conv
        fake.take()
        chat(conv["id"], opener)
        dd = settle(conv["id"], 60)
        return conv, dd, fake.take()

    def check(order, rounds=1, finale=()):
        names = {A: "Luna", B: "Astra", C: "Claude Sonnet", Q: "Qwen 1B"}
        seq = [x for _ in range(rounds) for x in order] + list(finale)
        title = " → ".join(names[x] for x in seq)
        conv, dd, reqs = room(order, rounds, finale)
        pth = path_of(dd)
        turns = [m for m in pth if m["role"] == "assistant"]
        ok([m["model"] for m in turns] == seq, f"[{title}] ordem de fala respeitada")
        ok([m["call"]["room"]["turn"] for m in turns] == list(range(1, len(seq) + 1)), f"[{title}] cada turno registra sua posição")
        ok(all(pth[i]["parent_id"] == pth[i - 1]["id"] for i in range(1, len(pth))), f"[{title}] cronologia: cada fala responde à anterior")
        ok([r["model"] for r in reqs] == [x.split("::")[1] for x in seq], f"[{title}] o provedor recebeu um pedido por turno, na ordem")
        ok(all(not r.get("tools") for r in reqs), f"[{title}] sem ferramentas do Chat na Room (padrão)")
        good = True
        for i, (spk, rq) in enumerate(zip(seq, reqs)):
            # expected projection: own earlier turns as assistant, everyone else's as falas, in order
            own_before = [j for j in range(i) if seq[j] == spk]
            exp_roles = ["system"]
            exp_falas = []
            pending_user = True  # opener
            for j in range(i):
                if seq[j] == spk:
                    if pending_user:
                        exp_roles.append("user")
                    exp_roles.append("assistant")
                    pending_user = False
                else:
                    exp_falas.append(names[seq[j]])
                    pending_user = True
            exp_roles.append("user")  # always ends on the user side (nudge when speaking twice in a row)
            if roles(rq) != exp_roles or falas(rq) != exp_falas:
                good = False
                print(f"      turno {i + 1} ({names[spk]}): roles {roles(rq)} falas {falas(rq)} | esperado {exp_roles} {exp_falas}")
            own = [m["content"] for m in rq["messages"] if m["role"] == "assistant"]
            if own != [turns[j]["content"] for j in own_before]:
                good = False
                print(f"      turno {i + 1}: próprios turnos {own}")
            sysmsg = rq["messages"][0]["content"]
            if "Room" not in sysmsg or (f"rodada {turns[i]['call']['room']['round']} de {rounds}" not in sysmsg
                                        and "encerramento" not in sysmsg):
                good = False
                print(f"      turno {i + 1}: nota de sistema sem a posição na Room")
        ok(good, f"[{title}] cada participante vê os próprios turnos como seus e os outros como falas atribuídas, em ordem")
        return conv, dd, reqs

    check([A, B, C, A])
    check([A, B, C, B])
    check([A, B, C], rounds=2)
    _c, _d, reqs = check([A, B, A], rounds=2)  # A speaks twice in a row between the rounds
    ok("É a sua vez de novo" in json.dumps(reqs[3]["messages"][-1], ensure_ascii=False), "[A→B→A ×2] fala seguida do mesmo modelo recebe a deixa de turno")
    check([A, B, C], finale=[Q])

    conv, dd, reqs = room([A, B], tools=True)
    ok(all(r.get("tools") for r in reqs), "Room com ferramentas ligadas: participantes recebem as ferramentas do Chat")

    # a message to one participant inside a room is a plain call: no sequence runs
    p = path_of(dd)
    chat(conv["id"], "só você, Astra", call={"surface": "chat", "target": B}, parent=p[-1]["id"])
    dd = settle(conv["id"])
    reqs = fake.take()
    ok(len(reqs) == 1 and reqs[0]["model"] == "beta", "@modelo dentro de uma Room responde sozinho, sem disparar a sequência")

    # Delegations inside a Room answer inline; the next plain message starts a fresh sequence.
    p = path_of(dd)
    delegated_agent = chat(conv["id"], "pesquise dentro da Room", call={"surface": "agent", "target": aid}, parent=p[-1]["id"])
    dd = settle(conv["id"], 60)
    reqs = fake.take()
    agent_reply = next(m for m in dd["messages"] if m["id"] == delegated_agent["assistant"]["id"])
    ok(len(reqs) == 1 and reqs[0]["model"] == "gamma" and agent_reply["status"] == "complete",
       "@Agent dentro da Room delega só ao agente, sem executar a sequência")
    ok(agent_reply["call"]["surface"] == "agent" and agent_reply["call"]["conversation_id"],
       "a tarefa do Agent registra seu vínculo com a Room de origem")

    p = path_of(dd)
    delegated_code = chat(conv["id"], "crie um README pela Room", call={"surface": "code", "target": proj}, parent=p[-1]["id"])
    dd = settle(conv["id"])
    reqs = fake.take()
    code_reply = next(m for m in dd["messages"] if m["id"] == delegated_code["assistant"]["id"])
    ok(len(reqs) == 1 and code_reply["status"] == "complete" and code_reply["call"]["surface"] == "code",
       "@Code dentro da Room delega só à sessão de Code, sem executar a sequência")
    ok((api("GET", f"/api/conversations/{code_reply['call']['conversation_id']}")["conversation"].get("origin") or {}).get("conversation_id") == conv["id"],
       "a sessão de Code registra a Room como origem")

    p = path_of(dd)
    chat(conv["id"], "continuem", parent=p[-1]["id"])
    dd = settle(conv["id"])
    reqs = fake.take()
    ok([r["model"] for r in reqs] == ["alpha", "beta"], "após delegações, uma nova mensagem retoma a sequência da Room")
    ok("Code · " in json.dumps(reqs[0]["messages"], ensure_ascii=False) and "Agent · Pesquisador" in json.dumps(reqs[0]["messages"], ensure_ascii=False),
       "a projeção da Room atribui as respostas anteriores a Code e Agent")
    reloaded = api("GET", f"/api/conversations/{conv['id']}")["conversation"]
    ok(reloaded["room"] == conv["room"] and "room_run" not in reloaded and db.get_room_run(conv["id"]) is None,
       "configuração da Room persiste no reload e o cursor interno é limpo ao terminar")

    # stop in the middle of a run
    conv = api("POST", "/api/rooms", {"room": {"order": [A, B, C], "rounds": 1}})
    fake.take()
    r = chat(conv["id"], "DEVAGAR por favor")
    time.sleep(1)
    busy = chat(conv["id"], "outra", parent=r["user"]["id"])
    ok(busy.get("_status") == 409, "enquanto a Room fala, uma nova mensagem é recusada (409)")
    api("POST", f"/api/messages/{r['assistant']['id']}/stop")
    dd = settle(conv["id"])
    turns = [m for m in path_of(dd) if m["role"] == "assistant"]
    ok(len(turns) == 1 and turns[0]["status"] == "stopped", "interromper um turno encerra a sequência da Room")
    fake.take()

    # Simulate a process restart after the second participant's placeholder was persisted.
    recovery = api("POST", "/api/rooms", {"room": {"order": [A, B, C], "rounds": 1}})
    opener = db.create_message(recovery["id"], None, "user", content="Recupere a sequência")
    turns = rooms.sequence(recovery["room"])
    first = db.create_message(recovery["id"], opener["id"], "assistant", content="Luna #recovery", model=A,
                              status="complete", call={"surface": "chat", "target": A, "effort": None, "room": turns[0][1]})
    interrupted = db.create_message(recovery["id"], first["id"], "assistant", content="Astra começou", model=B,
                                    status="streaming", call={"surface": "chat", "target": B, "effort": None,
                                                              "room": turns[1][1]})
    db.update_conversation(recovery["id"], {"current_leaf_id": interrupted["id"]})
    db.set_room_run(recovery["id"], {"turns": turns, "index": 1, "parent_id": first["id"], "message_id": interrupted["id"]})
    fake.take()
    db.init()  # startup recovery marks interrupted streams stopped, as a real process restart does
    rooms.recover()
    recovered = settle(recovery["id"], 60)
    recovery_reqs = fake.take()
    recovered_path = path_of(recovered)
    recovered_turns = [m for m in recovered_path if m["role"] == "assistant"]
    ok([r["model"] for r in recovery_reqs] == ["gamma"], "após reinício, a Room retoma no próximo participante")
    ok([m["model"] for m in recovered_turns] == [A, B, C] and recovered_turns[1]["status"] == "error"
       and "reinício" in recovered_turns[1]["error"], "a fala interrompida fica registrada e o restante da sequência termina")
    ok(recovered["conversation"]["room"] == recovery["room"] and db.get_room_run(recovery["id"]) is None,
       "reload após recovery preserva a configuração e limpa o cursor concluído")

    bad = api("POST", "/api/rooms", {"room": {"order": [A, A], "rounds": 2}})
    ok(bad.get("_status") == 400, "Room com um modelo só é recusada")

    tpl = api("GET", "/api/rooms/templates")
    cadeia = next(t for t in tpl if t["id"] == "cadeia")
    ok(cadeia["order"] == [A, B, C] and cadeia["finale"] == [Q], "template “Revisão em cadeia” resolve Luna → Astra → Claude → Qwen 1B")
    debate = next(t for t in tpl if t["id"] == "debate")
    ok(debate["order"] == [None, None] and debate["rounds"] == 3, "template sem modelos fixos deixa os lugares para escolher")

    print()
    if failures:
        print(f"{len(failures)} falha(s).")
        sys.exit(1)
    print("Tudo certo.")
    sys.exit(0)


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--driver":
        return driver(sys.argv[2])
    tmp = tempfile.mkdtemp(prefix="ceu-calls-")
    try:
        shutil.copytree(os.path.join(ROOT, "server"), os.path.join(tmp, "server"), ignore=shutil.ignore_patterns("__pycache__"))
        os.makedirs(os.path.join(tmp, "data"))
        code = subprocess.call([sys.executable, os.path.abspath(__file__), "--driver", tmp],
                               env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    sys.exit(code)


if __name__ == "__main__":
    main()
