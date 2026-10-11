# Integração Freitas Leiloeiro — 0.41.0

O coletor único está em `layers/scrapers/server/utils/sources/freitas.ts`; `src/scrapers/freitas.ts` adapta para CLI/cloud e completa FIPE ausente pelo serviço existente. Fonte `freitas` registrada no runner Nuxt, CLI, cloud e seletores. Sem dependência/env var nova e sem alteração do worker Windows ou da extensão ao vivo.

A documentação principal fica no projeto Picareta:

- [Guia de integração de scrapers para IA](../../picareta/docs/15-guia-integracao-scrapers-ia.md): contratos e checklist de todos os pontos de integração dos dois projetos.
- [Estudo e implementação Freitas](../../picareta/docs/16-scraping-freitas.md): endpoints, seletores, paginação, preços, dados, falhas e evidências reais.

Consulta pública em 11/10/2026: 439 lotes descobertos em 37 páginas, vazio explícito na página 38; 66 veículos extraídos com fotos/preço/local antes de HTTP 403. Não foi confirmada cobertura integral dos detalhes. A implementação final interrompe novos blocos em 401/403/429, mantém o contrato de parciais e não publica execução interrompida como snapshot completo.

Nove testes do coletor passaram com transpiler temporário usando o TypeScript instalado; typecheck isolado strict passou. O comando padrão tsx não executou neste Linux devido ao esbuild Windows presente. Seletores foram revisados a 390/1440 px; o standalone mantém overflow mobile que já existia antes da mudança.

Validar no ambiente com dependências nativas compatíveis:

```bash
pnpm exec tsx --test tests/freitas-scraper.test.ts
```

Publicar junto com Picareta 0.172.0 e testar somente Freitas em `/scraping-cloud` antes de misturar fontes. O estudo não gravou Mongo, consultou FIPE nem enviou WhatsApp.
