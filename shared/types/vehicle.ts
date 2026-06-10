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

export type VehicleStatus = 'scraped' | 'sent' | 'favorite'

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
  expiresAt: Date // TTL 30 dias — definido no insert, nunca alterar depois

  // Status
  status: VehicleStatus
  sentAt: Date | null
  sentTo: string | null // número WhatsApp destino
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
