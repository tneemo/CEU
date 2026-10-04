# Coordenação: um objetivo, vários executores

Sessão de 03/10/2026. Código em `server/coordination.py` (novo), `server/agent_mode.py`, `server/generation.py`, `server/main.py` e `server/db.py`; interface em `web-app/src/components/Agent.tsx` e `Code.tsx`; teste em `scripts/test_coordination.py`.

## 0. O comportamento procurado

"Prepare a próxima release do CEU" deveria poder virar horas de trabalho coordenado: analisar o repositório, achar problemas, um executor implementar, outro revisar de forma independente, testar, investigar de novo quando preciso e convergir para um resultado **verificável**, com pouca supervisão. Também faltava onde registrar descobertas, hipóteses, problemas, contradições e linhas de investigação (chamadas provisoriamente de **Threads**).

## 1. O que já existia

| Peça | O que faz | O que faltava para o objetivo |
|---|---|---|
| **Call** (`calls.py`, `delegate.py`) | um turno pedido a um alvo (modelo, sessão Code, agente) que volta para a conversa de origem, com autoria e projeção por participante | só o **usuário** fazia chamadas, com `@` |
| **Agent** (`agent_mode.py`) | identidade, notas, computador, regras allow/ask/block, aprovações estacionadas, caixa "Esperando você" | todo o trabalho rodava num **único modelo**, o do agente |
| **Tarefa** (`agent_tasks`) | trabalho com estado (`progress`), desfecho escolhido pelo agente (done/continue/blocked), diário, continuação e retomada após reinício | "concluída" era só a palavra do agente; nada verificava |
| **Code + runtimes** (`code_tools.py`, `code_runtimes.py`, `redir.py`) | sessões numa pasta com qualquer modelo no loop do CEU ou num harness externo (Codex SDK, Claude SDK, CLIs REDIR) | não podiam ser acionadas por um agente |
| **Room** (`rooms.py`) | sequência fixa de chamadas de chat, sem julgamento | coordenação roteirizada, sem decisão nem verificação |
| Notas e diário | memória plana e linha do tempo de eventos | nada representava o que está **em dúvida** |

Os Agents vinham da exploração dos *dots* (assistente pessoal persistente: computador próprio, pesquisa proativa, "apresente-se"). O que sobrevive daquilo é o que serve para levar um objetivo adiante: identidade, memória, autoridade, caixa de entrada, tarefas que continuam. A pesquisa proativa e o computador próprio continuam funcionando, mas deixam de ser o centro.

## 2. O formato encontrado

```
Agent  ── responde por objetivos: identidade, memória, autoridade (regras), caixa "Esperando você"
  └─ Tarefa = um objetivo em andamento: estado, desfecho, diário; acorda sozinha
       ├─ Calls  = trabalho pedido a alguém, que volta para a tarefa
       │           (agora também colocadas pelo agente: investigar, implementar, revisar)
       └─ Questões = o que o objetivo ainda não sabe ou não resolveu (o que chamávamos de Threads)
                     e o critério de convergência
Room = caso particular: chamadas numa ordem fixa, sem coordenador
```

Três decisões dão o formato:

1. **A Call continua sendo o primitivo, e o agente também pode fazer uma.** Não surgiu um "subagente" nem um grafo de fluxo: o agente coloca uma chamada (`delegate`) para um *executor*, que é uma sessão do Code com outro modelo ou harness na pasta concedida. A topologia continua em estrela: a chamada sai da tarefa e volta para ela. Quem chama (usuário com `@`, agente com uma ferramenta) é ortogonal ao que a chamada é.
2. **"Threads" são questões em aberto, com estado e autoria, e são a pauta do objetivo.** Problema, hipótese, contradição, pergunta, pista e achado têm a mesma forma: um título, o detalhe com evidência, quem levantou, um estado (aberta → resolvida | descartada; um achado só fica registrado) e como foi fechada. Elas são o estado compartilhado entre executores e entre execuções (cada execução começa com o contexto limpo) e definem quando acabou: nada em aberto. O nome na interface é **Questões** (internamente `issues`): "thread" já significa conversa em todo o código e no vocabulário do produto ("fio principal", "fio da tarefa"), e a abstração não é uma conversa. O nome continua aberto.
3. **A verificação é parte do protocolo, não um comportamento esperado do modelo.** Os testes reais (seção 5) mostraram por quê: o mesmo orquestrador ora delegou a revisão, ora parou para pedir licença, ora nem tentou. Por isso o servidor exige, para concluir, nenhuma questão aberta e uma revisão independente aprovada do **conteúdo atual** da pasta, e ele mesmo pede essa revisão quando é a única coisa que falta.

## 3. O que foi implementado

