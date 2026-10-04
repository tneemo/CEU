# Referências: modo Agent (OpenAI dots)

Levantamento feito em 30/09/2026, um dia depois do lançamento dos dots (29/09/2026). Fontes:
- anúncio "Apresentamos os dots" (openai.com/pt-BR/index/introducing-dots);
- "Como incorporamos segurança, proteção e privacidade aos dots" (openai.com/pt-BR/index/how-we-build-safety-security-and-privacy-into-dots);
- FAQ de privacidade e segurança (help.openai.com/articles/20001529);
- "Primeiros passos com seu dot" (help.openai.com/pt-br/articles/20001530), lido em 03/10/2026 para a seção 12;
- documentação da Revisão automática do Codex (learn.chatgpt.com/docs/sandboxing/auto-review) e o `core/src/guardian/policy.md` do repositório open source do Codex.

Não existe spec pública nem API dos dots, só o produto (ChatGPT Pro/Business Premium) e os textos acima. O que está aqui é estrutura e comportamento, sem copiar marca nem texto.

A coluna **CEU** segue a convenção de `referencias-code.md`: primeira versão (**sim**), depois (**depois**), fora do escopo (**fora**).

## 0. O que é um dot, em uma frase

Um agente **persistente**: tem identidade, um computador próprio, contexto que cresce com o tempo e uma lista de tarefas que continua andando sem o usuário na conversa. A mudança de fundo em relação ao chat e ao Code é que **a unidade deixa de ser o turno e passa a ser o agente**. A conversa vira só um dos canais para falar com ele.

| | Chat | Code | Agent (dot) |
|---|---|---|---|
| Unidade | conversa | sessão numa pasta | agente com nome |
| Quem dispara o trabalho | mensagem do usuário | mensagem do usuário | mensagem, agenda, evento ou o próprio agente (pesquisa proativa) |
| Duração | um turno | um turno com N rodadas de ferramenta | contínua, com várias tarefas em paralelo |
| Onde age | nenhum lugar (ou sandbox `run_code`) | pasta do host | computador próprio + apps conectados + (opcional) o host |
| Memória | memórias globais | `AGENTS.md` | contexto próprio do agente, acumulado |
| Sem o usuário presente | não faz nada | trava na aprovação | segue: revisão automática decide, o que não pode esperar vira pendência |

## 1. Identidade e criação

| Aspecto | dots | CEU |
|---|---|---|
| Criação | "Crie seu dot": dar nome, personalizar, conectar apps; o dot "se apresenta" | Nova entidade `agent` com nome, instruções e modelo; primeira mensagem do agente se apresenta e pergunta objetivos (**sim**) |
| Quantidade | um incluído no plano; "equipes de dots" no futuro | vários agentes locais, sem limite artificial (**sim**) |
| Identidade própria | contas próprias (e-mail, Slack) para acesso e permissões | não se aplica a um app local; o agente age com as credenciais que o usuário conectar (**fora**) |
| Dots especialistas | papel fixo na organização (compras, faturas, suporte), configurado com engenharia | perfis/templates de agente (**depois**) |

## 2. Ambiente ("computador próprio")

| Aspecto | dots | CEU |
|---|---|---|
| Computador | VM Linux na nuvem com Chrome, isolada por usuário, mantida pela OpenAI | distro WSL2 `ceu-sandbox` provisionada por `server/sandbox.py`, com uma pasta persistente por agente em `data/agents/<id>/` (**sim**) |
| Ver o computador | "abrir o computador do seu dot a qualquer momento" | navegador de arquivos da pasta do agente + log de comandos (**sim**); tela ao vivo (**fora**) |
| Navegador próprio | sim, com login seguro | **depois** (Playwright dentro do sandbox) |
| Conectar o computador do usuário | opt-in; continua sujeito ao sandbox local e às verificações | inverso no CEU: o host já é local. Conceder pastas do host é opt-in, reutilizando as ferramentas e a política do modo Code (**sim**) |
| Separação de controle | o código roda longe dos sistemas que aplicam as salvaguardas; o agente não consegue desligá-las | a política e o revisor rodam no processo Python do servidor, e o agente só alcança o sandbox e as pastas concedidas (**sim**, já é o desenho atual) |

