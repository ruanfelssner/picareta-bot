# Palácio dos Leilões

Integração `palacio` na versão `0.46.0`, consumidor Picareta `0.177.0`. Contrato, estudo público, parâmetros observados, limites e evidências em [17-scraping-palacio.md](../../picareta/docs/17-scraping-palacio.md).

O coletor único em `layers/scrapers/server/utils/sources/palacio.ts` consulta os endpoints públicos de listagem e detalhe, sem autenticação, persistência ou envio. `src/scrapers/palacio.ts` adapta os mesmos dados e reutiliza enriquecimento FIPE/cache existente. Runner Nuxt, CLI, cloud e interface standalone registram a fonte.

Escopo: categoria AUTOMOVEL filtrada pelos tipos publicados CARRO (`1`), CAMIONETA (`3`) e VAN (`209`). Paginação de oito posições até o fim confirmado pelo total; identidade pelo ID global de bem, mesmo sem número de lote. Datas sem horário preservam precisão; Previsão não é início de pregão. Estado explícito Lote em construção vira `future`. Sem resultado confirmado, não há preço de arremate. Fotos em preparação não entram na galeria. Taxas publicadas por lote permanecem em texto na descrição.

Consultas sequenciais, intervalo fixo de 250 ms, request de 25 segundos e limite total de 15 minutos; uma retentativa para 5xx/timeout. Bloqueios, alterações de estoque, falhas de detalhe/callback e paginação incompleta produzem erro, com `PartialScraperResultError` quando já houver veículos extraídos. Não executa aceite de contrato, registro de visita, lance, favorito ou envio. Não muda retenção, campos manuais, extensão, worker Windows ou WhatsApp.

Validação recomendada:

```sh
pnpm exec tsx --test tests/palacio-scraper.test.ts tests/freitas-scraper.test.ts tests/pampasul-scraper.test.ts
```

Fixtures públicas mínimas removem histórico de licitantes e campos de conta. Casos sintéticos estão identificados nos testes. No ambiente de implementação, Node 22 + loader temporário TypeScript permitiu testar sem modificar dependências Windows; typecheck direcionado do coletor/contratos passou. Revisão visual pelo Chromium local ficou impedida pela ausência de `libnspr4.so`; conferir seletores em 390/1440 px ao validar a aplicação.

Leitura pública de 26/10/2026: 393 IDs em 51 páginas; 392 detalhes extraídos, 4.944 fotos. Um detalhe (`cl=1585171`) permaneceu em HTTP 500 após nova tentativa. São resultados parciais, não um snapshot completo; a coleta continua nos demais e conserva a falha para impedir limpeza de ausentes. Os 26 testes direcionados (Palácio, Freitas e Pampa Sul) passaram; Picareta aprovou 28 testes.
