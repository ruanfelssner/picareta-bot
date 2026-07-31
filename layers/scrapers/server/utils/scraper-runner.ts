import type { VehicleSource, VehicleRecord } from '#shared/types/vehicle'
import type { AuctionFilters } from '#shared/types/filters'
import { ACTIVE_AUCTION_SOURCES } from '#shared/constants/sources'
import { buildExternalId } from '#shared/utils/hash'
import { isUsableVehicleImageUrl } from '#shared/utils/vehicle-images'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperSource } from './source-types'
import { vsVeiculosSource } from './sources/vs-veiculos'
import { sodreSource } from './sources/sodre'
import { copartSource } from './sources/copart'
import { favaretoSource } from './sources/favareto'
import { megaleiloesSource } from './sources/megaleiloes'
import { vardanaSource } from './sources/vardana'
import { claudioKussSource } from './sources/claudio-kuss'
import { superbidSource } from './sources/superbid'
import { leiloesJudiciaisSource } from './sources/leiloesjudiciais'
import { fetchVipLeiloesVehicleByUrl, vipLeiloesSource } from './sources/vipleiloes'
import { phBatidosSource } from './sources/ph-batidos'

const ALL_SOURCES: ScraperSource[] = [
  vsVeiculosSource,
  sodreSource,
  copartSource,
  favaretoSource,
  megaleiloesSource,
  vardanaSource,
  claudioKussSource,
  superbidSource,
  leiloesJudiciaisSource,
  vipLeiloesSource,
  phBatidosSource,
].filter(source => ACTIVE_AUCTION_SOURCES.includes(source.id))

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000
const NO_SALE_POST_AUCTION_TTL_MS = 72 * 60 * 60 * 1000
const DEFAULT_SOURCE_TIMEOUT_MS = 5 * 60 * 1000
const HARD_SOURCE_TIMEOUT_MS = 30 * 60 * 1000
const DEFAULT_SOURCE_TIMEOUT_MS_BY_SOURCE: Partial<Record<VehicleSource, number>> = {
  vipleiloes: 15 * 60 * 1000,
}
const STRONG_LOT_ID_SOURCES = new Set<VehicleSource>(['copart', 'sodre'])

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
  | 'auctionStatus'
  | 'auctionStatusRaw'
  | 'auctionStatusCheckedAt'
  | 'saleStatus'
  | 'saleStatusRaw'
  | 'saleStatusCheckedAt'
  | 'soldPrice'
  | 'soldPriceRaw'
  | 'location'
  | 'city'
  | 'state'
> & Partial<Pick<
  VehicleRecord,
  | 'fipe'
  | 'fipeCheckedAt'
  | 'consignor'
>>

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
  | 'consignor'
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
    auctionStatus: record.auctionStatus,
    auctionStatusRaw: record.auctionStatusRaw,
    auctionStatusCheckedAt: record.auctionStatusCheckedAt,
    saleStatus: record.saleStatus,
    saleStatusRaw: record.saleStatusRaw,
    saleStatusCheckedAt: record.saleStatusCheckedAt,
    soldPrice: record.soldPrice,
    soldPriceRaw: record.soldPriceRaw,
    location: record.location,
    city: record.city,
    state: record.state,
    ...(record.consignor != null ? { consignor: record.consignor } : {}),
    ...(record.fipe != null
      ? {
          fipe: record.fipe,
          fipeCheckedAt: record.fipeCheckedAt,
        }
      : {}),
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
    consignor: record.consignor,
  }
}

type ExistingVehicleDocument = Omit<VehicleRecord, '_id'> & { _id: unknown }

function getDocumentId(doc: { _id: unknown }): string {
  return String(doc._id)
}

