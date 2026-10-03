# Guia para agentes e contribuidores

CEU — Composable Experimentation Unit — é um aplicativo local para Chat, Code, Agent, chamadas entre participantes e Rooms. A interface e a documentação principal estão em português do Brasil.

## Comandos

Backend:

```powershell
start.bat
.venv\Scripts\python -m server.main --port 4747
```

Frontend React/Tauri:

```powershell
cd web-app
npm ci
npm run dev
npm run lint
npm run build
npx tauri dev
npx tauri build
```

Verificações do backend:

```powershell
.venv\Scripts\python -m compileall -q server scripts
.venv\Scripts\python scripts\test_calls.py
.venv\Scripts\python scripts\test_git_tools.py
.venv\Scripts\python scripts\verify_recovery.py --real-db
```

## Arquitetura

- `server/` é um `ThreadingHTTPServer` com rotas JSON, SSE, arquivos estáticos e SQLite.
- `generation.py` executa gerações em background e registra eventos por mensagem para reconexão.
- `providers.py` integra Anthropic, APIs compatíveis com OpenAI e Codex.
- `code_tools.py` executa o modo Code na pasta escolhida, com permissões, aprovações, undo e steering.
- `git_tools.py` expõe Git local e publicação no GitHub como tools do harness; `github.py` mantém cliente REST e credenciais no cofre seguro do sistema.
- `agent_mode.py` mantém agentes, notas, tarefas agendadas e aprovações estacionadas.
- `calls.py`, `delegate.py` e `rooms.py` mantêm autoria, delegação e sequenciamento de participantes.
- `web/` é o frontend estático servido pelo backend; `web-app/` é o frontend React e a casca Tauri.

O fluxo, as aprovações, a conexão e as tools de Git/GitHub estão em `docs/git-github.md`.

## Cuidados locais

- Não inicie uma segunda instância contra `data/app.db`: a inicialização pode encerrar mensagens que estejam em streaming.
- `scripts/verify_recovery.py --real-db` trabalha em cópia isolada e não deve ser substituído por testes contra um banco de usuário.
- Não versione `.env`, `data/`, `.venv/`, `node_modules/`, `dist/`, `target/`, bancos SQLite ou logs.
- O backend escuta em loopback por padrão. O sandbox WSL2 ajuda contra acidentes, mas não bloqueia a rede nem substitui um sandbox endurecido.
- O build Tauri pode usar `CARGO_TARGET_DIR` definido somente na sessão para manter artefatos fora de uma pasta sincronizada. Não grave caminhos absolutos de uma máquina em arquivos do repositório.

## Identidade e configuração

Use CEU nos nomes exibidos, descrições, identificadores e documentação. `CEU_*` é a família de variáveis pública.

`web-app/src-tauri/tauri.conf.json` é a fonte única da versão. Não introduza outro arquivo ou constante de versão. O script `scripts/release.py` sincroniza os manifests, valida o projeto, executa o build do frontend e gera o bundle Tauri.

Ao alterar código relevante, execute o workflow de release. Use `--dry-run` para validar sem criar commit/tag e só crie uma release quando houver mudança de código desde a última tag.
