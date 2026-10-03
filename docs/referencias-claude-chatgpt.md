# Referências: claude.ai e chatgpt.com

Levantamento feito em 28/09/2026 navegando nos dois produtos logado (conta Pro no Claude, Plus no ChatGPT).
Registra estrutura e comportamento; não copia marca, texto de marketing nem dados da conta.
A coluna **CEU** diz o que foi implementado (real), simulado (mock: só persiste a preferência) ou deixado de fora.

## 1. Estrutura geral

| Área | Claude | ChatGPT | CEU |
|---|---|---|---|
| Barra lateral | Novo (Ctrl ⇧ O) · Projetos · Artifacts · Agendados · Personalização · Mais; "Fixados" (arraste para fixar); "Conversas e tarefas" com botão de filtro | Novo chat · Agendado · Biblioteca · Plugins · Explorar; Projetos; Recentes | Nova conversa · Buscar; Fixadas; grupos por data; filtro de ordenação/agrupamento |
| Item da lista (hover) | "⋯" | "⋯" e alfinete de fixar direto | "⋯" + alfinete direto (real) |
| Rodapé | Avatar · nome · plano ▾ (menu: e-mail, Configurações Ctrl ⇧ ,, Uso, Idioma, Ajuda, Upgrade, Apps, Saiba mais, Sair); baixar app; buscar | Avatar · nome · plano | Configurações |
| Topo da conversa | Título (clique = renomear inline) + chevron (menu) · Compartilhar | Compartilhar · ⋯ | Título + chevron (menu) · conversa temporária |
| Estado vazio | Saudação "Boa noite, {nome}" + composer centrado | "Pronto quando você quiser." + sugestões | Saudação com o apelido (se definido) + campo de histórico |
| Modo privado | "Usar modo incógnito" (ícone no topo) | Chat temporário | **Conversa temporária** (real: fora do histórico, apagada ao sair) |

## 2. Menus

**Conversa (Claude)** — Fixar `P` · Mudar o nome `R` · Adicionar ao projeto › · Mover para o grupo › · Apagar `D` (atalhos de uma tecla dentro do menu).
**Conversa (ChatGPT)** — Renomear · Fixar · Mover para projeto · Compartilhar · Arquivar · Excluir. No cabeçalho: Fixar · Mover para projeto · Visualizar arquivos do chat · Arquivar · Excluir.
**CEU** — Renomear `R` · Fixar `P` · Arquivar `A` · Exportar como Markdown `E` · Excluir `D` (atalhos de uma tecla, real).

**Composer "+" (Claude)** — Adicionar arquivos ou fotos (Ctrl U) · Captura de tela · Adicionar ao projeto › · GitHub · Habilidades › · Conectores › · Sistema de design › · Plugins · Pesquisa · Pesquisa na web ✓ · Memória ✓.
**Composer "+" (ChatGPT)** — Fotos e arquivos · Arquivos da biblioteca · Criar imagem · Trabalhar em um projeto · Busca na web · Desenhar · Pesquisa aprofundada · conectores.

**Seletor de modelo (Claude)** — lista com uma linha de descrição por modelo · submenu **Esforço** (Baixo, Médio *Recomendado*, Alto, Extra, Máx) com explicação no topo · Mais modelos ›. Em conversa aberta, o seletor fica abaixo do composer, ao lado do aviso "pode cometer erros".
**Seletor (ChatGPT)** — "Esforço de raciocínio" é um *slider* de 3 paradas (Instantânea → …) com legenda do custo; o nome do nível abre a lista de modelos.

**Filtro da lista (Claude)** — Tipo › · Status › · Última atividade › · Agrupar por › · Ordenar por ›.
**CEU** — Ordenar por (Última atividade / Criação) · Agrupar por (Data / Nenhum) (real, local).

## 3. Mensagens

