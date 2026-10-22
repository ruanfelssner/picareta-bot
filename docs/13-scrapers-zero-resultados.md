# Scrapers com "0 encontrados" e Freitas com HTTP 500 — 0.44.2

Execução cloud de 22/10/2026: PH Batidos, Pestana, Favareto e Superbid concluíram com `0 novos · 0 encontrados`; Freitas falhou com `139 lote(s) com falha ... HTTP 500 em .../LoteDetalhes`.

## Causa comum: falha silenciosa

Os coletores convertiam HTTP 403, desafio anti-bot, rede ou estrutura desconhecida em `null`/`[]`. O runner registrava sucesso com zero veículos e o Picareta mostrava a fonte como concluída. Agora falha total da listagem lança erro `[fonte] ...` com o motivo; listagem legitimamente vazia continua retornando `[]`.

Da rede local (IP residencial no Brasil) PH Batidos, Pestana e Favareto responderam normalmente com o código antigo. O bloqueio ao IP do Cloud Run é a hipótese mais provável, não confirmada. Se o próximo disparo mostrar 403/anti-bot, a correção é de infraestrutura (egress com IP no Brasil, proxy ou liberação pelo site), não de parsing.

## Por fonte

| Fonte | Diagnóstico | Correção |
| --- | --- | --- |
| Superbid | A página `/categorias/carros-motos/carros` devolve desafio Cloudflare (HTTP 403) ao `fetch` do Node, mesmo de IP residencial; curl recebe 200. | Coleta pela API `offer-query.superbid.net/seo/offers/` usada pelo próprio site. URL da oferta reconstruída pelo título com a regra do site (150/150 iguais aos hrefs reais), mantendo a chave de deduplicação. Teste: `tests/superbid-scraper.test.ts`. |
| Pestana | Site agora atrás do Azion (bot manager). Busca `/search-api/lote/filtrar` pode responder vazia para o IP do Cloud Run. Cidade/UF chegam como objeto `{name}` e saíam `null`, descartando todos os lotes em filtros geográficos. | UA completo; se a busca falhar ou vier vazia, usa os IDs de lote declarados nos leilões públicos de veículos (cobrem 100% da busca). Cidade/UF lidas de `{name}`/`{nome}`. Erro explícito quando nenhum lote é de veículo. |
| PH Batidos | Sitemap e detalhes atrás do Cloudflare; 403 virava `[]`. | `fetchText` lança em HTTP não 2xx, desafio, timeout (25 s) e rede; retry único em 429/5xx. Falha do sitemap ou de todos os detalhes vira erro. `signal` repassado pelo runner. |
| Favareto | Listagem/editais/API de lotes com falha viravam `[]`. ~65 s por coleta contra timeout de 120 s. | Erros explícitos para bloqueio, estrutura e API de lotes falhando em todos os lotes; decodificação windows-1252; timeout CLI/cloud 240 s. |
| Freitas | O portal responde **HTTP 500 no detalhe de lote inexistente/removido** (ex.: `8111/9999`, `8103/1`) e também oscila com 5xx. Um único lote assim fazia a fonte inteira falhar e, no cloud, todos os veículos coletados eram descartados. | 5xx/timeout no lote entram numa segunda passada após 15 s. Detalhe com HTTP 500 repetido é ignorado como lote indisponível (logado com exemplos); se for mais da metade dos lotes, vira falha "Portal instável". 401/403/429 continuam interrompendo a sessão. |

## Coleta parcial no fluxo CLI/cloud

`PartialScraperResultError` deixa de descartar os veículos já coletados: `runScraperWithRetry` guarda a maior coleta parcial entre tentativas, a fonte continua marcada como falha e `cloud-service` salva esses veículos com `snapshotComplete: false`, sem `snapshotExternalIds`, para não remover anúncios não visitados. O adapter Freitas aplica FIPE também à parcial.

## Validação

```bash
pnpm exec tsx --test tests/freitas-scraper.test.ts tests/freitas-session.test.ts tests/superbid-scraper.test.ts tests/pestana-scraper.test.ts
```

47/47 passaram localmente. Após o deploy, rodar cada fonte isoladamente em `/scraping-cloud` e ler o erro exibido: mensagens com `HTTP 403`, `anti-bot`, `Cloudflare` ou `Busca sem lotes` confirmam bloqueio do IP de saída.

## MGL e versão no `/health` — 0.44.3

Primeira execução após 0.44.2 ainda mostrou Favareto, Superbid e PH Batidos como concluídos com 0, resultado que o código novo não produz em bloqueio: indício de que o serviço ainda rodava a imagem anterior. `GET /health` do scraper passa a informar `version` (lida do `package.json`) para confirmar o deploy antes de avaliar uma execução.

MGL também concluía com 0. Causas, todas reproduzidas ao vivo:

1. A API `POST /apiplugin/GetBusca/...` responde 403 Cloudflare ao `fetch` do Node em qualquer IP (fingerprint TLS); só o navegador funciona.
2. `looksLikeCloudflareChallenge` procurava `cdn-cgi/challenge-platform`, script que o Cloudflare injeta em toda página normal; o fallback do navegador se considerava bloqueado e o `catch` devolvia `[]`.
3. O script JSD do Cloudflare marca o Chromium headless e a API passa a responder 403; o navegador agora aborta esse script (e imagens/fontes/CSS) e vai direto a `/comprar/`.
4. Funções nomeadas dentro de `page.evaluate` recebem `__name(...)` do tsx (produção roda `src/` via tsx) e quebram na página.

Falha total vira `[mgl] HTTP direto falhou (...) e o navegador também falhou: ...`. Coleta local: 323 veículos em ~5 s. Teste: `tests/mgl-scraper.test.ts`.
