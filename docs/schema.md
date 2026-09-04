# Schema — Tipos e Contratos de Dados

## VehicleRecord — Schema Canônico

Toda fonte de scraping converte seu resultado para este tipo antes de persistir.
Definido em `layers/core/types/vehicle.ts`.

```typescript
type VehicleSource =
  | "facebook-marketplace"
  | "vs-veiculos"
  | "sodre"
  | "copart"
  | "favareto"
  | "claudio-kuss"
  | "lucinei"
  | "vardana"
  | "megaleiloes"
  | "superbid"
  | "leiloesjudiciais"
  | "vipleiloes"
  | "mgl"
  | "ph-batidos"

type VehicleStatus = "scraped" | "sent" | "favorite"
type VehicleAuctionStatus = "unknown" | "upcoming" | "future" | "finished"
type VehicleSaleStatus = "unknown" | "sold" | "conditional" | "not_sold"
type ConditionalStatus = "pending" | "approved" | "refused"

interface VehicleRecord {
  _id?: string
  source: VehicleSource
  externalId: string         // sha1(source + url) — garante idempotência

  // Veículo
  brand: string
  model: string
  year: number | null
  color: string | null
  km: string | null
  fuel: string | null

  // Anúncio
  title: string
  description: string
  version: string | null
  category: string | null
  price: number | null
  priceRaw: string | null
  url: string
  imageUrls: string[]

  // Leilão (null para marketplace)
  auctionDate: Date | null
  lot: string | null
  damage: string | null
  yard: string | null
  consignor: string | null     // comitente capturado na sala ao vivo, quando disponível
  auctionStatus: VehicleAuctionStatus
  auctionStatusRaw: string | null
  auctionStatusCheckedAt: Date | null
  saleStatus: VehicleSaleStatus
  saleStatusRaw: string | null
  saleStatusCheckedAt: Date | null
  conditionalStatus: ConditionalStatus | null
  conditionalStatusRaw: string | null
  conditionalOriginalAuctionDate: Date | null
  conditionalStatusCheckedAt: Date | null
  soldPrice: number | null
  soldPriceRaw: string | null

  // FIPE
  fipe: number | null
  fipeCode: string | null
  fipeReferenceMonth: string | null
  fipeFuel: string | null
  fipeCheckedAt: Date | null
  fipeBrandMatched: string | null
  fipeModelMatched: string | null

  // Localização
  location: string | null
  city: string | null
  state: string | null

  // Metadados
  scrapedAt: Date
  expiresAt: Date            // TTL — 5 anos ou auctionDate + 72h quando sem price

  // Status
  status: VehicleStatus
  sentAt: Date | null
  sentTo: string | null      // número WhatsApp destino
}
```

### Regras de preenchimento

- Campos desconhecidos: `null` — nunca string vazia ou `undefined`
- `expiresAt` fica cinco anos após `scrapedAt` para registros com valor/resultados históricos.
- Se `auctionDate != null && price == null`, `expiresAt = auctionDate + 72h`
- Se `auctionDate + 72h <= now && price == null`, o veículo não deve ser persistido
- `auctionStatus` representa o ciclo do leilão e não substitui `status` de envio
- `saleStatus` representa o resultado conhecido da venda; `sold`, `conditional` e `not_sold` devem aparecer em "Passados"
- `conditionalStatus` detalha apenas condicionais Copart: `pending` enquanto o banco não respondeu, `approved` quando a venda é finalizada ou permanece sem nova data após três dias, `refused` quando a data avança e o lote volta a aceitar lances e `removed` quando o endpoint estrutural confirma que o lote ficou indisponível
- `conditionalOriginalAuctionDate` preserva a data do leilão que gerou a condicional, mesmo quando uma recusa atualiza `auctionDate` para o novo leilão
- Cada reconsulta gera um documento em `copart_conditional_attempts`, mantendo `runId`, origem da execução, timestamps, resultado, duração e eventual erro sem alterar o histórico do lote além do resultado consolidado
- Em Copart, `Venda Futura` em lote novo segue como `auctionStatus = "future"`; se o lote já tinha leilão anterior conhecido, o runner grava `saleStatus = "not_sold"` e `auctionStatus = "finished"`
- Registros legados sem `auctionStatus` são normalizados na resposta da API como `finished` quando `auctionDate` já passou; em Copart, o raw inferido é `Venda Finalizada`
- `auctionStatus = "finished"` não deve aparecer em "Próximos"
- `auctionStatus = "finished"` sem `saleStatus = "sold"` não deve ser enviado por WhatsApp
- `saleStatus = "sold"` pode ser enviado por WhatsApp como resultado vendido, com `soldPrice` e `% FIPE` quando disponíveis
- Grande monta, sucata, perda total e irrecuperável não devem ser persistidos/exibidos nas listas de compra
- `externalId = sha1(source + url)` — upsert por este campo
- Índice TTL no MongoDB: `{ expiresAt: 1 }` com `expireAfterSeconds: 0`

