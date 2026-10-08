# Scraper Pestana Leilões

Release `0.36.0`; integração Picareta `0.169.0`.

## Implementação

Uma única implementação em `layers/scrapers/server/utils/sources/pestana.ts` atende `pestanaSource.run()` e o adapter CLI `src/scrapers/pestana.ts`. Catálogos de fontes, runner Nuxt, CLI, cloud, painel Express e seletores passam a incluir `pestana`. Não há dependência ou variável de ambiente nova. O worker e a extensão ao vivo continuam com Copart, Sodré e VIP.

## Protocolo público

1. GET `https://www.pestanaleiloes.com.br/procurar-bens?lotePage=1&loteQty=12&tipoBem=421`: ler JSON de `__hydrateLeilao`, `__hydrateLoteCaracteristicaTipo` e `__hydrateParceiro`.
2. POST `/search-api/lote/filtrar` com `{ "tipoBem": [421] }`: retorna todos os IDs em `lotes`; página e quantidade paginam apenas a interface.
3. POST `/api/v2/lote/por-ids` com `{ "ids": [...] }`: consultar blocos deduplicados de 24, com intervalo de um segundo e timeout de 30 segundos por requisição. Limite de segurança: 20 mil IDs; excedê-lo é falha explícita, não truncamento silencioso.
4. Normalizar identidade, características, fotos, localização do bem, comitente, data brasileira e resultados. A URL canônica de lote é `/lote/:leilao/:lote`, independente do slug. Aceitar sala `/:id/aovivo` somente quando publicada no HTML oficial.

O portal usa esses endpoints no próprio JavaScript público. Os testes de bloco usam respostas controladas com esse contrato; a fixture `tests/fixtures/pestana-public-lots.json` veio dos dados públicos hidratados em 07/10/2026, com Mercedes, BMW e Zeekr.

## Regras de normalização

Características oficiais precedem inferências do título. Ano-modelo precede fabricação. Lance atual positivo precede o inicial; `soldPrice` exige resultado vendido e valor efetivo. Condicional e não vendido permanecem separados; repasse não confirma venda. `Não se aplica` em monta continua desconhecido. Nunca usar sede do leiloeiro como localização do veículo, avaliação como FIPE ou tabela de taxas de outra fonte como custo Pestana.

`auctionDate` sem offset recebe `-03:00`. Sem hora, `auctionTimeKnown=false`; sem término, `auctionEndsAt=null`. Cloud conserva status, evidência e arremate no payload Picareta; campos novos ausentes nas fontes anteriores são omitidos.

## Erros e validação

CAPTCHA Radware (também HTTP 200), JSON inválido, IDs inválidos, detalhes ausentes e cancelamento não equivalem a sucesso vazio. O runner Nuxt recebe `PartialScraperResultError` com veículos já extraídos quando houver falha parcial; CLI/cloud reporta a falha e não publica snapshot completo. Nunca preencher a busca com os destaques da home. Outra fonte permanece independente.

O teste online de 07/10/2026 descobriu **457 IDs** e processou o primeiro bloco, extraindo **cinco veículos** antes do bloqueio por CAPTCHA. Chromium e consultas de imagens também encontraram bloqueios neste ambiente. Não houve gravação Mongo nem envio WhatsApp. Cobertura integral e disponibilidade das imagens precisam ser confirmadas no ambiente do bot.

Execute `pnpm exec tsx --test tests/pestana-scraper.test.ts`. Para validar integrado, publique bot e Picareta, escolha somente Pestana em `/scraping-cloud` e confira a conclusão e os veículos em `/oportunidades`. Não executar a CLI com WhatsApp habilitado apenas para verificar a coleta.

Verificação local: os 11 testes do scraper passaram, assim como 24 testes Picareta relacionados. A checagem TypeScript isolada passou; o servidor do bot tem 186 erros preexistentes neste ambiente, sem diagnóstico novo na comparação com os arquivos anteriores. Não foram instaladas dependências nem alterado `node_modules`.
