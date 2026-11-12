# Catálogo único de fontes e consumidores

Bot **0.49.0**, Picareta **0.182.0**. Contrato, diagnóstico da Leilo e migração em [25-catalogo-scraping-bot.md](../../picareta/docs/25-catalogo-scraping-bot.md).

O cadastro de metadados permanece em `shared/constants/sources.ts`: nome, cor, aliases, habilitação, prioridade automática/agenda e base/hosts/Referer de imagens. `scrapingCatalog(version, registeredAuctionSources)` publica somente fontes com executor registrado, mantém desativadas para histórico e exclui Marketplace. Labels/defaults cloud derivam dele. Não duplicar lista de fontes no Picareta.

`GET /internal/scraping/sources` usa `x-scraper-service-key` e retorna `schemaVersion=1`, versão do app e fontes; não retorna configuração privada. O consumidor valida/cacheia e deriva seleção, ingestão, preferências, histórico, agenda e imagens. Nova fonte comum com o contrato `AuctionVehicle` existente não exige alteração/release do Picareta.

A coleta VIP de agenda que existia no consumidor foi movida para `layers/scrapers/server/utils/vip-auction-agenda.ts`, com os testes. `GET /internal/scraping/agenda/vip` usa a mesma chave, cache de três minutos e requisição compartilhada. O consumidor só valida/persiste o DTO. CAPTCHA/recusa da origem continua erro; não há contorno implementado.

Coletores, parciais, filtros, ingestão por fonte e fila WhatsApp conservam seus contratos. A política automática segue Sodré/Copart/VS, e Pampa Sul continua desativada. Suporte de captura ao vivo ou regra financeira inédita não é habilitado por cadastro genérico.

Na validação pública, os 58 lotes Leilo e suas 1.454 fotos foram aceitos pelo handler real do consumidor com persistência/agenda/notificações simuladas, sem Mongo write/Z-API. Endpoint de catálogo/agenda é testado com chave correta/incorreta e chamadas concorrentes; parsing VIP e fontes desativadas também têm regressões. Não houve publicação ou envio real.

```sh
pnpm exec tsx --test tests/scraping-catalog.test.ts tests/scraping-catalog-api.test.ts tests/vip-auction-agenda.test.ts tests/cloud-source-persistence.test.ts tests/leilo-scraper.test.ts tests/disabled-auction-sources.test.ts
pnpm build
```

Publicar **bot primeiro**, confirmar versão `0.49.0` e endpoints; depois publicar Picareta `0.182.0`. As próximas fontes comuns podem ser publicadas apenas neste projeto, conforme o guia atualizado em `picareta/docs/15-guia-integracao-scrapers-ia.md`. Nenhuma nova dependência, credencial ou env var foi necessária.