## 3. Trabalho contínuo: tarefas e Visualização de atividades

| Aspecto | dots | CEU |
|---|---|---|
| Tarefas paralelas | "assume um projeto e o leva adiante, mesmo trabalhando em vários outros"; sem gerenciar conversas separadas | tabela `agent_tasks`; cada tarefa roda numa `Generation` própria (reusa `Bus`, `ask`, `steer`, reconexão) (**sim**) |
| Delegação | o dot delega a outros agentes (inclusive tarefas no Codex/ChatGPT Work); as regras vão junto | subtarefa com `parent_id`, herdando regras e escopo de autorização (**sim**) |
| Visualização de atividades | tarefas em andamento e delegadas, status, passos dados; adicionar contexto, corrigir, mudar o rumo, parar | painel de atividades: lista de tarefas com status (`fila`, `rodando`, `esperando você`, `concluída`, `falhou`, `parada`) e a trilha de passos, reaproveitando as linhas-resumo do Code (**sim**) |
| Pedir decisões | o dot manda mensagem com atualizações, perguntas ou decisões | caixa de entrada de pendências (aprovações + perguntas) + notificação do sistema já existente (**sim**) |
| Sempre ativo 24/7 | na nuvem | enquanto o servidor local estiver rodando. Tauri na bandeja e iniciar com o Windows (**depois**) |
| Gatilhos | mensagem, evento em app conectado ("um bug aparece no Slack"), mudança de dados | manual e agenda (intervalo/cron) (**sim**); mudança numa pasta vigiada (**depois**); webhooks/apps (**fora**) |

## 4. Contexto e memória

| Aspecto | dots | CEU |
|---|---|---|
| Contexto próprio | acumulado "enquanto você mantiver o dot"; redefinível apagando o dot | notas do agente (tabela `agent_notes` ou `notes.md` na pasta dele), carregadas no system prompt com orçamento de tokens (**sim**) |
| Ver e editar a memória | **não**: hoje não dá para ver nem editar memórias individuais | **sim**, e é uma diferença deliberada: notas visíveis e editáveis, como a tela de Memória atual |
| Memória compartilhada com o chat | recebe memórias do ChatGPT e contribui de volta | lê as memórias globais (`memories`) (**sim**); escrever nelas só com aprovação (**depois**) |
| Notas privadas da pesquisa | a pesquisa em segundo plano grava notas que o dot lê depois | mesma coisa: a tarefa de pesquisa só pode escrever notas (**sim**) |
| Continuidade entre canais | o contexto acompanha ChatGPT → Slack → Teams | só a UI do CEU; um fio de conversa por agente (**sim**) |
| Compactação | não documentado | resumir o fio antigo em notas quando passar do orçamento (**sim**, necessário para um fio infinito) |

## 5. Pesquisa proativa

| Aspecto | dots | CEU |
|---|---|---|
| O que é | quando o usuário não está trabalhando com ele, o dot inicia tarefas de pesquisa em segundo plano | tarefa agendada de tipo `research` (**sim**) |
| Limites **no código** | ferramentas só de leitura; não pode mandar mensagem, alterar apps, nem controlar navegador/computador | `tools_for("research")` devolve só ferramentas de leitura + `write_note`; qualquer ação vira proposta para uma tarefa normal (**sim**) |
| Saída | notas privadas; o dot decide como ajudar | notas + no máximo uma sugestão na caixa de entrada, com um limite de frequência (**sim**) |

## 6. Regras, aprovações e revisão automática

Este é o miolo técnico. Os dots têm **três camadas**, e a de baixo não pode ser desligada pelas de cima:

1. **Piso fixo** (não sobrescrevível): etapas que o usuário sempre executa (trocar senha, transferir dinheiro), confirmação a cada vez (apagar dados permanentemente, instalar/rodar software desconhecido, conceder acesso sensível), restrições da pesquisa proativa e a própria revisão automática.
2. **Regras personalizadas**: o usuário marca ações suportadas como *permitir*, *exigir aprovação* ou *bloquear*. O agente pode redigir uma regra, mas precisa de aprovação para mudá-la.
3. **Autorização por tarefa**: "avise um colega sem dizer o motivo". Ela fica presa à instrução e **não se amplia** ao retomar mais tarde nem ao delegar. Aprovar uma mensagem não dá licença para as próximas.

