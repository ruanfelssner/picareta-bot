import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '#shared/constants/sources'
import type { VehicleSource } from '#shared/types/vehicle'
import { escapeRegex, httpsUrl, listing, type Listing, type ListingCondition } from '../listing'
import { McpToolError, withTimeout } from '../runtime'

/**
 * Veículos de leilão já coletados (`scraped_vehicles`). Reaproveita `GET /api/vehicles` por chamada
 * interna do Nitro — mesmos filtros, deduplicação e ciclo de vida da tela, sem copiar a consulta.
 * Não dispara scraping: a coleta continua sendo responsabilidade do cron/Picareta.
 */

const REQUEST_TIMEOUT_MS = 20_000

export type AuctionPeriod = 'upcoming' | 'today' | 'tomorrow' | 'all' | 'past'
export type AuctionSort = 'recommended' | 'auction_date' | 'price_asc' | 'price_desc' | 'year_desc' | 'fipe_asc' | 'km_asc'

export interface AuctionSearchInput {
  query: string | null
  minPrice: number | null
  maxPrice: number | null
  minYear: number | null
  maxYear: number | null
  states: string[]
  sources: string[]
  period: AuctionPeriod
  maxFipePercent: number | null
  applyUserFilters: boolean
  sort: AuctionSort
  maxResults: number
}

interface VehicleResponseItem {
  source: VehicleSource
  title?: string | null
  brand?: string | null
  model?: string | null
  year?: number | null
  km?: string | null
  fuel?: string | null
  price?: number | null
  priceRaw?: string | null
  fipe?: number | null
  url: string
  imageUrls?: string[]
  auctionDate?: string | null
  lot?: string | null
  damage?: string | null
  condition?: string | null
  location?: string | null
  city?: string | null
  state?: string | null
  yard?: string | null
  auctionStatus?: string | null
  saleStatus?: string | null
}

interface VehiclesResponse {
  vehicles: VehicleResponseItem[]
  total: number
}

export interface AuctionListing extends Listing {
  vehicle: { brand: string | null, model: string | null, year: number | null, km: string | null, fuel: string | null }
  auction: {
    date: string | null
    lot: string | null
    status: string | null
    saleStatus: string | null
    fipe: number | null
    /** Lance atual em % da FIPE (quanto menor, melhor). */
    fipePercent: number | null
  }
}

export const AUCTION_SOURCE_IDS = ACTIVE_AUCTION_SOURCES

function conditionOf(damage: string | null | undefined): ListingCondition {
  if (!damage) return null
  return /monta|sinistr|batid|colis|alag|inc[eê]ndi|sucata/i.test(damage) ? 'sinistrado' : 'usado'
}

function toListing(vehicle: VehicleResponseItem): AuctionListing | null {
  const url = httpsUrl(vehicle.url)
  if (!url) return null
  const name = [vehicle.brand, vehicle.model].filter(Boolean).join(' ').trim()
  const place = [vehicle.city, vehicle.state].filter(Boolean).join(' - ') || vehicle.location || vehicle.yard || null
  const price = typeof vehicle.price === 'number' ? vehicle.price : null
  const fipe = typeof vehicle.fipe === 'number' && vehicle.fipe > 0 ? vehicle.fipe : null
  const conditionDetail = vehicle.damage ?? vehicle.condition ?? null

  return {
    ...listing({
      title: vehicle.title?.trim() || name || 'Veículo de leilão',
      price,
      priceText: vehicle.priceRaw ?? null,
      location: place,
      condition: conditionOf(conditionDetail),
      conditionDetail,
      oemCode: null,
      imageUrl: httpsUrl(vehicle.imageUrls?.[0]),
      url,
      platform: vehicle.source,
      platformName: SOURCE_META[vehicle.source]?.name ?? vehicle.source,
    }),
    vehicle: {
      brand: vehicle.brand ?? null,
      model: vehicle.model ?? null,
      year: vehicle.year ?? null,
      km: vehicle.km ?? null,
      fuel: vehicle.fuel ?? null,
    },
    auction: {
      date: vehicle.auctionDate ?? null,
      lot: vehicle.lot ?? null,
      status: vehicle.auctionStatus ?? null,
      saleStatus: vehicle.saleStatus ?? null,
      fipe,
      fipePercent: price != null && fipe != null ? Math.round((price / fipe) * 100) : null,
    },
  }
}

export async function searchAuctions(input: AuctionSearchInput) {
  const unknownSources = input.sources.filter(source => !AUCTION_SOURCE_IDS.includes(source as VehicleSource))
  if (unknownSources.length > 0) {
    throw new McpToolError(`Fonte(s) de leilão desconhecida(s): ${unknownSources.join(', ')}. Válidas: ${AUCTION_SOURCE_IDS.join(', ')}.`)
  }

  const query: Record<string, string | number> = {
    page: 1,
    limit: input.maxResults,
    sort: input.sort,
    period: input.period,
    rules: input.applyUserFilters ? 'true' : 'false',
  }
  // A rota usa o texto como regex no Mongo; escapar evita erro com "(", "+", etc.
  if (input.query) query.search = escapeRegex(input.query)
  if (input.minPrice != null) query.minPrice = input.minPrice
  if (input.maxPrice != null) query.maxPrice = input.maxPrice
  if (input.minYear != null) query.minYear = input.minYear
  if (input.maxYear != null) query.maxYear = input.maxYear
  if (input.states.length > 0) query.states = input.states.join(',')
  if (input.sources.length > 0) query.sources = input.sources.join(',')
  if (input.maxFipePercent != null) query.maxFipePct = input.maxFipePercent

  let response: VehiclesResponse
  try {
    response = await withTimeout($fetch<VehiclesResponse>('/api/vehicles', { query }), REQUEST_TIMEOUT_MS, 'Leilões')
  }
  catch (error) {
    if (error instanceof McpToolError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/banco não conectado|MONGO/i.test(message)) throw new McpToolError('Leilões: banco de dados indisponível no momento.')
    throw error
  }

  const results = response.vehicles
    .map(toListing)
    .filter((item): item is AuctionListing => item !== null)

  return {
    platform: 'leiloes',
    totalMatches: response.total,
    returned: results.length,
    results,
    note: 'Dados da última coleta dos leiloeiros (não é consulta em tempo real). price = lance/valor atual do lote.',
  }
}
