# Segurança

## Escopo

O CEU é um aplicativo local. Por padrão, o backend escuta somente em `127.0.0.1`, guarda provedores e conversas no banco local e usa o navegador apenas como cliente da API local.

Não execute o CEU em uma interface de rede pública sem implementar autenticação, revisar CORS/CSRF e proteger o banco. O sandbox WSL2 reduz o risco de acidentes ao executar código gerado, mas permite acesso à rede e não é um limite de segurança endurecido.

## Como reportar

Não publique chaves, tokens, dados de conversas ou uma exploração funcional em uma issue. Quando o repositório GitHub estiver disponível, use o recurso de Security Advisory privado. Se esse canal não estiver habilitado, abra uma issue sem detalhes sensíveis pedindo um contato privado.

## Segredos locais

- Nunca commite `.env`, `data/`, bancos SQLite, logs ou credenciais das ferramentas externas.
- Revogue imediatamente qualquer chave que apareça em um clone, commit, log ou artefato.
- Use `.env.example` somente como modelo sem valores reais.
- O banco local pode conter chaves de provedores; trate uma cópia dele como segredo.