| Peça | Onde |
|---|---|
| Ferramenta `delegate(role, executor, request)`: investigate e review em modo só leitura, implement com o modo derivado das regras do agente. O agente espera e recebe o relatório; a chamada fica em `agent_calls`; a sessão do executor (origem = fio da tarefa) é reaproveitada por executor e papel | `coordination.delegate`, `agent_mode._DELEGATE_TOOL` |
| Elenco de executores no prompt: modelos habilitados no loop do CEU e harnesses externos prontos (`codex_sdk/<modelo>`, `redir:codex/...`), com resolução por nome e recusa de nomes ambíguos | `coordination.roster`, `resolve` |
| **Autoridade do agente sobre o executor**: leitura, edição, comando, Git e publicação do executor seguem a regra do agente para aquela ação. "Sempre permitir" no cartão vira regra do agente. Os cartões de aprovação do executor aparecem no fio da tarefa (encaminhados à chamada `delegate`) e em "Esperando você" | `generation._code_call`, `Generation.forward`, `coordination.pending_approvals` |
| Questões: `raise_issue` / `resolve_issue` (o agente), bloco `QUESTÕES:` no relatório de qualquer executor (o CEU registra com o nome do executor), `PATCH /api/issues/<id>` (o usuário fecha, descarta ou reabre). O mesmo título não duplica, e uma questão fechada levantada de novo por um executor é **reaberta** | `coordination.add_issue`, `parse_report` |
| Revisão independente: o revisor não pode ser o modelo do agente nem um modelo que implementou desde a última aprovação. Ele recebe quem trabalhou no objetivo, o diff calculado pelo CEU e a instrução de rodar as verificações e não aceitar afirmações sem conferir. Termina com `VEREDITO: aprovado | mudanças` | `check_independent`, `_provenance`, `_REVIEW` |
| **Impressão digital da pasta**: hash de caminho → blob de todo arquivo que o Git não ignora (nada é gravado no repositório). Commit não muda; qualquer edição muda. A linha de base é gravada na primeira execução da tarefa; a revisão grava o que viu e é anulada se a pasta mudar durante ela | `fingerprint`, `baseline` |
| **Portão de conclusão** no servidor: `update_task(done)` e o fim de uma execução sem desfecho só concluem sem questões abertas e, se a pasta mudou, com uma revisão aprovada do conteúdo atual. Se só falta a revisão, o CEU escolhe um revisor independente e a executa (`settle`); se ela pedir mudanças, as questões voltam para o agente. Uma execução que termina sem cumprir o portão continua sozinha (sujeita ao limite de continuações) | `gate_reasons`, `settle`, `agent_mode._finish_run` |
| Interface: no fio de uma tarefa, o painel mostra **Questões** (abertas; fechadas e achados recolhidos, com resolver/descartar/reabrir) e **Executores** (papel, modelo, veredito, link para a sessão). A linha da tarefa mostra quantas questões estão abertas. As rodadas mostram "Pediu revisão a…", "Registrou problema…", "Concluiu a tarefa · revisão final por X: aprovou" e abrem a sessão do executor | `Agent.tsx`, `Code.tsx` |
| Permissão nova `delegate` ("Pedir trabalho a outros modelos", livre por padrão, só com pasta concedida) | `agent_mode.ACTIONS` |

Compatibilidade: as tabelas novas (`agent_calls`, `issues`) e a coluna `agent_tasks.baseline` entram por `SCHEMA`/`MIGRATIONS`. Uma tarefa sem pasta concedida e sem questões se comporta como antes. **Mudança de comportamento:** uma tarefa cuja pasta concedida (um repositório Git) mudou durante o objetivo agora passa por uma revisão de outro modelo antes de ser dada como concluída.

## 4. Regras que valem no servidor

- O executor nunca tem mais permissão que o agente; o que está em "perguntar" pausa e vai para o usuário.
- Quem coordena ou implementou não revisa.
- Uma aprovação vale para um conteúdo exato da pasta; mudou, precisa de outra.
- Concluir exige pauta vazia; fechar uma questão exige dizer como.
- Continuações seguidas sem o usuário continuam limitadas (`MAX_STREAK`).

## 5. Testes ponta a ponta

`scripts/test_coordination.py` (provedor falso, 52 verificações): delegação com origem e reaproveitamento de sessão, autoridade do agente sobre o executor (cartão encaminhado, "sempre permitir" virando regra, implementador passando a `accept_edits`), independência (próprio modelo e implementador recusados), questões vindas do relatório com autoria, reabertura, portão (questão aberta, mudança sem revisão, commit não invalida, edição invalida), continuação automática quando a execução termina sem cumprir o portão e revisão final pedida pelo próprio CEU.

