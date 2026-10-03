# Git e GitHub no CEU

O CEU expõe Git e GitHub como ferramentas nativas do harness. O agente opera na pasta de projeto concedida; ele não precisa montar comandos de terminal para as operações cobertas por estas ferramentas. Git local usa o executável Git detectado no host. Chamadas remotas usam a API REST oficial do GitHub e o transporte HTTPS do Git para o push.

## Arquitetura

- `server/git_tools.py` define schemas, valida argumentos, limita caminhos à raiz de projeto e executa operações locais com argv, sem shell. Ele é conectado ao catálogo do Code e às ferramentas `host_*` de agentes.
- `server/github.py` contém o cofre de credenciais, o cliente REST e o upload HTTPS em fluxo. O cliente e o executor Git podem ser substituídos por doubles nos testes; nenhum teste precisa publicar.
- `server/git_credential.py` implementa o protocolo de helper de credenciais do Git. Só o processo Git recebe usuário/senha via stdin/stdout do helper. Um override por chamada desativa outros helpers do Git; não há token em remote, argumento de processo, arquivo temporário ou configuração persistente do Git.
- A API do GitHub é fixada em `2026-03-10`. Erros de autenticação, permissão, limite, conflito e rede retornam mensagens com próximos passos; o CEU não troca silenciosamente para `gh`, shell, URLs com token ou helpers inseguros.
- O Git precisa estar instalado e visível ao processo do CEU. O GitHub API funciona sem o CLI `gh`.

## Ferramentas dos agentes

No Code, os nomes abaixo são usados diretamente. Um agente com uma pasta do computador concedida recebe os mesmos nomes com o prefixo `host_` (por exemplo, `host_git_status`).

| Grupo | Tools |
| --- | --- |
| Detectar e ler | `git_detect`, `git_status`, `git_diff`, `git_log`, `github_status`, `github_get_repo` |
| Git local | `git_init`, `git_add`, `git_commit`, `git_branch` (listar/criar/trocar/apagar branch integrada), `git_tag` (listar/criar/apagar), `git_remote` (listar/configurar/remover) |
| GitHub | `github_create_repo` (privado por padrão), `github_push` (branch/tag sem force), `github_create_release`, `github_upload_asset` |

`git_remote` aceita URLs HTTPS/SSH sem credenciais, URLs SSH no formato `git@host:path` e caminhos locais. O push integrado pelo CEU aceita apenas um destino HTTPS de `github.com` e confere o destino efetivo de push, inclusive `pushurl`, antes de invocar Git. Nesse push, o CEU usa um diretório temporário vazio como `core.hooksPath`, evitando executar hooks do projeto no processo que recebe a credencial.

Os resultados trazem campos próprios em `meta` além do texto: `commit_sha`, `tag`, `remote`, `remote_url`, `repo_url`, `release_url`, `repository`, `release` e `artifacts_published`, conforme a operação. `git_detect` informa a instalação do Git e a raiz encontrada. O CEU recusa mutações se a pasta escolhida estiver dentro de outro repositório, em vez de operar silenciosamente fora da pasta concedida.

## Autenticação

Abra **Configurações → GitHub**, cole um Personal Access Token (PAT) e conecte. O CEU valida o token com `GET /user` antes de salvá-lo. No Windows, o segredo fica no Windows Credential Manager, como credencial genérica persistente para o usuário. Nos demais sistemas, o CEU usa o keyring nativo (Keychain/Secret Service); sem um backend seguro ativo, a conexão falha fechada. Desconectar apaga a credencial e o nome de conta guardados pelo CEU.

O formulário envia o token ao backend local uma vez para validação. O token não é devolvido à interface, ao agente ou ao provedor do modelo; não vai para prompts, logs do CEU, `data/app.db`, histórico de conversas, URL, arquivo do projeto, argumento de subprocesso, nem remote Git. O helper de push lê a credencial do cofre e entrega ao Git apenas pelo protocolo padrão de credenciais em memória.

Para um token clássico, o escopo `repo` cobre repositórios privados e operações de push/releases. Para um token de granularidade fina, conceda `Repository creation: write` (ou `Administration: write`) para criar repositórios e `Contents: write` para push e releases; selecione acesso a todos os repositórios para que o token também publique nos projetos novos. Se a release incluir uma alteração de workflow em `.github/workflows/`, o GitHub também exige `Workflows: write`. Organizações podem exigir aprovação do token.

## Aprovações

- Consultas e leitura (status, diff, log e consulta de repositório) não pedem aprovação.
- No Code, `manual` pede aprovação para init/add/commit, alterações de branch/tag/remote e qualquer publicação. `accept_edits` continua pedindo aprovação para essas operações Git e GitHub. `plan` só expõe leituras e bloqueia mutações. `auto` mantém o comportamento do modo auto já escolhido para a sessão.
- Em agentes, leitura Git/GitHub fica liberada por padrão. Escritas Git locais e publicação GitHub têm regras independentes, ambas em **Perguntar** por padrão; o usuário pode permitir ou bloquear cada classe nas permissões do agente. Tarefas de pesquisa proativa não recebem essas ferramentas.
- `git_branch delete`, `git_tag delete` e `git_remote remove` passam pela mesma classe aprovada de mutações Git. `github_create_repo`, `github_push`, `github_create_release` e `github_upload_asset` passam pela classe de publicação.

## Exemplo de fluxo

Depois de conectar o GitHub em Configurações e revisar os arquivos que podem ser publicados, o agente pode executar este fluxo na pasta concedida. No Code, um pedido equivalente pode ser feito ao agente; os nomes abaixo são as chamadas estruturadas de tool:

Se `git_detect` retornar `is_repository=false`, execute `git_init`; se a pasta já for a raiz de um repositório, pule essa chamada. Revise status e diff e confirme que os arquivos sensíveis estão ignorados antes de adicionar caminhos ao index.

```json
{"name":"git_detect","input":{}}
{"name":"git_init","input":{"branch":"main"}}
{"name":"git_status","input":{}}
{"name":"git_add","input":{"paths":["src/","README.md","installer/ceu-setup.exe"]}}
{"name":"git_commit","input":{"message":"release: prepara v0.2.0-rc.1"}}
{"name":"github_create_repo","input":{"name":"meu-projeto","private":true}}
{"name":"git_remote","input":{"action":"set","name":"origin","url":"https://github.com/conta/meu-projeto.git"}}
{"name":"github_push","input":{"remote":"origin","ref":"main"}}
{"name":"git_tag","input":{"action":"create","name":"v0.2.0-rc.1","message":"Release v0.2.0-rc.1"}}
{"name":"github_push","input":{"remote":"origin","ref":"v0.2.0-rc.1"}}
{"name":"github_create_release","input":{"tag":"v0.2.0-rc.1","name":"v0.2.0-rc.1","body":"Pré-lançamento.","prerelease":true}}
{"name":"github_upload_asset","input":{"tag":"v0.2.0-rc.1","path":"installer/ceu-setup.exe"}}
```

O nome de conta e a URL corretos vêm do resultado de `github_create_repo`; o agente passa esse `clone_url` para `git_remote`. Cada chamada de escrita ou publicação será apresentada ao usuário para aprovação conforme as regras ativas. O SHA criado, a tag, remote, URLs do repositório/release e URLs/tamanhos dos anexos são devolvidos em campos estruturados.

## Verificação local

Rode `.venv\Scripts\python scripts\test_git_tools.py`. A suíte cria um repositório temporário e usa respostas/clientes falsos nas operações remotas; não acessa uma conta GitHub e não faz push.
