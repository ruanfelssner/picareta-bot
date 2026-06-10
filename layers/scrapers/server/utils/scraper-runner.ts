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

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const NO_SALE_POST_AUCTION_TTL_MS = 72 * 60 * 60 * 1000

type MutableVehicleRecordFields = Pick<
  VehicleRecord,
  | 'brand'
  | 'model'
  | 'year'
  | 'color'
  | 'km'
  | 'fuel'
  | 'title'
  | 'description'
  | 'price'
  | 'priceRaw'
  | 'imageUrls'
  | 'auctionDate'
  | 'lot'
  | 'damage'
  | 'yard'
  | 'location'
  | 'city'
  | 'state'
>

type InsertOnlyVehicleRecordFields = Pick<
  VehicleRecord,
  | 'source'
  | 'externalId'
  | 'url'
  | 'fipe'
  | 'fipeCode'
  | 'fipeReferenceMonth'
  | 'fipeFuel'
  | 'fipeCheckedAt'
  | 'fipeBrandMatched'
  | 'fipeModelMatched'
  | 'scrapedAt'
  | 'expiresAt'
  | 'status'
  | 'sentAt'
  | 'sentTo'
>

function isValidDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function hasSaleValue(vehicle: Pick<RawScrapedVehicle, 'price'>): boolean {
  return vehicle.price != null && vehicle.price > 0
}

function getNoSaleAuctionExpiresAt(auctionDate: Date | null): Date | null {
  if (!isValidDate(auctionDate)) return null
  return new Date(auctionDate.getTime() + NO_SALE_POST_AUCTION_TTL_MS)
}

function getVehicleExpiresAt(raw: RawScrapedVehicle, now: Date): Date {
  const noSaleAuctionExpiresAt = !hasSaleValue(raw)
    ? getNoSaleAuctionExpiresAt(raw.auctionDate)
    : null

  return noSaleAuctionExpiresAt ?? new Date(now.getTime() + DEFAULT_TTL_MS)
}

function isExpiredNoSaleAuction(raw: RawScrapedVehicle, now: Date): boolean {
  if (hasSaleValue(raw)) return false

  const expiresAt = getNoSaleAuctionExpiresAt(raw.auctionDate)
  return expiresAt != null && expiresAt.getTime() <= now.getTime()
}

async function pruneExpiredNoSaleAuctions(now: Date, log: (msg: string) => void): Promise<number> {
  const auctionCutoff = new Date(now.getTime() - NO_SALE_POST_AUCTION_TTL_MS)
  const res = await VehicleModel.deleteMany({
    auctionDate: { $lte: auctionCutoff },
    price: null,
  })

  const deleted = res.deletedCount ?? 0
  if (deleted > 0) {
    log(`[runner] Cache: ${deleted} veículo(s) sem venda removido(s) após 72h do leilão.`)
  }

  return deleted
}

function getMutableVehicleFields(record: Omit<VehicleRecord, '_id'>): MutableVehicleRecordFields {
  return {
    brand: record.brand,
    model: record.model,
    year: record.year,
    color: record.color,
    km: record.km,
    fuel: record.fuel,
    title: record.title,
    description: record.description,
    price: record.price,
    priceRaw: record.priceRaw,
    imageUrls: record.imageUrls,
    auctionDate: record.auctionDate,
    lot: record.lot,
    damage: record.damage,
    yard: record.yard,
    location: record.location,
    city: record.city,
    state: record.state,
  }
}

function getInsertOnlyVehicleFields(record: Omit<VehicleRecord, '_id'>): InsertOnlyVehicleRecordFields {
  return {
    source: record.source,
    externalId: record.externalId,
    url: record.url,
    fipe: record.fipe,
    fipeCode: record.fipeCode,
    fipeReferenceMonth: record.fipeReferenceMonth,
    fipeFuel: record.fipeFuel,
    fipeCheckedAt: record.fipeCheckedAt,
    fipeBrandMatched: record.fipeBrandMatched,
    fipeModelMatched: record.fipeModelMatched,
    scrapedAt: record.scrapedAt,
    expiresAt: record.expiresAt,
    status: record.status,
    sentAt: record.sentAt,
    sentTo: record.sentTo,
  }
}

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
    city: raw.city ?? null,
    state: raw.state ?? null,
    scrapedAt: now,
    expiresAt: getVehicleExpiresAt(raw, now),
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
  await pruneExpiredNoSaleAuctions(now, log)

  const result: RunScrapersResult = { total: 0, inserted: 0, skipped: 0, errors: {} }
  const newVehicleIds: string[] = []

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

        let expiredNoSaleSkipped = 0
        for (const raw of filtered) {
          if (isExpiredNoSaleAuction(raw, now)) {
            result.skipped++
            expiredNoSaleSkipped++
            continue
          }

          result.total++
          const record = await toVehicleRecord(raw, now)

          const res = await VehicleModel.updateOne(
            { externalId: record.externalId },
            {
              $set: getMutableVehicleFields(record),
              $setOnInsert: getInsertOnlyVehicleFields(record),
            },
            { upsert: true },
          )

          if (res.upsertedCount > 0 && res.upsertedId) {
            const id = String(res.upsertedId)
            newVehicleIds.push(id)
            const vehicle: VehicleRecord = { ...record, _id: id } as VehicleRecord
            result.inserted++
            options?.onVehicle?.(vehicle)
          }
        }

        if (expiredNoSaleSkipped > 0) {
          log(`[runner] ${source.id}: ${expiredNoSaleSkipped} ignorado(s) por leilão vencido há mais de 72h sem venda.`)
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

  if (newVehicleIds.length > 0) {
    log(`[fipe] Iniciando enriquecimento de ${newVehicleIds.length} veículo(s) novo(s)...`)
    await enrichVehiclesWithFipe(newVehicleIds, log)
  }

  return result
}
