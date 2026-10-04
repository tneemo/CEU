# CEU — Composable Experimentation Unit

CEU é uma aplicação local para conversar com modelos de linguagem e conduzir trabalho agentivo no computador do usuário. Ela combina Chat, Code e Agent em uma interface desktop/web em português (pt-BR), com dados e credenciais mantidos localmente.

O projeto está em Release Candidate. A versão `v0.2.0-rc.4` reúne a base funcional existente, coordenação de objetivos com executores e o fluxo de chamadas entre modelos, Code, Agent e Rooms. Algumas integrações dependem de ferramentas externas e continuam opcionais.

## O que já existe

- Chat com Anthropic, OpenAI, OpenRouter, endpoints compatíveis com OpenAI e runtimes locais (llama.cpp, Ollama e LM Studio).
- Streaming, ramificações de conversa, anexos, exportação, busca, preferências e controle de uso.
- Chamadas estruturadas para outro modelo, com projeção de histórico por participante.
- Rooms, que conduzem uma sequência de participantes em várias rodadas.
- Code em uma pasta local, com leitura, busca, edição, comandos, aprovações, desfazer por turno e steering.
- Agent persistente, com notas, tarefas agendadas, aprovações estacionadas e recuperação após reinício.
- Objetivos conduzidos por um agente com outros modelos: investigação, implementação e revisão independente por executores, questões em aberto compartilhadas e conclusão só depois de uma revisão aprovada do conteúdo atual (veja [docs/coordenacao.md](docs/coordenacao.md)).
- Runtimes opcionais para Codex CLI, Claude Agent SDK e outros CLIs supervisionados pelo CEU.
- Aplicação desktop Tauri e frontend React/Vite, além do frontend web estático servido diretamente pelo backend.

O CEU é um aplicativo local. O servidor escuta em loopback por padrão; não o exponha à rede sem adicionar autenticação e revisar a política de origem.

## Requisitos

Para o fluxo completo no Windows 10/11:

- Python 3.10 ou mais recente;
- Node.js 20.19+ (ou 22.12+) e npm;
- Rust stable, Cargo e os Build Tools do Visual Studio com a toolchain MSVC, para o Tauri;
- WSL2, somente quando a execução de código isolada for usada.

O Chat básico precisa apenas de Python, da dependência `anthropic` e de um provedor configurado. Codex CLI, Claude Code/Agent SDK e outros runtimes são integrações opcionais.

## Instalação e execução

Clone o repositório e entre na pasta do projeto. No Windows, o atalho mais simples é:

```bat
start.bat
```

Na primeira execução, o script cria `.venv`, instala `requirements.txt`, inicia o servidor em `http://127.0.0.1:4747` e tenta abrir uma janela de aplicativo no Edge. Para iniciar apenas o backend:

```powershell
.venv\Scripts\python -m server.main --port 4747
```

As dependências do frontend ficam em `web-app/`:

```powershell
cd web-app
npm ci
npm run dev
```

O Vite fica em `http://localhost:5173` e encaminha `/api` para o backend. Para a interface web original, inicie apenas o backend; `server/main.py` serve `web/`.

## Configuração segura

O CEU pode encontrar `ANTHROPIC_API_KEY` e `OPENAI_API_KEY` na primeira inicialização e criar os provedores locais. Também é possível cadastrar provedores pela interface. As chaves ficam no banco local do CEU e não são devolvidas ao navegador.

Use `.env.example` como referência, mas carregue os valores no shell, no gerenciador de segredos ou na configuração da sua IDE. O CEU não carrega arquivos `.env` automaticamente.

Variáveis úteis:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `CEU_PORT` | `4747` | Porta do backend |
| `CEU_API_PORT` | `4747` | Backend usado pelo Vite durante o desenvolvimento |
| `CEU_LOG` | vazio | Habilita logs HTTP locais |
| `CEU_ROOT` | raiz do repositório | Raiz usada pelo aplicativo Tauri |
| `CEU_SANDBOX_DISTRO` | `ceu-sandbox` | Nome da distro WSL2 isolada |
| `CEU_SANDBOX_DIR` | `%LOCALAPPDATA%\CEU\sandbox` | Dados de provisionamento da sandbox |