Para compartilhar dados, a exigência cresce com a sensibilidade: dados de saúde exigem destinatário nomeado, e dados pessoais comuns exigem uma categoria de destinatário ("qualquer companhia aérea").

**Revisão automática** (Codex "guardian"):

| Aspecto | Comportamento |
|---|---|
| Quando roda | só em ações que cruzam a fronteira (enviar, alterar arquivo/app, rede, fora das raízes graváveis). Leitura comum não passa por ela |
| Quem revisa | um **segundo agente** com um trabalho mais estreito. Ele vê a transcrição compacta e o pedido exato, **sem** o raciocínio oculto, e pode fazer leituras extras |
| Saída | permitir/negar + justificativa |
| Negação | volta ao agente com a instrução: não buscar o mesmo resultado por atalho; seguir só por uma alternativa materialmente mais segura; senão parar e perguntar |
| Disjuntor | interrompe o turno após 3 negações seguidas ou 10 nas últimas 50 revisões |
| Timeout | reportado à parte, e não conta como prova de risco |
| Override | o usuário aprova **uma** nova tentativa daquela ação exata, que ainda passa pelo revisor |
| Não é permissão | trocar humano por revisor não amplia nada: nem raízes graváveis, nem rede |
| Política | texto versionado (`policy.md`), substituível por usuário/empresa |

| No CEU | |
|---|---|
| Piso fixo | lista em código, fora do alcance do agente, verificada antes de qualquer regra (**sim**) |
| Regras personalizadas | generalizar `project_rules` para `agent_rules(agent_id, action, pattern, decision)` com `allow`/`ask`/`block`; o agente propõe regra → pendência (**sim**) |
| Revisor | nova etapa em `_code_call`: quando `needs_approval` devolve motivo e o usuário não está olhando (ou o agente está em modo autônomo), chama um modelo revisor com transcrição compacta + ação + regras + política; mesmo contrato de resposta que `Generation.ask` (**sim**) |
| Negação / disjuntor | mensagem de negação reforçada e o disjuntor 3/10-de-50 por tarefa (**sim**) |
| Sem revisor disponível | a ação vira pendência e a tarefa passa a `esperando você`; as outras tarefas continuam (**sim**) |
| Monitor de segurança que pausa o trabalho | **depois** (o revisor já cobre a primeira versão) |
| Autorização presa à tarefa | a aprovação grava `task_id`, e subtarefas herdam só o que o pai recebeu (**sim**) |

## 7. Canais e interface

| Aspecto | dots | CEU |
|---|---|---|
| Canais | ChatGPT (desktop, web, celular), chamada de voz, Slack, Teams, SMS em breve | UI do CEU (**sim**); Telegram/Slack (**depois**); voz (**fora**) |
| Mensagens do agente sem pedido | sim: atualizações, perguntas, decisões | o agente pode postar no próprio fio; notificação do sistema (**sim**) |
| Layout | fio de conversa + Visualização de atividades no desktop | barra lateral com seção "Agentes"; tela do agente com o fio à esquerda e o painel de atividades/pendências à direita (**sim**) |

## 8. Credenciais e pagamentos

| Aspecto | dots | CEU |
|---|---|---|
| Login seguro | o modelo pausa, o usuário preenche um formulário que vai direto ao navegador do dot, e a senha nunca entra no contexto | **fora** até existir navegador (seção 2) |
| Senhas salvas | serviço de credenciais cifrado | **fora** |
| Compras | só com cartão salvo na loja, sempre com aprovação | **fora** |
| Segredos para ferramentas | – | variáveis de ambiente por agente, injetadas no sandbox e nunca mostradas ao modelo (**depois**) |

## 9. O que muda no código do CEU

O que já existe e serve:
- `Generation` (`server/generation.py`): thread separada, log de eventos com reconexão, `ask()` bloqueante para aprovação e `steer` para correções no meio do trabalho. Uma tarefa de agente é uma `Generation` sem mensagem de usuário na origem.
- `code_tools.needs_approval` + `project_rules`: já é o esqueleto das regras (seção 6), mas com dois valores (pergunta/permite) em vez de três.
- `sandbox.py`: é o "computador próprio".
- Checkpoints e `undo_turn`: dão o "desfazer" que o FAQ dos dots não consegue garantir.