Execuções reais num servidor isolado (cópia de `server/` e do banco, agentes do usuário pausados na cópia), com um repositório de brinquedo com problemas plantados (um teste falhando por bug, docstring contradizendo código e README, versão em dois arquivos, changelog e tag pendentes) e o objetivo "Prepare a próxima release do contador." Orquestrador `gpt-6-luna` no provedor ChatGPT (Codex):

| # | O que aconteceu | O que mudou depois |
|---|---|---|
| 1 | Achou os dois problemas, registrou como questões, corrigiu sozinho, fez commit e tag e parou perguntando se podia "acionar outro modelo" para revisar. Respondido no fio, pediu a revisão; o revisor (`gpt-6-astra`) rodou os testes e 19 mil comparações com `statistics.median`, mas deu "mudanças" só porque não conseguia confirmar quem havia implementado. Respondido de novo, o agente fechou a questão, pediu nova revisão na mesma sessão, recebeu "aprovado" e o portão aceitou | o revisor passou a receber quem trabalhou no objetivo; o agente, que delegar já está autorizado e que a revisão vem antes de commit/tag |
| 2 | Sem perguntar nada: questão, correção, revisão por `gpt-6-sol` **antes** do commit, conclusão. Mas o revisor aceitou "os testes passaram" sem rodar | o revisor passou a ser instruído a rodar as verificações e conferir afirmações; o texto de "modo plano" deixou de contradizer o papel dele |
| 3 | O orquestrador voltou a parar perguntando se podia pedir a revisão. Pior: sem questões nem chamadas, o portão nem se aplicaria | o portão passou a valer para toda tarefa cuja pasta mudou, e o CEU passou a pedir a revisão final sozinho |
| 4 | Sem intervenção: duas questões, correções, commit e tag, `done` → revisão final automática por `gpt-6-astra` (rodou os testes e verificações extras) → aprovada → concluída em ~6 min | — |
| 5 | Sem intervenção e na ordem certa: corrigiu, pediu revisão **antes** do commit a `gpt-5.6-sol`, que rodou os testes e achou um defeito real introduzido no trabalho (`git diff --check` falhando por uma linha em branco no `RELEASE.md`) → questão com o nome do revisor → correção → nova revisão por `gpt-6-sol` → aprovada → commit e tag → concluída em ~5 min, com a aprovação presa ao conteúdo final | — |

## 6. Referências que ajudaram

- **Arquitetura blackboard** (Hearsay-II): especialistas publicam hipóteses num quadro compartilhado e um controle decide quem age. As Questões são esse quadro; o agente é o controle.
- **Magentic-One** (Microsoft, 2024): um orquestrador mantém um registro de fatos e palpites e um registro de progresso, e replaneja quando trava. Aqui o registro é persistente e compartilhado com os executores, e o critério de parada é verificado fora do modelo.
- **Sistema de pesquisa multiagente da Anthropic** (2025): orquestrador e trabalhadores com pedidos autossuficientes e resultados condensados de volta — o formato do `delegate`.
- **Beads**: issues como memória de trabalho de agentes de código, com trabalho "descoberto a partir de" outro — próximo das Questões, que aqui também decidem a conclusão.
- **Proteção de branch do GitHub** ("descartar aprovações antigas quando novos commits chegam") e a revisão automática do Codex: aprovação presa a um conteúdo exato e revisor separado de quem faz.

## 7. Limitações e próximos passos

- **Execução sequencial**: o agente espera cada executor. Investigações em paralelo pedem que a chamada vire um gatilho (o executor termina → a tarefa acorda com o relatório), no mesmo mecanismo de `next_run_at` + desfecho `continue` que a tarefa já tem. Isso também tira a espera de dentro do turno do provedor Codex, que hoje roda as ferramentas dentro do próprio turno.
- **Commit e tag antes da revisão** ainda acontecem quando o orquestrador não pede a revisão por conta própria (a final automática pega o problema, mas depois do commit). Um próximo passo é aplicar o mesmo `settle` antes de tag e publicação.
- **Revisor padrão configurável** por agente; hoje o CEU escolhe (o revisor já usado no objetivo, senão outro modelo do mesmo provedor do agente).
- **Harnesses externos como executores** (Codex SDK, REDIR) seguem os modos de permissão derivados das regras, não a regra por ação; só o loop do CEU aplica a autoridade ação a ação.
- **Sessões de executores** aparecem na lista do Code (com o selo de origem). Com muitos objetivos, vale agrupá-las sob a tarefa.
- O frontend estático `web/` não recebeu a interface nova.
- Rooms continuam como estão; podem um dia ser uma tarefa cujo coordenador é uma ordem fixa em vez de um agente.