Conversas, anexos, configurações e provedores ficam em `data/`. Esse diretório é local e está no `.gitignore`; nunca o adicione ao Git.

## Desenvolvimento e verificações

Na raiz:

```powershell
.venv\Scripts\python -m compileall -q server scripts
.venv\Scripts\python scripts\verify_recovery.py --real-db
.venv\Scripts\python scripts\test_calls.py
.venv\Scripts\python scripts\test_coordination.py
.venv\Scripts\python scripts\test_git_tools.py
```

No frontend:

```powershell
cd web-app
npm run lint
npm run build
```

O teste de recuperação usa uma cópia isolada do banco. Não inicie uma segunda instância do backend apontando para `data/app.db`: ao inicializar, ela pode encerrar mensagens em streaming da instância principal.

## Build desktop

Com as dependências do Tauri instaladas:

```powershell
cd web-app
npx tauri build
```

O diretório `target` é gerado e ignorado pelo Git. Em máquinas com pouco espaço no disco do projeto, defina um alvo externo apenas na sessão de build:

```powershell
$env:CARGO_TARGET_DIR = (Join-Path $env:TEMP 'ceu-target')
npx tauri build
```

O alvo padrão da RC no Windows é o instalador NSIS, que fica em
`target/release/bundle/nsis/`. O MSI pode ser solicitado separadamente quando o recurso
opcional VBSCRIPT do Windows estiver habilitado. Para MSI, o workflow deriva a versão
numérica exigida pelo WiX a partir da versão SemVer oficial; isso não cria um segundo
mecanismo de versionamento. O caminho temporário acima é deliberadamente local, não
parte do repositório.

## Release

`web-app/src-tauri/tauri.conf.json` é a fonte de verdade da versão. O script sincroniza essa versão com `package.json`, `package-lock.json`, `Cargo.toml` e `Cargo.lock`, valida o projeto, executa o build do frontend e cria o bundle Tauri:

```powershell
.venv\Scripts\python scripts\release.py --version 0.2.0-rc.1
```

Use `--dry-run` para validar sem alterar versão, commit ou tag. O script só cria uma release quando há mudanças de código relevantes desde a última tag. A publicação no GitHub é uma etapa posterior ao commit e à auditoria final.

## Arquitetura

```text
server/                 backend Python, API HTTP, SSE e SQLite
  main.py               rotas, CORS local e arquivos estáticos
  generation.py         loop de geração e eventos persistentes
  providers.py          Anthropic, OpenAI-compatible e Codex
  code_tools.py         ferramentas do modo Code
  git_tools.py         Git local e ferramentas GitHub do harness
  github.py             cliente REST e cofre seguro de credenciais
  agent_mode.py         agentes, tarefas e aprovações
  calls.py              autoria e projeção de participantes
  coordination.py       executores, questões e conclusão verificada de um objetivo
  delegate.py           delegação para Code e Agent
  rooms.py              condução de sequências de modelos
web/                    frontend original sem build
web-app/                frontend React/TypeScript/Vite
web-app/src-tauri/      casca desktop e bundle Tauri
scripts/                release, recuperação e testes de integração
```

Gerações rodam em threads de fundo e registram eventos por mensagem, permitindo que um cliente SSE reconecte e reproduza o stream. O SQLite guarda conversas como árvores, além de provedores, anexos, agentes, tarefas e aprovações.

O fluxo de Git/GitHub dos agentes, as ferramentas, credenciais e aprovações estão descritos em [docs/git-github.md](docs/git-github.md).

## Estado e limitações conhecidas

- A interface está disponível em português; outros idiomas ainda não são suportados.
- A sandbox WSL2 reduz acidentes locais, mas não é um sandbox endurecido: o código executado nela ainda pode acessar a rede.
- Alguns runtimes exigem instalação e login nas ferramentas dos próprios fornecedores.
- Não há uma suíte unitária extensa; as verificações reproduzíveis atuais são as listadas acima.

## Licença

A licença do CEU ainda está pendente. Até que os mantenedores publiquem uma decisão explícita, este repositório não deve ser tratado como distribuído sob uma licença open source. Veja `LICENSE` para o aviso de status.
