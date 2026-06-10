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

type VehicleStatus = "scraped" | "sent" | "favorite"

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
  price: number | null
  priceRaw: string | null
  url: string
  imageUrls: string[]

  // Leilão (null para marketplace)
  auctionDate: Date | null
  lot: string | null
  damage: string | null
  yard: string | null

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
  expiresAt: Date            // TTL 30 dias — definido no insert, nunca alterar depois

  // Status
  status: VehicleStatus
  sentAt: Date | null
  sentTo: string | null      // número WhatsApp destino
}
```

### Regras de preenchimento

- Campos desconhecidos: `null` — nunca string vazia ou `undefined`
- `expiresAt = new Date(scrapedAt.getTime() + 30 * 24 * 60 * 60 * 1000)`
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
| `scraped_vehicles` | VehicleRecord | 30 dias | Veículos coletados pelo scraping |
| `favorites` | FavoriteRecord | Nenhum | Veículos enviados ao WhatsApp |
| `auction_filters` | AuctionFilters | Nenhum | Configuração de filtros |
| `fipe_cache` | FipeCacheEntry | 30 dias | Cache de consultas FIPE |
| `marketplace_commands` | MarketplaceCommand | Nenhum | Fila de comandos do worker WhatsApp |
| `marketplace_worker_heartbeats` | WorkerHeartbeat | Nenhum | Saúde do worker |
| `copart_live_auction_events` | CopartLiveAuctionEvent | Nenhum | Lances e resultado vendido/condicional da Copart ao vivo |
