# Runtimes do modo Code

Este documento registra a arquitetura dos runtimes do modo Code, o fluxo de configuração e login das
integrações. As observações originais de 03/10/2026 são históricas; a preparação pública
não revalidou contas ou turnos reais de fornecedores. Consulte [limitações](limitations.md).

## Ideia

Um **runtime** é o harness que executa os turnos de uma sessão de código: loop, prompt de sistema,
ferramentas, sandbox e aprovações. Ele é independente do **modelo**, e isso permite rodar o mesmo
provedor/modelo em harnesses diferentes e comparar, por exemplo, o CEU SDK com o harness oficial do
fornecedor.

| Família | id | O que é |
|---|---|---|
| CEU SDK | `ceu` | O loop do próprio CEU (`generation.py` + `code_tools.py`). Funciona com qualquer provedor e tem aprovações, desfazer e correções durante a execução. |
| Codex SDK | `codex_sdk` | O harness do Codex conduzido nativamente pelo CEU pelo `codex app-server` (`codex_sdk.py`). |
| Claude SDK | `claude_sdk` | O Claude Agent SDK conduzido nativamente pelo CEU (`claude_sdk.py`). |
| CEU REDIR | `redir:<driver>` | Um agente CLI externo e completo, executado e supervisionado pelo CEU (`redir.py`). |

O runtime é escolhido ao criar a sessão e fica fixo nela (`conversations.runtime`; NULL = `ceu`).

## Integrações: configuração e login

Os runtimes que usam ferramenta de outro fornecedor dependem de uma **integração**
(`server/integrations.py`). Todas seguem o mesmo ciclo de vida:

```
unconfigured → setup_required → authenticating → connected
                     ↑______________ error ______↙   (qualquer passo que falhe; recuperável)
```

| Estado | Significa |
|---|---|
| `unconfigured` | Falta o que a integração precisa neste computador (CLI, pacote do SDK). |
| `setup_required` | Instalado (ou instalando), mas sem login ou sem credencial escolhida. |
| `authenticating` | Um login iniciado pelo CEU está em andamento (navegador, código de dispositivo, janela do CLI). |
| `connected` | O mecanismo oficial da ferramenta informa uma sessão utilizável. |
| `error` | A última ação ou verificação falhou; `error` diz o motivo e `actions` dizem como tentar de novo. |

**Onde fica cada coisa**

- `integrations.py` tem o ciclo de vida uma única vez: estado, jobs (instalação e login, um por grupo),
  cache das verificações (5 min), erros recuperáveis e notificação de mudanças (evento `integrations`
  em `/api/events`). Cada integração implementa só o que é dela: `locate` (requisitos e versão),
  `install_steps` (comandos oficiais), `check_auth` (com `deep` para provar a sessão), `login_methods`,
  `login` e `logout`.
- Integrações que dividem instalação e conta formam um **grupo** (`codex_sdk` e `codex_cli` usam o mesmo
  Codex e a mesma conta): um login, uma instalação e um erro valem para os dois.
- `code_runtimes.py` deriva o estado de cada runtime do estado da integração: `ready` só quando ela está
  `connected`. `POST /api/chat` reverifica uma vez antes de recusar (o login pode ter mudado fora do CEU).
- Rotas: `GET /api/integrations[?refresh=1]` e
  `POST /api/integrations/<id>/(install|login|cancel|logout|validate|refresh)`. Também vêm em `GET /api/state`.
- Cliente: **Configurações → Runtimes e agentes** (`web-app/src/components/Runtimes.tsx`) só desenha os
  snapshots e dispara ações. O seletor de runtime (`Composer.tsx`) mostra o estado e, num runtime que não
  está pronto, leva direto ao cartão dele. Um aviso acima do campo explica quando o runtime escolhido
  deixou de estar pronto.
