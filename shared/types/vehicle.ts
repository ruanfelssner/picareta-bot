export type VehicleSource =
  | 'facebook-marketplace'
  | 'vs-veiculos'
  | 'sodre'
  | 'copart'
  | 'favareto'
  | 'claudio-kuss'
  | 'lucinei'
  | 'vardana'
  | 'megaleiloes'
  | 'superbid'
  | 'leiloesjudiciais'
  | 'vipleiloes'
  | 'mgl'
  | 'ph-batidos'

export type VehicleStatus = 'scraped' | 'sent' | 'favorite'
export type VehicleAuctionStatus = 'unknown' | 'upcoming' | 'future' | 'finished'
export type VehicleSaleStatus = 'unknown' | 'sold' | 'conditional' | 'not_sold'

export interface VehicleRecord {
  _id?: string
  source: VehicleSource
  externalId: string // sha1(source + url) — garante idempotência

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
  consignor: string | null
  auctionStatus: VehicleAuctionStatus
  auctionStatusRaw: string | null
  auctionStatusCheckedAt: Date | null
  saleStatus: VehicleSaleStatus
  saleStatusRaw: string | null
  saleStatusCheckedAt: Date | null
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
  expiresAt: Date // TTL do cache — 5 anos ou auctionDate + 72h quando sem price

  // Status
  status: VehicleStatus
  sentAt: Date | null
  sentTo: string | null // número WhatsApp destino

  // Origem da captura — marca registros tocados pela extensão de leilão ao vivo,
  // que compartilha a coleção com o scraper server-side das mesmas fontes (copart/vipleiloes)
  collectedVia: 'extension' | null
}

export interface FavoriteRecord {
  _id?: string
  vehicleId: string // referência ao VehicleRecord._id
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
  sentTo: string // número WhatsApp

  // Rastreamento pós-venda (preenchido manualmente)
  soldPrice: number | null
  soldAt: Date | null
  soldFipe: number | null
  soldFipePercent: number | null
  notes: string | null
  historyCheckedAt: Date | null
}