---

## FavoriteRecord

Criado ao enviar um veículo para o WhatsApp. Sem TTL — permanente.
Collection: `favorites`.

```typescript
interface FavoriteRecord {
  _id?: string
  vehicleId: string          // referência ao VehicleRecord._id
  source: VehicleSource
  brand: string
  model: string
  year: number | null
  url: string
  imageUrls: string[]

  // Valores na época do envio
  priceAtSend: number | null
  fipeAtSend: number | null
  fipePercent: number | null // Math.round((priceAtSend / fipeAtSend) * 100)
  sentAt: Date
  sentTo: string             // número WhatsApp

  // Rastreamento pós-venda (preenchido manualmente)
  soldPrice: number | null
  soldAt: Date | null
  soldFipe: number | null
  soldFipePercent: number | null
  notes: string | null
  historyCheckedAt: Date | null
}
```

---

## AuctionFilters

Configuração de filtros geográficos e regras de inclusão/exclusão.
Collection: `auction_filters`.

```typescript
interface AuctionFilters {
  states: string[]           // ex: ["PR", "SC", "SP", "RS"]
  cities: string[]           // filtro adicional de cidades
  comboRules: AuctionComboRule[]
  updatedAt: Date
}

interface AuctionComboRule {
  enabled: boolean
  mode: "include" | "exclude"
  brand?: string
  model?: string
  text?: string
  minYear?: number
}
```

---

## CopartLiveAuctionEvent

Eventos capturados na tela de leilão ao vivo da Copart.
Collection: `copart_live_auction_events`.

```typescript
type CopartLiveEventType = "snapshot" | "bid" | "closed" | "sale" | "status"
type CopartLiveSaleStatus = "open" | "sold" | "conditional" | null

interface CopartLiveAuctionEvent {
  eventKey: string              // idempotência por leilão/lote/tipo/valor/mensagem
  source: "copart-live"
  auctionId: string | null
  lot: string | null            // número sequencial do leilão ao vivo
  code: string | null           // código Copart do lote
  description: string | null
  version: string | null
  yearModel: string | null
  brand: string | null
  model: string | null
  fipe: number | null
  fipeRaw: string | null
  damage: string | null         // tipo de monta
  yard: string | null
  bid: number | null
  bidRaw: string | null
  saleStatus: CopartLiveSaleStatus
  eventType: CopartLiveEventType
  fipePercent: number | null    // Math.round((bid / fipe) * 100)
  imageUrl: string | null
  vehicleUrl: string | null
  message: string | null        // linha "Sistema:" ou status visível
  observedAt: Date
  updatedAt: Date
  createdAt: Date
}
```

---

## Collections MongoDB

| Collection | Tipo | TTL | Propósito |
|---|---|---|---|
| `scraped_vehicles` | VehicleRecord | 5 anos | Veículos coletados pelo scraping e histórico de leilões |
| `favorites` | FavoriteRecord | Nenhum | Veículos enviados ao WhatsApp |
| `auction_filters` | AuctionFilters | Nenhum | Configuração de filtros |
| `fipe_cache` | FipeCacheEntry | 30 dias | Cache de consultas FIPE |
| `marketplace_commands` | MarketplaceCommand | Nenhum | Fila de comandos do worker WhatsApp |
| `marketplace_worker_heartbeats` | WorkerHeartbeat | Nenhum | Saúde do worker |
| `copart_live_auction_events` | CopartLiveAuctionEvent | Nenhum | Lances e resultado vendido/condicional da Copart ao vivo |
| `copart_conditional_attempts` | CopartConditionalAttempt | Nenhum | Auditoria assíncrona das tentativas automáticas e manuais de reconsulta de condicionais |
| `auctions` | AuctionRecord | Nenhum | Configuração e estado dos leilões públicos |
| `auction_bids` | BidRecord | Nenhum | Lances e decisões de aprovação |
| `whatsapp_communities` | WhatsAppCommunityRecord | Nenhum | Comunidade principal e grupo de avisos da Z-API |
| `whatsapp_events` | WhatsAppEventRecord | Nenhum | Outbox de avisos de publicação, lance aceito e finalização |

### Leilões públicos

Os contratos TypeScript ficam em `shared/types/auction.ts` e os schemas Mongoose em
`layers/auctions/server/utils/schemas/auction.ts`. O valor monetário é armazenado em reais
inteiros. `currentBid = null` significa que ainda não houve lance aceito; nesse caso, o próximo
lance é `startingBid`, caso contrário é `currentBid + increment`.

O campo `amount` de um lance é calculado pelo servidor. A URL pública usa `publicSlug` aleatório e
os nomes retornados para visitantes são mascarados. `whatsapp_events` funciona como outbox: o
evento é criado antes da tentativa de envio e pode ficar `failed` sem alterar o resultado do leilão.
