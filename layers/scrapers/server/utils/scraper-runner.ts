import type { VehicleSource, VehicleRecord } from '#shared/types/vehicle'
import type { AuctionFilters } from '#shared/types/filters'
import { buildExternalId } from '#shared/utils/hash'
import type { RawScrapedVehicle, ScraperSource } from './source-types'
import { filterVehiclesByGeo } from './location-filter'
import { vsVeiculosSource } from './sources/vs-veiculos'
import { sodreSource } from './sources/sodre'
import { copartSource } from './sources/copart'
import { favaretoSource } from './sources/favareto'
import { megaleiloesSource } from './sources/megaleiloes'
import { lucineiSource } from './sources/lucinei'
import { vardanaSource } from './sources/vardana'
import { claudioKussSource } from './sources/claudio-kuss'
import { superbidSource } from './sources/superbid'
import { leiloesJudiciaisSource } from './sources/leiloesjudiciais'
import { vipLeiloesSource } from './sources/vipleiloes'
import { mglSource } from './sources/mgl'

const ALL_SOURCES: ScraperSource[] = [
  vsVeiculosSource,
  sodreSource,
  copartSource,
  favaretoSource,
  megaleiloesSource,
  lucineiSource,
  vardanaSource,
  claudioKussSource,
  superbidSource,
  leiloesJudiciaisSource,
  vipLeiloesSource,
  mglSource,
]

const TTL_MS = 30 * 24 * 60 * 60 * 1000

async function toVehicleRecord(
  raw: RawScrapedVehicle,
  now: Date,
): Promise<Omit<VehicleRecord, '_id'>> {
  const externalId = await buildExternalId(raw.source, raw.url)
  const titleParts = [raw.brand, raw.model, raw.year?.toString()].filter(Boolean)
  const title = titleParts.join(' ')
  return {
    source: raw.source,
    externalId,
    brand: raw.brand,
    model: raw.model,
    year: raw.year,
    color: raw.color ?? null,
    km: raw.km ?? null,
    fuel: raw.fuel ?? null,
    title,
    description: raw.description,
    price: raw.price,
    priceRaw: raw.priceRaw,
    url: raw.url,
    imageUrls: raw.imageUrls,
    auctionDate: raw.auctionDate,
    lot: raw.lot ?? null,
    damage: raw.damage,
    yard: raw.yard,
    fipe: raw.fipe ?? null,
    fipeCode: null,
    fipeReferenceMonth: null,
    fipeFuel: null,
    fipeCheckedAt: null,
    fipeBrandMatched: null,
    fipeModelMatched: null,
    location: raw.yard,
    city: null,
    state: null,
    scrapedAt: now,
    expiresAt: new Date(now.getTime() + TTL_MS),
    status: 'scraped',
    sentAt: null,
    sentTo: null,
  }
}

export interface RunScrapersOptions {
  headless?: boolean
  onVehicle?: (v: VehicleRecord) => void
  log?: (msg: string) => void
}

export interface RunScrapersResult {
  total: number
  inserted: number
  skipped: number
  errors: Record<string, string>
}

export async function runScrapers(
  sourceIds: VehicleSource[] | null,
  options?: RunScrapersOptions,
): Promise<RunScrapersResult> {
  const log = options?.log ?? (() => {})
  const headless = options?.headless ?? true

  useDb()

  const filtersDoc = await FilterModel.findOne().lean()
  const filters: AuctionFilters = (filtersDoc as unknown as AuctionFilters) ?? {
    states: ['PR', 'SC', 'SP', 'RS'],
    cities: [],
    comboRules: [],
    updatedAt: new Date(),
  }

  const sourcesToRun = sourceIds
    ? ALL_SOURCES.filter((s) => sourceIds.includes(s.id))
    : ALL_SOURCES

  const now = new Date()
  const result: RunScrapersResult = { total: 0, inserted: 0, skipped: 0, errors: {} }

  await Promise.all(
    sourcesToRun.map(async (source) => {
      try {
        log(`[runner] Iniciando ${source.id}...`)
        const rawVehicles = await source.run(filters, { headless, log })
        log(`[runner] ${source.id}: ${rawVehicles.length} resultado(s) bruto(s).`)

        const { vehicles: filtered, skipped } = filterVehiclesByGeo(rawVehicles, filters)
        result.skipped += skipped
        if (skipped > 0) {
          log(`[runner] ${source.id}: ${skipped} descartado(s) por filtro geográfico.`)
        }

        for (const raw of filtered) {
          result.total++
          const record = await toVehicleRecord(raw, now)

          const doc = await VehicleModel.findOneAndUpdate(
            { externalId: record.externalId },
            { $setOnInsert: record },
            { upsert: true, new: true, lean: true },
          )

          if (doc) {
            const vehicle: VehicleRecord = {
              ...doc,
              _id: String((doc as Record<string, unknown>)['_id']),
            } as VehicleRecord
            result.inserted++
            options?.onVehicle?.(vehicle)
          }
        }

        log(`[runner] ${source.id}: concluído.`)
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`[runner] ${source.id} ERRO: ${msg}`)
        result.errors[source.id] = msg
      }
    }),
  )

  return result
}