function toVehicleRecordWithId(doc: Omit<VehicleRecord, '_id'> & { _id: unknown }): VehicleRecord {
  return {
    ...doc,
    _id: getDocumentId(doc),
  } as VehicleRecord
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeComparableText(value: string | number | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeLifecycleText(value: string | number | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeLookupUrl(value: string | null | undefined): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  try {
    const parsed = new URL(raw)
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/+$/, '').toLowerCase()
  }
  catch {
    return raw.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase()
  }
}

function isSameLocalDay(left: Date | null, right: Date | null): boolean {
  if (!isValidDate(left) || !isValidDate(right)) return false
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function hasCompatibleVehicleIdentity(
  left: Pick<VehicleRecord, 'brand' | 'model' | 'year'>,
  right: Pick<VehicleRecord, 'brand' | 'model' | 'year'>,
): boolean {
  const leftBrand = normalizeComparableText(left.brand)
  const rightBrand = normalizeComparableText(right.brand)
  const leftModel = normalizeComparableText(left.model)
  const rightModel = normalizeComparableText(right.model)
  if (!leftBrand || !rightBrand || leftBrand !== rightBrand) return false
  if (!leftModel || !rightModel || leftModel !== rightModel) return false
  return left.year == null || right.year == null || left.year === right.year
}

function isStrongLotIdentifier(source: VehicleSource, lot: string | null): boolean {
  const normalizedLot = normalizeComparableText(lot)
  return STRONG_LOT_ID_SOURCES.has(source) && normalizedLot.length >= 5
}

function extractVsVehicleId(url: string): string | null {
  const match = url.match(/\/id-(\d+)(?:[/?#]|$)/)
  return match?.[1] ?? null
}

function getVsLookupImageUrls(record: Omit<VehicleRecord, '_id'>): string[] {
  return Array.from(new Set(record.imageUrls.filter(isUsableVehicleImageUrl))).slice(0, 6)
}

function buildVsDuplicateLookupClauses(record: Omit<VehicleRecord, '_id'>, vsId: string): object[] {
  const clauses: object[] = [
    { url: new RegExp(`/id-${escapeRegExp(vsId)}(?:[/?#]|$)`) },
  ]

  const lot = record.lot?.trim()
  if (lot) clauses.push({ lot })

  const imageUrls = getVsLookupImageUrls(record)
  if (imageUrls.length > 0) clauses.push({ imageUrls: { $in: imageUrls } })

  return clauses
}

function isPreservedStatus(status: VehicleRecord['status']): boolean {
  return status === 'sent' || status === 'favorite'
}

function hasFinalSaleResult(status: VehicleRecord['saleStatus'] | null | undefined): boolean {
  return status === 'sold' || status === 'conditional' || status === 'not_sold'
}

function isCopartFutureSaleDate(record: Pick<VehicleRecord, 'source' | 'auctionStatus' | 'auctionStatusRaw'>): boolean {
  return record.source === 'copart'
    && record.auctionStatus === 'future'
    && normalizeLifecycleText(record.auctionStatusRaw).includes('venda futura')
}

function hasKnownPastCopartAuctionContext(
  existing: Pick<VehicleRecord, 'auctionDate' | 'auctionStatus' | 'saleStatus' | 'damage'>,
  record: Pick<VehicleRecord, 'damage'>,
  now: Date,
): boolean {
  if (existing.auctionStatus === 'finished' || hasFinalSaleResult(existing.saleStatus)) return true

  const hasDamageContext = Boolean(normalizeLifecycleText(existing.damage) || normalizeLifecycleText(record.damage))
  if (!hasDamageContext || !isValidDate(existing.auctionDate)) return false

  return existing.auctionDate.getTime() <= now.getTime()
}

function shouldMarkCopartFutureAsNotSold(
  existing: Pick<VehicleRecord, 'auctionDate' | 'auctionStatus' | 'saleStatus' | 'damage'>,
  record: Omit<VehicleRecord, '_id'>,
  now: Date,
): boolean {
  if (!isCopartFutureSaleDate(record)) return false
  if (existing.saleStatus === 'sold' || existing.saleStatus === 'conditional') return false
  return hasKnownPastCopartAuctionContext(existing, record, now)
}

function getMutableVehicleFieldsForExisting(
  record: Omit<VehicleRecord, '_id'>,
  mutableFields: MutableVehicleRecordFields,
  existing: ExistingVehicleDocument,
  now: Date,
): MutableVehicleRecordFields {
  if (!shouldMarkCopartFutureAsNotSold(existing, record, now)) return mutableFields

  return {
    ...mutableFields,
    auctionStatus: 'finished',
    auctionStatusRaw: 'Venda Futura após data de venda',
    auctionStatusCheckedAt: now,
    saleStatus: 'not_sold',
    saleStatusRaw: 'Venda Futura após data de venda',
    saleStatusCheckedAt: now,
    soldPrice: null,
    soldPriceRaw: null,
  }
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

interface DuplicateReconcileResult {
  handled: boolean
  updatedVehicle: VehicleRecord | null
}

async function findVehicleRecordById(id: string): Promise<VehicleRecord | null> {
  const doc = await VehicleModel.findById(id).lean()
  return doc ? toVehicleRecordWithId(doc as Omit<VehicleRecord, '_id'> & { _id: unknown }) : null
}

async function reconcileVsVehicleDuplicate(
  record: Omit<VehicleRecord, '_id'>,
  mutableFields: MutableVehicleRecordFields,
  log: (msg: string) => void,
): Promise<DuplicateReconcileResult> {
  if (record.source !== 'vs-veiculos') return { handled: false, updatedVehicle: null }

  const vsId = extractVsVehicleId(record.url)
  if (!vsId) return { handled: false, updatedVehicle: null }

  const docs = await VehicleModel.find({
    source: 'vs-veiculos',
    $or: buildVsDuplicateLookupClauses(record, vsId),
  }).lean()
  const existingDocs = docs as ExistingVehicleDocument[]
  if (existingDocs.length === 0) return { handled: false, updatedVehicle: null }
  if (existingDocs.length === 1 && existingDocs[0]?.externalId === record.externalId) return { handled: false, updatedVehicle: null }

  const keep = chooseDuplicateVehicleToKeep(existingDocs, record)
  if (!keep) return { handled: false, updatedVehicle: null }

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
    const updateResult = await VehicleModel.updateOne(
      { _id: keepId },
      {
        $set: {
          ...mutableFields,
          externalId: record.externalId,
          url: record.url,
        },
      },
    )

    const updatedVehicle = updateResult.modifiedCount > 0
      ? await findVehicleRecordById(keepId)
      : null

    const removed = duplicateScrapedIds.length
    log(`[runner] vs-veiculos: lote ${vsId} reconciliado; ${removed} duplicado(s) removido(s).`)
    return { handled: true, updatedVehicle }
  }
  catch (err) {
    const updateResult = await VehicleModel.updateOne({ _id: keepId }, { $set: mutableFields })
    const updatedVehicle = updateResult.modifiedCount > 0
      ? await findVehicleRecordById(keepId)
      : null
    log(`[runner] vs-veiculos: lote ${vsId} atualizado sem migrar externalId (${err instanceof Error ? err.message : String(err)}).`)
    return { handled: true, updatedVehicle }
  }
}

function isSameAuctionLotVehicle(
  doc: ExistingVehicleDocument,
  record: Omit<VehicleRecord, '_id'>,
): boolean {
  if (doc.externalId === record.externalId) return true
  if (normalizeLookupUrl(doc.url) === normalizeLookupUrl(record.url)) return true
  if (!record.lot || !doc.lot || normalizeComparableText(doc.lot) !== normalizeComparableText(record.lot)) return false
  if (isStrongLotIdentifier(record.source, record.lot)) return true
  return isSameLocalDay(doc.auctionDate, record.auctionDate)
    && hasCompatibleVehicleIdentity(doc, record)
}

async function reconcileAuctionLotDuplicate(
  record: Omit<VehicleRecord, '_id'>,
  mutableFields: MutableVehicleRecordFields,
  now: Date,
  log: (msg: string) => void,
): Promise<DuplicateReconcileResult> {
  const lot = record.lot?.trim()
  if (!lot) return { handled: false, updatedVehicle: null }

  const docs = await VehicleModel.find({
    source: record.source,
    lot,
    status: { $in: ['scraped', 'sent', 'favorite'] },
  }).lean()

  const existingDocs = (docs as ExistingVehicleDocument[]).filter(doc => isSameAuctionLotVehicle(doc, record))
  if (existingDocs.length === 0) return { handled: false, updatedVehicle: null }
  if (existingDocs.length === 1 && existingDocs[0]?.externalId === record.externalId) return { handled: false, updatedVehicle: null }

  const keep = chooseDuplicateVehicleToKeep(existingDocs, record)
  if (!keep) return { handled: false, updatedVehicle: null }

  const keepId = getDocumentId(keep)
  const markedCopartFutureAsNotSold = shouldMarkCopartFutureAsNotSold(keep, record, now)
  const fieldsForKeep = getMutableVehicleFieldsForExisting(record, mutableFields, keep, now)
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
    const updateResult = await VehicleModel.updateOne(
      { _id: keepId },
      {
        $set: {
          ...fieldsForKeep,
          externalId: record.externalId,
          url: record.url,
        },
      },
    )

    const updatedVehicle = updateResult.modifiedCount > 0
      ? await findVehicleRecordById(keepId)
      : null

    const removed = duplicateScrapedIds.length
    log(`[runner] ${record.source}: lote ${lot} reconciliado; ${removed} duplicado(s) removido(s).`)
    if (markedCopartFutureAsNotSold) {
      log(`[runner] copart: lote ${lot} marcado como não vendido após voltar como Venda Futura.`)
    }
    return { handled: true, updatedVehicle }
  }
  catch (err) {
    const updateResult = await VehicleModel.updateOne({ _id: keepId }, { $set: fieldsForKeep })
    const updatedVehicle = updateResult.modifiedCount > 0
      ? await findVehicleRecordById(keepId)
      : null
    log(`[runner] ${record.source}: lote ${lot} atualizado sem migrar externalId (${err instanceof Error ? err.message : String(err)}).`)
    if (markedCopartFutureAsNotSold) {
      log(`[runner] copart: lote ${lot} marcado como não vendido após voltar como Venda Futura.`)
    }
    return { handled: true, updatedVehicle }
  }
}

async function toVehicleRecord(
  raw: RawScrapedVehicle,
  now: Date,
): Promise<Omit<VehicleRecord, '_id'>> {
  const externalId = await buildExternalId(raw.source, raw.url)
  const titleParts = [raw.brand, raw.model, raw.year?.toString()].filter(Boolean)
  const title = titleParts.join(' ')
  const auctionStatus = raw.auctionStatus ?? 'unknown'
  const auctionStatusCheckedAt = raw.auctionStatusCheckedAt
    ?? (raw.auctionStatus != null || raw.auctionStatusRaw != null ? now : null)
  const saleStatus = raw.saleStatus ?? 'unknown'
  const saleStatusCheckedAt = raw.saleStatusCheckedAt
    ?? (raw.saleStatus != null || raw.saleStatusRaw != null ? now : null)

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
    consignor: raw.consignor ?? null,
    auctionStatus,
    auctionStatusRaw: raw.auctionStatusRaw ?? null,
    auctionStatusCheckedAt,
    saleStatus,
    saleStatusRaw: raw.saleStatusRaw ?? null,
    saleStatusCheckedAt,
    soldPrice: raw.soldPrice ?? null,
    soldPriceRaw: raw.soldPriceRaw ?? null,
    fipe: raw.fipe ?? null,
    fipeCode: null,
    fipeReferenceMonth: null,
    fipeFuel: null,
    fipeCheckedAt: raw.fipe != null ? now : null,
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
    collectedVia: null,
  }
}

export interface RunScrapersOptions {
  headless?: boolean
  enrichFipe?: boolean
  onVehicle?: (v: VehicleRecord) => Promise<void> | void
  onSourceStatus?: (event: ScraperSourceStatusEvent) => Promise<void> | void
  log?: (msg: string) => void
  signal?: AbortSignal
  sourceTimeoutMs?: number
}

export interface RunScrapersResult {
  total: number
  inserted: number
  updated: number
  skipped: number
  skippedGeo: number
  skippedExpiredNoSale: number
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

function getSourceTimeoutMs(sourceId: VehicleSource, optionValue: number | undefined): number {
  return normalizeTimeoutMs(optionValue ?? parseTimeoutMsFromEnv() ?? DEFAULT_SOURCE_TIMEOUT_MS_BY_SOURCE[sourceId])
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
  const enrichFipe = options?.enrichFipe ?? true

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

  const result: RunScrapersResult = {
    total: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    skippedGeo: 0,
    skippedExpiredNoSale: 0,
    errors: {},
  }
  const newVehicleIds: string[] = []
  const filterStates = filters.states ?? []
  const filterCities = filters.cities ?? []
  if (filterStates.length > 0 || filterCities.length > 0) {
    log(`[runner] Região configurada para exibição/envio: estados=${filterStates.join(', ') || '-'}; cidades=${filterCities.join(', ') || '-'}.`)
  }

  await Promise.all(
    sourcesToRun.map(async (source) => {
      try {
        await options?.onSourceStatus?.({ source: source.id, status: 'running' })
        log(`[runner] Iniciando ${source.id}...`)
        let allowStaleCleanup = true
        let rawVehicles: RawScrapedVehicle[] = []
        const seenExternalIds: string[] = []
        const processedExternalIds = new Set<string>()
        let expiredNoSaleSkipped = 0
        let sourceSignal: AbortSignal | null = null

        const processRawVehicle = async (raw: RawScrapedVehicle): Promise<void> => {
          if (isSignalAborted(sourceSignal)) return
          const record = await toVehicleRecord(raw, now)
          if (processedExternalIds.has(record.externalId)) return
          processedExternalIds.add(record.externalId)

          if (isExpiredNoSaleAuction(raw, now)) {
            result.skipped++
            result.skippedExpiredNoSale++
            expiredNoSaleSkipped++
            return
          }

          result.total++
          seenExternalIds.push(record.externalId)
          const mutableFields = getMutableVehicleFields(record)

          const duplicateResult = await reconcileVsVehicleDuplicate(record, mutableFields, log)
          if (duplicateResult.handled) {
            if (duplicateResult.updatedVehicle) {
              result.updated++
              await options?.onVehicle?.(duplicateResult.updatedVehicle)
            }
            return
          }

          const auctionLotDuplicateResult = await reconcileAuctionLotDuplicate(record, mutableFields, now, log)
          if (auctionLotDuplicateResult.handled) {
            if (auctionLotDuplicateResult.updatedVehicle) {
              result.updated++
              await options?.onVehicle?.(auctionLotDuplicateResult.updatedVehicle)
            }
            return
          }

          const existingDoc = await VehicleModel.findOne(
            { externalId: record.externalId },
          ).lean()
          const existingVehicleDoc = existingDoc as ExistingVehicleDocument | null
          const markedCopartFutureAsNotSold = existingVehicleDoc
            ? shouldMarkCopartFutureAsNotSold(existingVehicleDoc, record, now)
            : false
          const fieldsForExisting = existingVehicleDoc
            ? getMutableVehicleFieldsForExisting(record, mutableFields, existingVehicleDoc, now)
            : mutableFields
          const insertOnlyFields = getInsertOnlyVehicleFields(record)
          const { fipe: _fipe, fipeCheckedAt: _fipeCheckedAt, ...insertOnlyWithoutFipe } = insertOnlyFields
          const res = await VehicleModel.updateOne(
            { externalId: record.externalId },
            {
              $set: fieldsForExisting,
              $setOnInsert: record.fipe != null ? insertOnlyWithoutFipe : insertOnlyFields,
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
          else if (existingDoc && res.modifiedCount > 0) {
            const id = String((existingDoc as Record<string, unknown>)['_id'])
            const updatedVehicle = await findVehicleRecordById(id)
            if (updatedVehicle) {
              result.updated++
              if (markedCopartFutureAsNotSold) {
                log(`[runner] copart: lote ${record.lot ?? record.externalId} marcado como não vendido após voltar como Venda Futura.`)
              }
              await options?.onVehicle?.(updatedVehicle)
            }
          }
        }

        try {
          const sourceTimeoutMs = getSourceTimeoutMs(source.id, options?.sourceTimeoutMs)
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

        if (expiredNoSaleSkipped > 0) {
          log(`[runner] ${source.id}: ${expiredNoSaleSkipped} ignorado(s) por leilão vencido há mais de 72h sem venda.`)
        }

        // Non-Copart sources remove unsent vehicles that no longer appear.
        // Copart keeps historical lots visible by marking missing lots as finished.
        if (allowStaleCleanup && seenExternalIds.length > 0) {
          if (source.id === 'copart') {
            const staleResult = await VehicleModel.updateMany(
              {
                source: source.id,
                externalId: { $nin: seenExternalIds },
                status: { $in: ['scraped', 'sent', 'favorite'] },
                auctionStatus: { $ne: 'finished' },
              },
              {
                $set: {
                  auctionStatus: 'finished',
                  auctionStatusRaw: 'Não encontrado na coleta atual',
                  auctionStatusCheckedAt: now,
                },
              },
            )
            if (staleResult.modifiedCount > 0) {
              log(`[runner] ${source.id}: ${staleResult.modifiedCount} veículo(s) ausente(s) marcado(s) como leilão finalizado.`)
            }
          }
          else {
            const staleResult = await VehicleModel.deleteMany({
              source: source.id,
              externalId: { $nin: seenExternalIds },
              status: 'scraped',
            })
            if (staleResult.deletedCount > 0) {
              log(`[runner] ${source.id}: ${staleResult.deletedCount} veículo(s) removido(s) do site, excluído(s) do DB.`)
            }
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

  if (!enrichFipe) {
    if (newVehicleIds.length > 0) {
      log(`[fipe] Enriquecimento automático desativado; ${newVehicleIds.length} veículo(s) novo(s) ficaram pendentes.`)
    }
    return result
  }

  if (newVehicleIds.length > 0) {
    log(`[fipe] Iniciando enriquecimento de ${newVehicleIds.length} veículo(s) novo(s)...`)
    await enrichVehiclesWithFipe(newVehicleIds, log)
  }

  return result
}
