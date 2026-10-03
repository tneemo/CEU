# Referências: modo Code (Claude Code e Codex)

Levantamento feito em 29/09/2026:
- claude.ai/code e chatgpt.com/codex, navegados logado;
- documentação pública do Claude Code Desktop (code.claude.com/docs/en/desktop) e do Codex app/CLI;
- a aba Code do app Claude desktop, onde este trabalho foi feito.

As versões web rodam em repositórios GitHub na nuvem. O comportamento local (pasta no disco, aprovação de comandos no host) vem da documentação e do app desktop. O objetivo é registrar estrutura e comportamento, sem copiar marca nem texto.

A coluna **CEU** diz o que entra na primeira versão do modo Code (**sim**), o que fica para depois (**depois**) e o que está fora do escopo (**fora**).

## 1. Início de sessão

| Aspecto | Claude Code | Codex | CEU |
|---|---|---|---|
| Unidade | "Sessão": histórico e pasta próprios, independente das outras | "Thread", ligada a um projeto (pasta local, worktree ou nuvem) | Sessão de código = conversa com `kind=code` e uma pasta (**sim**) |
| Onde roda | Chip de ambiente acima do composer: Local (só no desktop) / Nuvem › / Controle remoto › | Local / Worktree / Nuvem | Só local, no Windows (**sim**) |
| Escolha do projeto | Chip "Selecionar repositório…" com busca e "Atualizar lista"; no desktop, uma pasta | Chip do repositório + chip da branch (com busca de branches) | Chip "Escolher pasta…" com recentes; mostra a branch se houver git (**sim**) |
| Isolamento | Opção **worktree** ao lado da branch | Worktree como ambiente | **fora** (v1 edita a pasta direto) |
| Estado vazio | Saudação curta + composer; chips de pasta/repo acima do campo | "O que vamos desenvolver agora?" + composer + sugestões de tarefa | Saudação + seletor de pasta em destaque (**sim**) |

## 2. Composer

| Aspecto | Claude Code | Codex | CEU |
|---|---|---|---|
| "+" | Adicionar arquivos (Ctrl U) · Comandos de barra · Conectores › | Planejamento · Carregar anexo | Anexar (já existe) (**sim**) |
| Modo de permissão | Botão ao lado do "+" que abre o menu **Modo** (1/2/3/…) | `/permissions`: presets Read Only / Auto / Full Access | Botão de modo no composer com atalhos numéricos (**sim**) |
| Menções | `@arquivo` com autocomplete (local) | `@arquivo` | **depois** |
| Comandos `/` | `/compact`, `/resume` etc. | `/init`, `/status`, `/permissions`, `/model`, `/review`, `/plan` | **depois** |
| Mensagem durante a execução | Enter manda uma correção sem parar; o modelo lê ao fim da ação atual | "Steer" do turno ativo | Mensagem entra na fila e é injetada no próximo passo (**sim**) |
| Contexto | Anel de uso ao lado do modelo: janela de contexto + limites do plano | "context left" | Anel com a % da janela de contexto (**depois**) |
| Modelo / esforço | Botões "Opus 5.5" · "Alto" | `/model` | Seletor existente (**sim**) |

## 3. Permissões

**Modos (Claude, menu "Modo"):**

| Modo | Comportamento |
|---|---|
| Manual | Pergunta antes de editar e antes de rodar comandos |
| Aceitar edições | Edições e comandos simples de arquivo passam direto; outros comandos perguntam |
| Plano | Lê e explora; propõe um plano sem editar |
| Automático | Decide sozinho |

Cada item mostra uma linha de descrição e um atalho numérico.

**Presets (Codex):**

| Preset | Comportamento |
|---|---|
| Read Only | Só lê |
| Auto (padrão num repositório git) | Edita e roda comandos dentro da pasta; pede aprovação para sair da pasta ou usar a rede |
| Full Access | Sem limites, marcado como arriscado |

**Card de aprovação.** As duas CLIs oferecem três respostas:
1. Sim.
2. Sim, e não perguntar de novo para `<comando/padrão>` nesta pasta.
3. Não, e dizer o que fazer diferente (Esc).

O desktop do Claude mostra o card inline na conversa.

**CEU:**
- **Modos:** Manual / Aceitar edições / Plano / Automático, trocáveis no meio da sessão.
- **Card inline:**
  - Permitir `1`
  - Sempre permitir `<prefixo>` nesta pasta `2`
  - Negar e explicar `3`/Esc, com um campo de texto opcional que vai ao modelo.
- **Regras "sempre":** guardadas por pasta.
- **Status:** todas as opções acima entram (**sim**).

## 4. Como o trabalho aparece na conversa

Esta é a observação mais importante do estudo. O Claude **não mostra cada ferramenta como um card**. A prosa do modelo corre normal, e entre os parágrafos aparecem **linhas-resumo cinzas e compactas**, que agrupam as chamadas consecutivas:

