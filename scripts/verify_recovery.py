r"""Teste de recuperação após reinício (tarefas de agente que estavam 'running').

Isolado: copia server/ para uma pasta temporária (DATA_DIR é relativo ao pacote, então o banco
também fica lá) e usa um banco novo, ou um backup consistente do app.db real com --real-db.
Nunca abre o data/app.db do repositório para escrita e nunca chama um modelo (launch é trocado
por um registrador).

    .venv\Scripts\python scripts\verify_recovery.py [--real-db] [--wait 90]

Sai com código 0 se: init/migrações rodam sem erro; a tarefa 'running' vira idle com
next_run_at ~ +60s; a tarefa 'waiting' fica intacta; o agendador a retoma após ~1 min.
"""
import argparse, os, shutil, sqlite3, subprocess, sys, tempfile, textwrap

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

DRIVER = textwrap.dedent('''
    import json, sys, time
    sys.path.insert(0, sys.argv[1])
    from server import db, agent_mode
    WAIT = float(sys.argv[2])
    def ok(c, msg):
        print(("OK   " if c else "FALHA ") + msg, flush=True)
        if not c: ok.bad = True
    ok.bad = False

    db.init()                                            # 1ª subida: migrações
    ok(True, "db.init() (migrações) sem erro")
    agent = db.create_agent("teste", "x", "p::m", None, None, {})
    def mk(title, status):
        conv = db.create_conversation("p::m", None, kind="agent_task", agent_id=agent["id"], title=title)
        t = db.create_task(agent["id"], conv["id"], "task", title, "faça algo", None, None)
        db.update_task(t["id"], {"status": status, "next_run_at": None, "runs": 1})  # já rodou uma vez, como uma tarefa real
        return t["id"]
    run_id, wait_id = mk("rodando", "running"), mk("esperando", "waiting")

    t0 = time.time()
    db.init()                                            # "próximo boot"
    r, w = db.get_task(run_id), db.get_task(wait_id)
    ok(r["status"] == "idle", f"running -> {r['status']} (esperado idle, não interrupted/stopped)")
    ok(r["next_run_at"] and 55 <= r["next_run_at"] - t0 <= 65, f"next_run_at = boot + {r['next_run_at'] - t0:.0f}s")
    ok((r["outcome"] or {}).get("state") == "continue" and r["outcome"].get("why") == "restart", f"outcome = {r['outcome']}")
    ok(w["status"] == "waiting", f"waiting preservada ({w['status']})")
    ok(any(l["kind"] == "resumed" for l in db.list_log(agent["id"])), "journal registra 'resumed'")

    launched = []
    agent_mode.launch = lambda conv, parent, content, model, effort: launched.append((time.time(), content, model))
    agent_mode.start_scheduler(interval=5)
    while not launched and time.time() - t0 < WAIT:
        time.sleep(1)
    if launched:
        dt = launched[0][0] - t0
        ok(55 <= dt <= 75, f"retomada disparada {dt:.0f}s após o boot")
        ok("retomada: o CEU fechou" in launched[0][1], "conteúdo menciona retomada")
        ok(db.get_task(run_id)["status"] == "running", "status voltou a running")
    else:
        ok(False, f"nenhuma retomada em {WAIT:.0f}s")
    ok(len(launched) == 1, f"{len(launched)} retomada(s) (esperado 1)")
    sys.exit(1 if ok.bad else 0)
''')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--real-db", action="store_true", help="usa um backup do data/app.db (testa migrações em dados reais)")
    ap.add_argument("--wait", type=float, default=90)
    args = ap.parse_args()
    tmp = tempfile.mkdtemp(prefix="ceu-recovery-")
    try:
        shutil.copytree(os.path.join(ROOT, "server"), os.path.join(tmp, "server"),
                        ignore=shutil.ignore_patterns("__pycache__"))
        os.makedirs(os.path.join(tmp, "data"))
        if args.real_db:
            src = sqlite3.connect(f"file:{os.path.join(ROOT, 'data', 'app.db')}?mode=ro", uri=True)
            dst = sqlite3.connect(os.path.join(tmp, "data", "app.db"))
            src.backup(dst); src.close(); dst.close()
        driver = os.path.join(tmp, "driver.py")
        open(driver, "w", encoding="utf-8").write(DRIVER)
        sys.exit(subprocess.call([sys.executable, driver, tmp, str(args.wait)],
                                 env={**os.environ, "PYTHONIOENCODING": "utf-8"}))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