O que falta:
1. **Tabelas**: `agents`, `agent_tasks` (status, gatilho, `parent_id`, `message_id`), `agent_notes`, `agent_rules`, `agent_approvals` (pendências persistentes, para sobreviver a um reinício do servidor; hoje `pending` vive só na memória).
2. **Agendador**: uma thread no servidor que acorda tarefas por agenda e respeita um teto de tarefas simultâneas por agente e no total.
3. **`ask()` assíncrono**: hoje a thread fica bloqueada esperando a resposta. Para um agente que espera horas, a tarefa precisa **estacionar** (salvar o estado e liberar a thread) e **retomar** quando a pendência for respondida.
4. **Revisor**: módulo `server/reviewer.py` com a política em arquivo e o disjuntor.
5. **Contexto**: montagem do prompt com identidade + notas + memórias + resumo do fio + tarefa atual, com compactação.
6. **UI**: seção Agentes, tela do agente, painel de atividades, caixa de pendências, editor de regras e de notas.

## 10. Decisões (30/09/2026)

- **Estacionar, não bloquear.** O agente reaproveita o motor do modo Code (`Generation`, rodadas de ferramenta, `steer`, desfazer), mas tem implementação própria em `server/agent_mode.py`. Uma ação que pede aprovação salva a rodada em `agent_approvals`, encerra o turno com status `waiting` e libera a thread. Responder abre uma nova geração na mesma mensagem, que roda o resto da rodada. Exceção: no provedor ChatGPT (Codex) as ferramentas rodam dentro do turno dele, então ali a aprovação bloqueia como no Code.
- **Sem revisor automático por enquanto.** Toda ação marcada "perguntar" vem para o usuário. O revisor (seção 6) fica para depois. O ponto de encaixe é `agent_mode.call`, antes de `Park`.
- **Web entra na primeira versão.** `web_search` usa o endpoint HTML do DuckDuckGo, sem chave. `fetch_url` converte a página em texto em partes de 8 mil caracteres e recusa hosts locais e de rede privada.
- **Continuidade das tarefas recorrentes.** Cada execução começa um ramo novo na raiz da conversa da tarefa. O contexto não acumula: o que liga uma execução à outra são as notas e o `last_result`, que entram no prompt. (Ampliado em 03/10: o estado registrado pela própria tarefa e o diário também entram. Ver seção 12.)

## 11. Limitações conhecidas da v1

- O agente só trabalha com o servidor do CEU no ar. Não há serviço do Windows nem bandeja.
- Modelos locais pequenos seguem mal instruções de orçamento ("no máximo 2 páginas") e acumulam páginas inteiras no contexto. No teste, o llama.cpp com contexto de 64k caiu durante uma tarefa assim.
- `fetch_url` é tratada como leitura. Uma injeção de prompt pode montar uma URL com dados do contexto. Por isso a regra "web" pode ser posta em "perguntar", e a pesquisa proativa não lê nada além da web e dos arquivos do agente.

## 12. Persistência e autonomia (03/10/2026)

A v1 tratava a tarefa como um prompt num relógio. Uma execução de uma vez terminava como concluída, mesmo que o trabalho estivesse pela metade. Uma tarefa que batia no limite de rodadas parava ali. A conversa principal só via o último resultado de cada tarefa. O artigo de ajuda dos dots descreve outra coisa: o dot "continua avançando entre as conversas", o perfil mostra **Em andamento, Agendadas e Concluídas**, e o agente pede uma decisão quando precisa dela. A mudança abaixo é a menor que leva o CEU a esse modelo sem trocar o motor: `Generation`, as aprovações estacionadas, o agendador e o ramo novo por execução continuam iguais.

**A tarefa passa a ser um trabalho com estado.** A agenda vira só uma das formas de acordá-la.

