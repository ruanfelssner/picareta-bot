import type { VehicleSource, VehicleRecord } from '#shared/types/vehicle'
import type { AuctionFilters } from '#shared/types/filters'
import { buildExternalId } from '#shared/utils/hash'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperSource } from './source-types'
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
import { fetchVipLeiloesVehicleByUrl, vipLeiloesSource } from './sources/vipleiloes'
import { mglSource } from './sources/mgl'
import { phBatidosSource } from './sources/ph-batidos'

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
  phBatidosSource,
]

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const NO_SALE_POST_AUCTION_TTL_MS = 72 * 60 * 60 * 1000
const DEFAULT_SOURCE_TIMEOUT_MS = 5 * 60 * 1000
const HARD_SOURCE_TIMEOUT_MS = 30 * 60 * 1000

export type ScraperSourceStatus = 'running' | 'success' | 'error' | 'timeout' | 'cancelled'

export interface ScraperSourceStatusEvent {
  source: VehicleSource
  status: ScraperSourceStatus
  message?: string
}

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

type ExistingVehicleDocument = Omit<VehicleRecord, '_id'> & { _id: unknown }

function getDocumentId(doc: { _id: unknown }): string {
  return String(doc._id)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractVsVehicleId(url: string): string | null {
  const match = url.match(/\/id-(\d+)(?:[/?#]|$)/)
  return match?.[1] ?? null
}

function isPreservedStatus(status: VehicleRecord['status']): boolean {
  return status === 'sent' || status === 'favorite'
}

function chooseDuplicateVehicleToKeep(
  docs: ExistingVehicleDocument[],
  record: Omit<VehicleRecord, '_id'>,
): ExistingVehicleDocument | null {
  return (
    docs.find((doc) => isPreservedStatus(doc.status)) ??
    docs.find((doc) => doc.externalId === record.externalId) ??
    docs[0] ??
    null
  )
}

async function reconcileVsVehicleDuplicate(
  record: Omit<VehicleRecord, '_id'>,
  mutableFields: MutableVehicleRecordFields,
  log: (msg: string) => void,
): Promise<boolean> {
  if (record.source !== 'vs-veiculos') return false

  const vsId = extractVsVehicleId(record.url)
  if (!vsId) return false

  const urlPattern = new RegExp(`/id-${escapeRegExp(vsId)}(?:[/?#]|$)`)
  const docs = await VehicleModel.find({ source: 'vs-veiculos', url: urlPattern }).lean()
  const existingDocs = docs as ExistingVehicleDocument[]
  if (existingDocs.length === 0) return false
  if (existingDocs.length === 1 && existingDocs[0]?.externalId === record.externalId) return false

  const keep = chooseDuplicateVehicleToKeep(existingDocs, record)
  if (!keep) return false

  const keepId = getDocumentId(keep)
  const duplicateScrapedIds = existingDocs
    .filter((doc) => getDocumentId(doc) !== keepId && doc.status === 'scraped')
    .map(getDocumentId)

  if (duplicateScrapedIds.length > 0) {
    await VehicleModel.deleteMany({
      _id: { $in: duplicateScrapedIds },
      status: 'scraped',
    })
  }

  try {
    await VehicleModel.updateOne(
      { _id: keepId },
      {
        $set: {
          ...mutableFields,
          externalId: record.externalId,
          url: record.url,
        },
      },
    )
  }
  catch (err) {
    await VehicleModel.updateOne({ _id: keepId }, { $set: mutableFields })
    log(`[runner] vs-veiculos: lote ${vsId} atualizado sem migrar externalId (${err instanceof Error ? err.message : String(err)}).`)
    return true
  }

  const removed = duplicateScrapedIds.length
  log(`[runner] vs-veiculos: lote ${vsId} reconciliado; ${removed} duplicado(s) removido(s).`)
  return true
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
  onVehicle?: (v: VehicleRecord) => Promise<void> | void
  onSourceStatus?: (event: ScraperSourceStatusEvent) => Promise<void> | void
  log?: (msg: string) => void
  signal?: AbortSignal
  sourceTimeoutMs?: number
}

export interface RunScrapersResult {
  total: number
  inserted: number
  skipped: number
  errors: Record<string, string>
}

export interface RefreshVehicleFromSourceOptions {
  headless?: boolean
  log?: (msg: string) => void
  signal?: AbortSignal
}

export async function refreshVehicleFromSource(
  id: string,
  options?: RefreshVehicleFromSourceOptions,
): Promise<VehicleRecord> {
  useDb()

  const existingDoc = await VehicleModel.findById(id).lean()
  if (!existingDoc) throw new Error('Veículo não encontrado.')

  const existing = {
    ...existingDoc,
    _id: String((existingDoc as Record<string, unknown>)['_id']),
  } as VehicleRecord

  if (existing.source !== 'vipleiloes') {
    throw new Error(`Refresh individual não suportado para a fonte ${existing.source}.`)
  }

  const raw = await fetchVipLeiloesVehicleByUrl(existing.url, existing, options)
  const record = await toVehicleRecord(raw, new Date())
  const mutableFields = getMutableVehicleFields(record)

  const updatedDoc = await VehicleModel.findByIdAndUpdate(
    id,
    {
      $set: mutableFields,
    },
    { new: true, lean: true },
  )

  if (!updatedDoc) throw new Error('Veículo não encontrado após a atualização.')

  return {
    ...updatedDoc,
    _id: String((updatedDoc as Record<string, unknown>)['_id']),
  } as VehicleRecord
}

class SourceInterruptedError extends Error {
  readonly status: Extract<ScraperSourceStatus, 'timeout' | 'cancelled'>

  constructor(status: Extract<ScraperSourceStatus, 'timeout' | 'cancelled'>, message: string) {
    super(message)
    this.name = 'SourceInterruptedError'
    Object.setPrototypeOf(this, new.target.prototype)
    this.status = status
  }
}

function parseTimeoutMsFromEnv(): number | null {
  const raw = Number.parseInt((process.env.SCRAPER_SOURCE_TIMEOUT_MS ?? '').trim(), 10)
  return Number.isFinite(raw) ? raw : null
}

function normalizeTimeoutMs(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value) || value <= 0) return DEFAULT_SOURCE_TIMEOUT_MS
  return Math.max(1_000, Math.min(HARD_SOURCE_TIMEOUT_MS, Math.round(value)))
}

function getSourceTimeoutMs(optionValue: number | undefined): number {
  return normalizeTimeoutMs(optionValue ?? parseTimeoutMsFromEnv())
}

function formatDuration(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}min`
  return `${Math.round(ms / 1000)}s`
}

function buildInterruptedError(
  sourceId: VehicleSource,
  status: Extract<ScraperSourceStatus, 'timeout' | 'cancelled'>,
  timeoutMs: number,
): SourceInterruptedError {
  const message = status === 'timeout'
    ? `[runner] ${sourceId}: timeout após ${formatDuration(timeoutMs)}.`
    : `[runner] ${sourceId}: scraping interrompido.`

  return new SourceInterruptedError(status, message)
}

function isSignalAborted(signal: AbortSignal | null): boolean {
  return signal?.aborted === true
}

async function runWithSourceTimeout<T>(
  sourceId: VehicleSource,
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parentSignal?.aborted) {
    throw new SourceInterruptedError('cancelled', `[runner] ${sourceId}: scraping interrompido.`)
  }

  const controller = new AbortController()
  let interruptedStatus: Extract<ScraperSourceStatus, 'timeout' | 'cancelled'> = 'cancelled'

  const abortFromParent = () => {
    interruptedStatus = 'cancelled'
    controller.abort()
  }

  parentSignal?.addEventListener('abort', abortFromParent, { once: true })

  const timeout = setTimeout(() => {
    interruptedStatus = 'timeout'
    controller.abort()
  }, timeoutMs)

  const abortPromise = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener('abort', () => {
      reject(buildInterruptedError(sourceId, interruptedStatus, timeoutMs))
    }, { once: true })
  })

  try {
    return await Promise.race([run(controller.signal), abortPromise])
  }
  catch (err) {
    if (controller.signal.aborted && !(err instanceof SourceInterruptedError)) {
      throw buildInterruptedError(sourceId, interruptedStatus, timeoutMs)
    }
    throw err
  }
  finally {
    clearTimeout(timeout)
    parentSignal?.removeEventListener('abort', abortFromParent)
  }
}

export async function runScrapers(
  sourceIds: VehicleSource[] | null,
  options?: RunScrapersOptions,
): Promise<RunScrapersResult> {
  const log = options?.log ?? (() => {})
  const headless = options?.headless ?? true
  const sourceTimeoutMs = getSourceTimeoutMs(options?.sourceTimeoutMs)

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
        await options?.onSourceStatus?.({ source: source.id, status: 'running' })
        log(`[runner] Iniciando ${source.id}...`)
        let allowStaleCleanup = true
        let rawVehicles: RawScrapedVehicle[] = []
        const seenExternalIds: string[] = []
        const processedExternalIds = new Set<string>()
        let geoSkipped = 0
        let expiredNoSaleSkipped = 0
        let sourceSignal: AbortSignal | null = null

        const processRawVehicle = async (raw: RawScrapedVehicle): Promise<void> => {
          if (isSignalAborted(sourceSignal)) return
          const record = await toVehicleRecord(raw, now)
          if (processedExternalIds.has(record.externalId)) return
          processedExternalIds.add(record.externalId)

          const { vehicles: filtered, skipped } = filterVehiclesByGeo([raw], filters)
          result.skipped += skipped
          if (skipped > 0) {
            geoSkipped += skipped
            return
          }

          const filteredRaw = filtered[0]
          if (!filteredRaw) return

          if (isExpiredNoSaleAuction(filteredRaw, now)) {
            result.skipped++
            expiredNoSaleSkipped++
            return
          }

          result.total++
          seenExternalIds.push(record.externalId)
          const mutableFields = getMutableVehicleFields(record)

          const reconciledDuplicate = await reconcileVsVehicleDuplicate(record, mutableFields, log)
          if (reconciledDuplicate) return

          const res = await VehicleModel.updateOne(
            { externalId: record.externalId },
            {
              $set: mutableFields,
              $setOnInsert: getInsertOnlyVehicleFields(record),
            },
            { upsert: true },
          )

          if (res.upsertedCount > 0 && res.upsertedId) {
            const id = String(res.upsertedId)
            newVehicleIds.push(id)
            const vehicle: VehicleRecord = { ...record, _id: id } as VehicleRecord
            result.inserted++
            await options?.onVehicle?.(vehicle)
          }
        }

        try {
          rawVehicles = await runWithSourceTimeout(
            source.id,
            sourceTimeoutMs,
            options?.signal,
            (signal) => {
              sourceSignal = signal
              return source.run(filters, { headless, log, onVehicle: processRawVehicle, signal })
            },
          )
        }
        catch (err) {
          if (!(err instanceof PartialScraperResultError)) throw err

          rawVehicles = err.vehicles
          allowStaleCleanup = false
          result.errors[source.id] = err.message
          log(`[runner] ${source.id}: ${rawVehicles.length} resultado(s) parcial(is); limpeza de removidos ignorada.`)
        }

        log(`[runner] ${source.id}: ${rawVehicles.length} resultado(s) bruto(s).`)

        for (const raw of rawVehicles) {
          if (isSignalAborted(sourceSignal)) {
            throw new SourceInterruptedError('cancelled', `[runner] ${source.id}: scraping interrompido.`)
          }
          await processRawVehicle(raw)
        }

        if (geoSkipped > 0) {
          log(`[runner] ${source.id}: ${geoSkipped} descartado(s) por filtro geográfico.`)
        }

        if (expiredNoSaleSkipped > 0) {
          log(`[runner] ${source.id}: ${expiredNoSaleSkipped} ignorado(s) por leilão vencido há mais de 72h sem venda.`)
        }

        // Remove only unsent vehicles that no longer appear in the listing.
        if (allowStaleCleanup && seenExternalIds.length > 0) {
          const staleResult = await VehicleModel.deleteMany({
            source: source.id,
            externalId: { $nin: seenExternalIds },
            status: 'scraped',
          })
          if (staleResult.deletedCount > 0) {
            log(`[runner] ${source.id}: ${staleResult.deletedCount} veículo(s) removido(s) do site, excluído(s) do DB.`)
          }
        }
        else if (!allowStaleCleanup) {
          log(`[runner] ${source.id}: limpeza de removidos pulada por coleta parcial.`)
        }

        log(`[runner] ${source.id}: concluído.`)
        await options?.onSourceStatus?.({
          source: source.id,
          status: result.errors[source.id] ? 'error' : 'success',
          message: result.errors[source.id],
        })
      }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`[runner] ${source.id} ERRO: ${msg}`)
        result.errors[source.id] = msg
        await options?.onSourceStatus?.({
          source: source.id,
          status: err instanceof SourceInterruptedError ? err.status : 'error',
          message: msg,
        })
      }
    }),
  )

  if (options?.signal?.aborted) {
    log('[runner] Scraping interrompido; enriquecimento FIPE automático pulado.')
    return result
  }

  if (newVehicleIds.length > 0) {
    log(`[fipe] Iniciando enriquecimento de ${newVehicleIds.length} veículo(s) novo(s)...`)
    await enrichVehiclesWithFipe(newVehicleIds, log)
  }

  return result
}
