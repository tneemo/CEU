# Changelog

## Unreleased — first public source release preparation

- English README, real first-run screenshot, installation examples, architecture,
  security, contribution and known-limitations guides.
- MIT license for CEU and preserved third-party license texts.
- Python serves the production React build when present; browser API requests
  follow the same origin, including custom ports. Legacy Chat stays available.
- Per-data-directory process lock and port binding before database recovery;
  startup regression tests cover duplicate instances and occupied ports.
- Static-file traversal and unexpected Host checks; disabled UI controls for
  unavailable language, history retrieval and sandbox network blocking.
- Retryable Windows dependency installation and readiness checks.
- First-run starter cards no longer launch a background model request before
  a model has been configured.
- Clean-checkout recovery tests and a dry-run workflow that runs integration
  tests without requiring a version bump, existing user database or clean manifests.
- Compatible Vite/source-map dependency updates; corrected Node engine range.
- Desktop shell startup no longer depends on the release build machine's path;
  readiness and startup errors are checked. It still requires a prepared Python
  backend and is not a standalone installer.

## [0.2.0-rc.4] — Release Candidate

### Incluído

- coordenação de objetivos por um agente: a ferramenta `delegate` pede investigação, implementação ou revisão a outros modelos (no loop do CEU ou em harnesses externos), que trabalham em sessões do Code com as permissões do agente;
- questões de um objetivo (problemas, hipóteses, contradições, perguntas, pistas, achados), com autoria, estado e resolução, levantadas pelo agente, pelos executores ou pelo usuário;
- conclusão verificada: uma tarefa só é concluída sem questões abertas e, se a pasta mudou, com uma revisão independente aprovada do conteúdo atual, que o CEU pede sozinho quando é o que falta;
- painel da tarefa com Questões e Executores, aprovações de executores em “Esperando você” e no fio da tarefa;
- `scripts/test_coordination.py`.

## [0.2.0-rc.1] — Release Candidate

Esta RC consolida o estado funcional existente no repositório e prepara a primeira publicação pública do CEU.

### Incluído

- chamadas estruturadas entre participantes do Chat;
- delegação de um pedido para uma sessão Code ou uma tarefa Agent, com briefing e retorno à conversa de origem;
- Rooms com sequência configurável de participantes, rodadas, interrupção e registro de autoria;
- descoberta de modelos e níveis de esforço em runtimes REDIR, com metadados do modelo solicitado e efetivo;
- testes de integração para chamadas, delegação e Rooms;
- identidade, manifests, documentação, configuração e build desktop padronizados para CEU.

### Verificações

- `compileall` do backend e scripts;
- teste de recuperação de tarefas em banco isolado;
- teste de chamadas e Rooms;
- lint e build do frontend;
- build de distribuição Tauri.

## [0.1.0]

Baseline do CEU com Chat, Code, Agent, integrações de provedores, persistência SQLite, frontend web e aplicativo Tauri.
