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

## Cadeia TLS incompleta (0.42.1)

Portal e CDN da Freitas não enviam o intermediário `GlobalSign GCC R6 AlphaSSL CA 2025`; o `fetch` do Node falhava com `fetch failed` (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`). `publicAuctionRequest` detecta esse erro e repete via `requestWithIntermediates` (`layers/scrapers/server/utils/incomplete-tls-chain.ts`), que baixa o intermediário pelo AIA e mantém a verificação TLS completa. Detalhes: `picareta/docs/16-scraping-freitas.md`.


## HTTP 403 e sessão Chromium (0.44.1 / Picareta 0.176.1)

Freitas passa a usar `layers/scrapers/server/utils/freitas-session.ts`: um Chromium por execução, sem perfil persistido, com cookies/TLS nativos, consultas GET restritas à origem e endpoints de leitura, scripts/tracking desativados, uma chamada por vez e pelo menos um segundo entre inícios por processo. A infraestrutura Playwright/Docker existente é reutilizada; sem dependência ou env var nova. Timeout individual 25 segundos; orçamento padrão de 30 minutos compartilhado por Nuxt e CLI/cloud. Encerrar o navegador em sucesso, falha ou cancelamento.

O coletor valida a identidade e usa a situação textual já publicada no detalhe. O endpoint `RetornarLoteStatus` fica como fallback quando o HTML não contém status reconhecido. Não inferir venda por código numérico ou usar lance inicial como arremate. Qualquer 401/403/429 ou bloqueio HTML interrompe a sessão e preserva a incompletude; mensagens GoCache incluem o ID da requisição quando disponível e orientam liberação do IP de saída junto ao portal quando necessária.

Ensaio real em 20/10/2026: HTTP direto recebeu 403 GoCache, mas Chromium padrão recebeu 200 na mesma rede. O helper novo leu o lote 8119/67 (detalhe, galeria, lance e situação) e seis outros lotes nas duas primeiras páginas. Sem Mongo, FIPE, WhatsApp ou operações de lance. A amostra não comprova coleta integral ou comportamento do IP de produção; publicar o Bot e validar Freitas em `/scraping-cloud`. Detalhes em `picareta/docs/16-scraping-freitas.md`.

Validação: `pnpm exec tsx --test tests/freitas-session.test.ts tests/freitas-scraper.test.ts`. Não modificar fixtures existentes ou tratar um bloqueio real como execução completa.

A variável global legada `SCRAPER_SOURCE_TIMEOUT_MS=300000`, presente no exemplo de configuração, não reduz o orçamento padrão da Freitas para cinco minutos; as demais fontes mantêm seu comportamento. Um timeout explicitamente informado em uma chamada Nuxt continua sendo respeitado. O fluxo CLI/cloud usa a mesma constante de 30 minutos.