| Peça | O que é | Onde |
|---|---|---|
| `progress` | o registro do próprio agente: o que já fez, onde estão os arquivos, o próximo passo. Cada execução começa com ele no prompt, no lugar da conversa anterior | `agent_tasks.progress` |
| desfecho | como a execução termina, escolhido pelo agente: `done` (sai da agenda), `continue` (acorda de novo em N minutos, na mesma tarefa) ou `blocked` (pergunta ao usuário) | `agent_tasks.outcome` (JSON), aplicado em `agent_mode._finish_run` |
| `update_task` | a ferramenta para os dois itens acima. Dentro da tarefa age nela mesma. Na conversa principal, com o `id`, retoma uma tarefa parada ou encerra uma tarefa | `agent_mode._update_task_tool`, sem classe de permissão (é o agente cuidando do próprio trabalho, como `save_note`) |
| diário | uma linha por acontecimento: criada, rodou, vai continuar, precisa de você, concluída, falhou, interrompida, retomada. A conversa principal recebe as 12 mais recentes, cada tarefa recebe o próprio histórico, e o painel mostra a lista em **Atividade** | tabela `agent_log` (400 por agente) |
| `blocked` | novo status. A pergunta vai para **Esperando você**, junto das aprovações, e conta no badge do agente | `agent_tasks.status` |

**O que acorda uma execução**, e a etiqueta que ela lê no topo: o usuário ("execução manual"), a agenda, uma continuação que ela mesma pediu, o limite de rodadas, um reinício do CEU ou a conversa principal. Responder uma aprovação ou escrever na conversa da tarefa também retoma o trabalho.

**Limites no servidor, não no prompt:**
- No máximo `MAX_STREAK` = 6 continuações seguidas sem o usuário intervir. Na sétima, a tarefa vira `blocked` e pergunta se deve seguir. Qualquer ação do usuário zera a contagem: executar, responder, escrever na tarefa ou retomar pela conversa principal.
- `wake_in_minutes` vai de 0 a 7 dias. As continuações passam pelo agendador e respeitam o teto de 2 tarefas simultâneas e a pausa do agente.
- Erro ou parada pelo usuário não gera continuação automática. A agenda, se houver, segue.
- Bater no limite de 60 rodadas vira continuação em 1 minuto. Os últimos passos da execução são anexados ao `progress`, para a próxima não recomeçar do zero.
- Uma tarefa que estava rodando quando o CEU fechou volta 1 minuto depois do boot. Antes ela ficava "interrompida".

**Compatibilidade.** As colunas novas entram por `MIGRATIONS` e começam vazias. Sem `update_task`, uma tarefa se comporta como antes: a de uma vez fica concluída e a recorrente volta à agenda. A pesquisa proativa não usa `update_task` e segue só leitura. Os status antigos continuam válidos.

**Interface.** A criação do agente não ganhou campos. O painel virou: **Esperando você** (aprovações + perguntas, com Responder / Continuar / Encerrar), **Trabalho** (Em andamento / Agendadas / Concluídas, esta recolhida), **Atividade** (recolhida), Notas e Acesso. A linha de uma tarefa em andamento mostra o estado registrado. O menu dela tem "Continuar agora" e "Marcar como concluída".

**Extensões que ficaram naturais:**
- **Novos gatilhos**: um gatilho só precisa pôr `next_run_at` e um `outcome` `{"state": "continue", "why": "<gatilho>"}` e ganhar uma etiqueta em `WAKE_TEXT`. Uma pasta vigiada, um webhook ou um e-mail chegando entram assim, sem mexer no agendador.
- **Atualizações no fio principal**: o diário já é a fonte. Falta decidir como mostrar um evento como mensagem do agente sem quebrar a alternância de papéis dos provedores.
- **Revisor automático**: `blocked` e as aprovações já formam uma caixa de entrada única. Um revisor pode responder parte dela antes do usuário, no mesmo ponto descrito na seção 10.
- **Delegação e subtarefas**: `parent_id` em `agent_tasks`, com o pai lendo o `progress` dos filhos pelo `list_tasks(id)` que já existe. (Seguiu outro caminho em 03/10: o agente delega a executores com `delegate`, mantém questões e só conclui com revisão independente. Ver `docs/coordenacao.md`.)
- **Compactação da conversa principal**: o diário e os `progress` já resumem o trabalho de fundo. O que falta é resumir o próprio fio principal quando ele passar do orçamento.
- **Notificações do sistema** quando uma tarefa conclui ou pergunta, a partir dos eventos `agent` que o barramento já publica.
