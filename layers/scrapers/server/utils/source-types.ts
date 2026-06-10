import type { VehicleSource } from '#shared/types/vehicle'
import type { AuctionFilters } from '#shared/types/filters'

export interface RawScrapedVehicle {
  source: VehicleSource
  brand: string
  model: string
  year: number | null
  damage: string | null
  price: number | null
  priceRaw: string | null
  imageUrls: string[]
  description: string
  url: string
  auctionDate: Date | null
  lot?: string | null
  yard: string | null
  city?: string | null
  state?: string | null
  km?: string | null
  color?: string | null
  fuel?: string | null
  fipe?: number | null
  fipeRaw?: string | null
}

export interface ScraperOptions {
  headless?: boolean
  log?: (msg: string) => void
}

export interface ScraperSource {
  id: VehicleSource
  name: string
  run(filters: AuctionFilters, options?: ScraperOptions): Promise<RawScrapedVehicle[]>
}