- Uma falha de autenticação no meio de um turno (401 da API, código de saída de "não autenticado")
  encerra o turno na hora e marca a integração com erro (`integrations.report_failure`).

**Segurança**

- Nenhum OAuth próprio: cada login é o oficial da ferramenta (app-server do Codex, `claude auth login`,
  login interativo do Antigravity CLI). O CEU nunca lê, copia nem guarda tokens de outra ferramenta.
- Nesta integração, a chave de API da Anthropic usada pelo Claude SDK é a de um
  provedor Anthropic já salvo no banco local do CEU (nunca enviada ao navegador). Ela só vai para o
  processo filho do SDK, pela variável `ANTHROPIC_API_KEY`.
- A chave de API da OpenAI (método alternativo do Codex) passa pelo CEU uma vez e vai direto ao
  `account/login/start` do Codex, que a guarda; o CEU não a armazena.
- Logins interativos abrem o CLI numa janela de terminal própria: o que o usuário digita fica entre ele e
  o CLI. O job guarda só mensagens, a URL de login e o código de dispositivo (que é para ser digitado).
- Instalações rodam os comandos oficiais, mostrados antes no cartão, e só quando o usuário clica em
  Instalar.

## Estado das integrações

| Integração | Instalação | Login | Estado |
|---|---|---|---|
| **Codex SDK** (`codex_sdk`) | `npm install -g @openai/codex` | App-server: `account/login/start` com conta ChatGPT pelo navegador (padrão), código de dispositivo ou chave de API; `account/read` (com refresh do token em Validar); `account/logout`. | **Experimental**: implementação de login, aprovação, retomada, interrupção e `turn/steer`. Verificações históricas não garantem compatibilidade com a versão instalada; sem teste de conta real neste release. |
| **Claude SDK** (`claude_sdk`) | `pip install claude-agent-sdk` no Python do CEU e, se o pacote não trouxer o executável, o instalador nativo do Claude Code | Chave de API da Anthropic, escolhida entre os provedores Anthropic do CEU (ou adicionada no próprio cartão) e validada na API. O CEU não oferece login com conta claude.ai neste runtime. | **Experimental / parcial**: integração implementada; turno real não validado neste release. Requer pacote do SDK e chave válida. |
| **Codex CLI** (`codex_cli`, REDIR) | Mesma do Codex SDK | Mesma conta do Codex SDK | **Experimental** (`codex exec --json`); não revalidado com conta real neste release. |
| **Claude Code CLI** (`claude_cli`, REDIR) | Instalador nativo oficial (`irm https://claude.ai/install.ps1 \| iex`) | `claude auth login` (assinatura) ou `--console` (API) numa janela de terminal; estado por `claude auth status` (JSON); `claude auth logout`. | **Experimental / depende de ação externa**: driver implementado; exige instalação e login próprios. Turno real não validado neste release. |
| **Antigravity CLI** (`antigravity_cli`, REDIR) | Instalador nativo oficial (`irm https://antigravity.google/cli/install.ps1 \| iex` no Windows; script oficial no macOS/Linux) | Login oficial do próprio `agy` numa janela de terminal, com a sessão guardada no keyring do sistema; Validar faz um turno headless mínimo. O logout continua sendo o comando interativo `/logout`. | **Experimental / depende de ação externa**: driver NDJSON com retomada por `--conversation`, eventos de texto, ferramentas, uso e erros. Requer instalar e fazer login. |

## Permissões por runtime

| Modo do CEU | Codex SDK (sandbox + aprovação) | Claude SDK (`permission_mode`) | REDIR |
|---|---|---|---|
| Manual | `read-only` + `untrusted`: edições e comandos não confiáveis pedem aprovação | `default` | — |
| Aceitar edições | `workspace-write` + `untrusted` | `acceptEdits` | — |
| Plano | `read-only` + `never`, com instrução de plano | `plan` | Codex: `read-only`; Claude: `plan`; Antigravity: instrução de plano |
| Automático | `workspace-write` + `never` | `bypassPermissions` (sem sandbox) | Codex: `workspace-write`; Claude: `bypassPermissions`; Antigravity: `--dangerously-skip-permissions` |

