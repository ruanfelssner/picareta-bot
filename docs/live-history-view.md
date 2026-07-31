# Histórico Live — tela e endpoint

Tela de leitura do que a extensão de leilão ao vivo (`.extension/copart-live-collector`) já
salvou no MongoDB, com filtros simples. Não tem regras de compra, de exibição ou dedupe —
é só um log filtrável do que aconteceu, separado do buscador principal (`/cars`).

## Onde fica

- Página: [`app/pages/live-history.vue`](../app/pages/live-history.vue), rota `/live-history`,
  link "Histórico Live" no menu (`app/layouts/default.vue`).
- Endpoint: [`layers/cars/server/api/vehicles/live-history.get.ts`](../layers/cars/server/api/vehicles/live-history.get.ts).

## Por que não é só `GET /api/vehicles` filtrado por fonte

`scraped_vehicles` é uma coleção compartilhada: o mesmo `source` (`copart`, `vipleiloes`, `sodre`) é
gravado tanto pela extensão (modo Banco, evento a evento, só quando o lote fecha) quanto pelos
scrapers automáticos (`layers/scrapers/server/utils/sources/copart.ts`, `vipleiloes.ts`, `sodre.ts`).
Filtrar só por `source` misturaria as duas origens.

O que separa as duas origens, na maioria dos casos:

- `POST /api/vehicles/ingest` (usado pela extensão) **rejeita** qualquer evento cujo
  `saleStatus` não seja final — ver `FINAL_SALE_STATUSES` em
  [`ingest.post.ts`](../layers/cars/server/api/vehicles/ingest.post.ts). Ou seja, todo registro
  tocado pela extensão sempre tem `saleStatus` em `sold` / `conditional` / `not_sold`.
- O scraper automático de Copart grava principalmente lotes futuros, com `saleStatus: "unknown"`.

Por isso o endpoint de histórico restringe por padrão a `saleStatus` finalizado — isso já isola boa
parte do que a extensão capturou, sem exigir um filtro extra. Também é o comportamento certo para
uma tela de "histórico" (o que já aconteceu), diferente do `/cars`, que por padrão mostra só leilões
futuros.

**Essa heurística não é suficiente para a Sodré.** O scraper automático `sodre.ts` consulta a API de
busca de lotes do site, que já expõe `lot_status_id` — ele grava `saleStatus` finalizado
(`sold`/`conditional`) o tempo todo, não só quando o lote realmente fecha ao vivo. Então, para
`source: "sodre"`, filtrar por status final praticamente não separa scraper de extensão.

Por isso existe o campo `collectedVia: 'extension' | null` em `VehicleRecord`, gravado pelo
`ingest.post.ts` a cada evento da extensão. O parâmetro `onlyExtension=true` do endpoint filtra por
esse campo e é a única forma confiável de isolar a Sodré. Ele não é o filtro padrão porque registros
gravados antes dessa marcação existir não têm o campo preenchido (ficariam escondidos à toa para
Copart/VIP); para Sodré, ligar o toggle "Somente extensão (ao vivo)" na tela é necessário para não
ver o scraper automático misturado.

## Contrato do endpoint

```
GET /api/vehicles/live-history
```

### Query params

| Param | Tipo | Default | Descrição |
|---|---|---|---|
| `page` | number | `1` | Página (1-based) |
| `limit` | number | `50` | Máximo `200` |
| `sort` | `recent \| price_desc \| price_asc \| fipe_asc` | `recent` | `recent` = data de captura do resultado desc |
| `period` | `today \| 7d \| 30d \| all` | `all` | Filtra pela data de captura do resultado (`saleStatusCheckedAt`, com fallback para registros legados) |
| `sources` | string (csv) | `copart,vipleiloes,sodre` | Só aceita fontes da extensão; outras são ignoradas |
| `states` | string (csv de UF) | — | Filtra `state` exato (ex: `PR,SP`) |
| `saleStatus` | string (csv) | `sold,conditional,not_sold` | Restringe ainda mais o conjunto final |
| `search` | string | — | Regex case-insensitive em `brand`, `model`, `title`, `consignor` |
| `onlyExtension` | `true \| false` | `false` | Filtra por `collectedVia: "extension"` — necessário para isolar a Sodré (ver acima) |

### Resposta

```typescript
{
  vehicles: VehicleRecord[]  // ver shared/types/vehicle.ts
  total: number
  page: number
  limit: number
}
```

`VehicleRecord` é o schema canônico (ver [`docs/schema.md`](./schema.md)); não tem
transformação além do filtro de `imageUrls` inúteis (`isUsableVehicleImageUrl`).

### Exemplo

```bash
curl "http://localhost:3000/api/vehicles/live-history?saleStatus=sold&states=PR&period=7d&limit=20"
```

## Filtros na tela

Reaproveita os componentes de UI do buscador (`UiChip`, `UiInput`, `UiSelect`, `UiButton`),
mas com um conjunto reduzido, sincronizado na querystring (mesmo padrão de `app/pages/cars/index.vue`):

- Busca (marca/modelo/título/comitente)
- Origem (Copart / VIP Leilões / Sodré Santoro)
- Somente extensão (ao vivo) — toggle para `onlyExtension`
- Status (Vendido / Condicional / Não vendido)
- Período (Hoje / 7 dias / 30 dias / Tudo)
- Estado (UF)
- Ordenação (mais recentes, maior/menor lance, maior margem FIPE)

Sem paginação por cards, sem regras de exibição, sem contadores por faceta — propositalmente
mais simples que `/cars`.

## Limitações conhecidas

- TTL de 30 dias em `scraped_vehicles` (`expiresAt`) — histórico mais antigo que isso some do banco.
- A separação por `saleStatus` finalizado pode, em casos raros, incluir um lote que o próprio
  scraper automático encontrou já finalizado (ver `normalizeCopartSaleStatus` em
  `layers/scrapers/server/utils/sources/copart.ts`). Não afeta a extensão, só significa que
  algum registro "histórico" pode não ter vindo dela.
- Para Sodré, esses casos não são raros — ver a seção acima. Use `onlyExtension=true` quando a
  precisão importar mais do que ver tudo.