- "Executado 3 comandos ›"
- "Executado 2 comandos, criado cycle.py +196 −0 ›"
- "Atualizado \_\_init\_\_.py +29 −6 ›"

Ao expandir uma linha:
- **Cada comando** aparece como uma linha com uma descrição humana, por exemplo "Checked tree state and DBOS scheduler API ›". A ferramenta de shell recebe um campo `description`. Expandindo de novo aparecem `$ comando` e a saída, numa caixa monoespaçada rolável.
- **Cada edição** mostra o caminho do arquivo e o diff inline, com número de linha e fundo verde/vermelho.

No **fim do turno** aparece um card "Editou N arquivos · Desfazer · +583 −6":
- uma linha por arquivo com `+a −r`;
- "Mostrar mais N";
- clicar num arquivo abre o **painel de diff** à direita (lista de arquivos + diff, base → branch atual).

No Codex a UI do app mostra "Worked for 2m 30s ›" recolhido acima da resposta final.

| Elemento | CEU |
|---|---|
| Linhas-resumo agrupadas entre a prosa, com verbos no passado ("Leu 3 arquivos, editou x.ts +3 −1") | **sim** |
| Descrição humana por comando (`description` obrigatório em `run_command`) | **sim** |
| `$ comando` + saída ao vivo durante a execução, recolhida ao terminar | **sim** |
| Diff inline por edição | **sim** |
| Card de fim de turno "Editou N arquivos · Desfazer" | **sim** (Desfazer restaura o conteúdo anterior via checkpoint) |
| Painel lateral de diff da sessão | **depois** (v1: o card de fim de turno abre o diff de cada arquivo inline) |
| "Trabalhou por Xm Ys" | **depois** |

## 5. Cabeçalho, lista e organização

| Aspecto | Claude Code | Codex | CEU |
|---|---|---|---|
| Cabeçalho | Ícone do ambiente · título ▾ · chip `repo · branch` · botões de diff, compartilhar e ⋯ | — | Título ▾ · chip `pasta · branch` (menu: abrir no Explorer, copiar caminho) (**sim**) |
| Menu do título | Abrir em › · Mudar o nome R · Copiar link C · Visualização de transcrição › · Editar ambiente · Arquivar A · Apagar D | — | Menu existente (**sim**); pasta pelo chip ao lado |
| Filtro da lista | Status › · Ambiente › · Agrupar por › · Ordenar por › · Mostrar status do PR | Abas Tarefas / Revisões de código / Arquivar | Chat e Code na mesma lista; agrupar por projeto (**sim**) |
| Alternar chat/code | Segmentado no topo da barra lateral (Chat · Code) | Produto separado | Botão "Nova sessão de código" + marcação por tipo (**sim**) |
| Sessões paralelas | Sim, com indicador por sessão | Sim | Sim: a geração já é por conversa (**sim**) |
| Notificações | OS ao terminar, se você não está vendo a sessão; também para aprovação | Sim | Ao terminar e **ao pedir aprovação** (**sim**) |

## 6. Instruções do projeto e ambiente

- **Claude:** `CLAUDE.md` na raiz. Os servidores de preview ficam em `.claude/launch.json`.
- **Codex:** `AGENTS.md`, que `/init` cria.
- **CEU:** lê `AGENTS.md` e, se não existir, `CLAUDE.md` na raiz, e injeta no prompt de sistema (**sim**). Criar esse arquivo via comando fica para **depois**.

## 7. Fora da primeira versão

| Item | Status |
|---|---|
| Worktrees, execução em nuvem ou SSH, PR/CI, auto-merge | **fora** |
| Terminal integrado, editor de arquivo, preview de app no browser, computer use, subagentes, side chats, Dispatch | **fora** |
| Review automático de código no diff, comentários no diff | **depois** |
| Compactação automática de contexto | **depois** (v1 mostra o uso e avisa ao se aproximar do limite) |

## 8. Implementado (29/09/2026)

Resumo do que a primeira versão entregou e como foi verificado:
- **Servidor:** `server/code_tools.py` e o fluxo de aprovação em `generation.py`.
  - Testado com um script sobre as ferramentas (22 checagens).
  - Testado de ponta a ponta pela API com o Qwen3-Coder local: aprovar, negar, reconectar com aprovação pendente, parar durante a aprovação e modo Plano.
- **UI:** `web-app/src/components/Code.tsx`, verificada no preview do Vite nos dois temas.
  - Aprovação por clique e por atalho.
  - "Sempre permitir".
  - Mensagem enviada durante a execução.
  - Desfazer do turno.
  - "Executar o plano".
- **Codex:** usa `dynamicTools` no `thread/start` (campo experimental: só aparece em `codex app-server generate-json-schema --experimental`). As ferramentas do CEU são chamadas via `item/tool/call` e passam pelo fluxo de aprovação do CEU, como nos outros provedores.
