# Contribuindo com o CEU

Obrigado por contribuir com o CEU — Composable Experimentation Unit. Antes de abrir uma mudança:

1. descreva o comportamento que está sendo corrigido ou adicionado;
2. preserve o escopo da arquitetura existente e não inclua dados locais;
3. atualize a documentação quando comandos, configuração ou limitações mudarem;
4. execute `compileall`, `scripts/test_calls.py`, `scripts/verify_recovery.py --real-db`, `npm run lint` e `npm run build` quando forem aplicáveis;
5. para mudanças relevantes, valide o workflow com `scripts/release.py --dry-run`.

Não inclua chaves de API, arquivos `.env`, bancos em `data/`, logs, artefatos de build ou caminhos absolutos. Use variáveis `CEU_*` em exemplos de configuração.

O frontend e a documentação usam pt-BR. Mensagens de usuário novas devem seguir esse idioma, salvo quando forem nomes próprios de integrações ou termos técnicos.

## Commits

Prefira commits pequenos e descritivos, agrupados por intenção. Uma mensagem de release é criada pelo script oficial e não deve ser simulada manualmente.

## Licença

A licença do projeto ainda está pendente. Até que os mantenedores decidam e publiquem uma licença, não presuma que contribuições possam ser redistribuídas sob uma licença open source específica.