No Codex SDK, "Sempre permitir" vira `acceptForSession` (vale até o fim da sessão do Codex) e o motivo de
uma negação vai ao Codex por `turn/steer`. No Claude SDK não há "sempre permitir": cada pedido vai ao card.

## CEU REDIR

O REDIR é uma camada de execução, não um provedor nem um modelo. O agente externo traz o próprio
harness: prompt, ferramentas, sandbox, login e histórico. O CEU cuida de:

| Responsabilidade | Como |
|---|---|
| Processo | Inicia o CLI com `cwd` = pasta do projeto. Em caso de erro ou cancelamento, mata a árvore de processos (`code_tools.kill_tree`). |
| Workspace | O próprio sandbox do CLI faz a contenção. Os caminhos que o CLI reporta viram relativos à pasta. |
| Streaming | Lê a saída JSON linha a linha. O driver converte cada linha em ações (`text`, `delta`, `reasoning`, `tool_start`/`tool_end`, `usage`, `done`, `error`, `fatal`). |
| Sessão | Guarda o id da sessão externa em `conversations.runtime_session` e o retoma no turno seguinte. Por isso o CLI recebe só a mensagem nova. |
| Cancelamento | O botão de parar do CEU mata o processo, e as ações abertas são fechadas como interrompidas. |
| Resultado | Cada ação externa vira uma rodada `tool_call`/`tool_result` na árvore e aparece como no CEU SDK. |

Os runtimes Codex SDK e Claude SDK usam a mesma ponte para a árvore (`generation.External`): rodadas,
saída ao vivo, card de aprovação, id da sessão e correções.

### Como escrever um driver

Crie uma subclasse de `redir.Driver` e registre-a em `redir.DRIVERS`:

- `integration`: o id da integração que instala e faz login no CLI (em `integrations.py`). Sem ela, o
  executável é procurado no PATH (`exe_names`).
- `modes` e `default_mode`: os modos do CEU que o CLI honra **sem perguntar**. O REDIR não tem canal
  de aprovação por ação.
- `discover(exe)`: consulta o catálogo do próprio CLI quando ele oferece listagem. Retorna modelos e
  níveis de esforço; a consulta é armazenada por cinco minutos. Sem lista, o seletor aceita um ID ou alias.
- `model_kinds`: compatibilidade com sessões antigas que escolhiam modelos de provedores do CEU.
- Auto é `None`: `command` não passa modelo nem esforço ao CLI. O resultado registra `requested_model`,
  `actual_model` (se o stream informar) e `requested_effort` em `messages.raw_blocks.redir`.
- `command(exe, session, mode, model, effort)`: o argv de um turno. O prompt vai pelo stdin.
- `parse(obj)`: uma linha JSON da saída, convertida em ações. Use `fatal` para falhas que o CLI tentaria
  repetir por minutos (ex.: autenticação), e `auth_exit_codes` para os códigos de saída de "não autenticado".
- `implemented = True` quando o driver estiver pronto.

## Limitações conhecidas

- REDIR: não há desfazer nem correções durante a execução; os anexos precisam ser texto.
- Codex SDK e Claude SDK: não há desfazer (o CEU não tira snapshot dos arquivos que o harness altera);
  anexos precisam ser texto. O Claude SDK não recebe correções durante a execução.
- Regenerar ou editar uma mensagem continua a mesma sessão externa, que já contém o turno anterior.
  Ramificar em nova conversa começa uma sessão externa nova, sem histórico.
- O cliente vanilla (`web/`) não tem o modo Code; o cartão do provedor ChatGPT dele continua usando as
  rotas antigas `/api/providers/codex/login/*`, que chamam as mesmas funções do app-server.