| Ação | Claude | ChatGPT | CEU |
|---|---|---|---|
| Usuário (hover) | horário relativo ("ontem") · tentar de novo · editar · copiar | editar · copiar | horário · editar · copiar |
| Assistente | copiar · ler em voz alta · 👍 · 👎 · tentar de novo (dispara direto) · ‹ n/N › · horário | copiar · avaliar · compartilhar · ler em voz alta · gerar novamente ▾ (Tentar novamente • modelo / Usar Thinking / Pesquisar na web) · mais ações · fontes | copiar · 👍/👎 (real, salvo) · ler em voz alta (real, Web Speech) · regenerar · mais ações (regenerar com outro modelo, **ramificar em nova conversa**, copiar) · ‹ n/N › |
| Raciocínio | linha-resumo recolhível acima da resposta | "Pensou por…" | já existia |
| Streaming | verbo de status animado ("Triangulando"), botão parar no composer | — | já existia (cubo + "Gerando") |

## 4. Configurações

**Claude** — diálogo modal com busca e navegação à esquerda.
Geral: Tema (Sistema/Claro/Escuro) · Fonte do chat · Movimento (Sistema/Reduzido) · Voz (idioma, estilo, velocidade) · Notificações (conclusão de respostas etc.).
Conta: nome, como te chamar, trabalho, instruções · sessões · sair.
Privacidade: localização, treino, exportar dados, compartilhados, arquivos.
Cobrança · Uso (sessão, semana, por produto) · Recursos (ferramentas, artifacts, visualizações, execução de código, acesso de rede + lista de domínios) · Memória (buscar conversas, gerar memória, temas sensíveis, importar, lista de memórias por categoria) · Claude Code (fonte da UI, tamanho e **largura da transcrição**, …) · Habilidades · Conectores · Plugins.

**ChatGPT** — página própria (/settings/…) com busca; grupos "Pessoais" e "Integrações".
Geral (idioma, ditado) · Aparência (modo com miniaturas; tema; **destaque**: Padrão/Azul/Verde/Amarelo/Rosa/Laranja/Roxo/Branco/Personalizado; fundo e tinta em hex; Avançado: fonte da UI px, fonte do código px, reduzir movimento, separar claro/escuro, contraste, marcadores de diff) · Notificações (por categoria: push/e-mail) · Perfil (estatísticas de uso: tokens, sequência, mais usados) · Segurança · Conta · Voz · Armazenamento (GB usados, arquivos, imagens) · Personalização (memória; instruções personalizadas com apelido, ocupação, mais sobre você; **estilo e tom**: Padrão/Profissional/Amigável/Franco/Diferentão/Eficiente/Cínico; Cordialidade, Entusiasmo, Títulos e listas, Emoji: Mais/Padrão/Menos; busca na web) · Teclado (atalhos editáveis) · Uso · Faturamento · Controles de dados (links compartilhados, chats arquivados, arquivar tudo, excluir tudo, exportar).

### Mapeamento no CEU

| Seção CEU | Campos | Status |
|---|---|---|
| Geral | idioma da interface; envio (Enter / Ctrl Enter); modelo padrão; modelo de títulos; conversa temporária por padrão | idioma = mock; resto real |
| Aparência | modo (miniaturas); destaque (8 cores); fonte do chat (Sans/Serif/Mono/Sistema); tamanho do texto; tamanho do código; largura da conversa; movimento (Sistema/Reduzido/Completo); espaço animado | real |
| Personalização | instruções; apelido; ocupação; mais sobre você; estilo e tom; cordialidade, entusiasmo, títulos e listas, emoji | real (compõem o prompt de sistema) |
| Memória | usar memória; consultar conversas anteriores; lista editável de memórias | memória = real (entra no prompt); consulta = mock |
| Notificações | conclusão de respostas (notificação do sistema com a janela em segundo plano); som | real |
| Voz | voz de leitura; velocidade | real (Web Speech API) |
| Recursos | execução de código (run_code); arquivos da conversa; acesso à rede no sandbox | as duas primeiras são reais (ativam ou desativam ferramentas); rede = mock |
| Provedores | já existia | real |
| Uso | conversas, mensagens, tokens de entrada e saída, por modelo, últimos 30 dias | real (agregado do banco) |
| Teclado | lista de atalhos | real (sem remapear) |
| Dados | armazenamento (banco, anexos, workspaces); conversas arquivadas (restaurar/excluir); arquivar tudo; exportar tudo (JSON); excluir tudo | real |

Fora do escopo do CEU (produto de chat local, sem conta): cobrança, sessões e dispositivos, segurança/MFA, controles parentais, contato de confiança, projetos, conectores e plugins, compartilhamento por link, agendados, geração de imagem e modo de voz.
