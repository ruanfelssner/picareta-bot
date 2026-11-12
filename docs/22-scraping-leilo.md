# Leilo Sul e Sudeste

Integração `leilo` na versão `0.48.0`, consumidor Picareta `0.181.0`. Estudo público de 12/11/2026, contrato, campos, limites e evidências em [23-scraping-leilo.md](../../picareta/docs/23-scraping-leilo.md).

O coletor único `layers/scrapers/server/utils/sources/leilo.ts` descobre edições ativas da série Sul e Sudeste, percorre todas as páginas e lê detalhes/galerias completos no HTML público. Não fixa o UUID do evento fornecido; não coleta demais séries ou histórico encerrado. `src/scrapers/leilo.ts` adapta o resultado para CLI/cloud e reutiliza FIPE/cache. Nuxt, CLI, cloud e interface standalone registram a mesma fonte.

`valorMercado` é avaliação publicada e não FIPE confirmada. Taxas variáveis de cada lote ficam na descrição; não aplicar a tabela genérica. Preservar custos/FIPE manuais nos fluxos existentes. O início oficial vem de `leilao.data`; não usar a abertura de ofertas, cronômetro individual ou catálogo como sala ao vivo.

Consultas GET sequenciais, sem scripts/visitas/lances, com cancelamento, timeout total de 15 minutos e parcial explícito após qualquer falha com resultados. Limites fixos de 20 edições e 100 páginas por edição; nenhuma env var nova. Não altera worker Windows, extensão, fontes automáticas ou regras WhatsApp.

Coleta real sem persistência/envios: 58/58 lotes, 1.454 fotos, 10 lotes sem fotos, duas páginas, próxima edição vazia, 60,419 segundos. Fixtures sanitizadas e testes em `tests/leilo-scraper.test.ts`. Validação via `tsx`/build normal limitada pelas dependências Windows no WSL; testes foram executados com loader TypeScript temporário, sem modificar dependências. Typecheck estrito dos três arquivos novos sem diagnósticos. Renderização visual local impedida por falta de `libnspr4.so`; validar seletores mobile/desktop no ambiente de destino.

```sh
pnpm exec tsx --test tests/leilo-scraper.test.ts tests/palacio-scraper.test.ts
pnpm build
```

Implantar o bot e o consumidor em conjunto, depois selecionar **Leilo Sul e Sudeste** em `/scraping-cloud` do Picareta. Nenhum commit, publicação ou envio foi executado.
