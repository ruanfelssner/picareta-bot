import type { VehicleRecord, VehicleSaleStatus } from '#shared/types/vehicle'
import { buildExternalId } from '#shared/utils/hash'
import { VehicleModel } from '../../utils/schemas/vehicle'

type CopartExtensionEvent = {
  auctionId: string | null
  lot: string | null
  code: string | null
  description: string | null
  version: string | null
  yearModel: string | null
  brand: string | null
  model: string | null
  category: string | null
  fipe: number | null
  fipeRaw: string | null
  damage: string | null
  condition: string | null
  yard: string | null
  bid: number | null
  bidRaw: string | null
  saleStatus: VehicleSaleStatus
  manualDecision: 'auto' | 'save' | 'skip'
  eventType: string | null
  imageUrl: string | null
  vehicleUrl: string | null
  message: string | null
  observedAt: Date
}

type NormalizedVehicle = Omit<VehicleRecord, '_id'>

type IngestedVehicleSummary = {
  externalId: string
  url: string
  saleStatus: VehicleSaleStatus
  inserted: boolean
  brand: string
  model: string
  category: string | null
  year: number | null
  damage: string | null
  yard: string | null
  imageUrl: string | null
  manualDecision: 'auto' | 'save' | 'skip'
}

type SkippedVehicleSummary = {
  index: number
  reason: string
}

const MAX_BATCH_SIZE = 25
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const FINAL_SALE_STATUSES: VehicleSaleStatus[] = ['sold', 'conditional', 'not_sold']
const ALLOWED_COPART_CATEGORIES = new Set([
  'AUTOMOVEIS',
  'SUV GRANDES',
  'SUV PEQUENOS',
  'PICAPES GRANDES',
  'PICAPES PEQUENAS',
])

export default defineEventHandler(async (event) => {
  useDb()

  const config = useRuntimeConfig()
  const expectedToken = getOptionalString(config.copartExtensionToken) ?? getOptionalString(process.env.COPART_EXTENSION_TOKEN)

  if (expectedToken) {
    const providedToken = getHeader(event, 'x-copart-extension-token')?.trim()
    if (providedToken !== expectedToken) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Unauthorized',
        message: 'Token da extensao Copart invalido.',
      })
    }
  }

  const body = await readBody<unknown>(event)
  const rawItems = getInputArray(body)

  if (rawItems.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Envie um evento ou { events: [...] }.',
    })
  }

  const summaries: IngestedVehicleSummary[] = []
  const skipped: SkippedVehicleSummary[] = []
  let inserted = 0
  let updated = 0

  console.info('[copart-ingest] recebido', {
    at: new Date().toISOString(),
    received: rawItems.length,
  })

  for (const [index, rawItem] of rawItems.slice(0, MAX_BATCH_SIZE).entries()) {
    const normalized = await normalizeVehicle(rawItem)

    if (!normalized.ok) {
      skipped.push({ index, reason: normalized.reason })
      console.info('[copart-ingest] ignorado', {
        at: new Date().toISOString(),
        index,
        reason: normalized.reason,
        ...getRawLogContext(rawItem),
      })
      continue
    }

    const existing = await VehicleModel.findOne({ externalId: normalized.vehicle.externalId }).select({ _id: 1 }).lean()
    const vehicleUpdate = buildVehicleUpdate(normalized.vehicle)
    const vehicleInsert = buildVehicleInsert(normalized.vehicle, vehicleUpdate)

    await VehicleModel.updateOne(
      { externalId: normalized.vehicle.externalId },
      {
        $set: vehicleUpdate,
        $setOnInsert: vehicleInsert,
      },
      { upsert: true },
    )

    const wasInserted = !existing
    if (wasInserted) inserted += 1
    else updated += 1

    console.info('[copart-ingest] salvo', {
      at: new Date().toISOString(),
      action: wasInserted ? 'insert' : 'update',
      externalId: normalized.vehicle.externalId,
      title: normalized.vehicle.title,
      brand: normalized.vehicle.brand,
      model: normalized.vehicle.model,
      category: normalized.item.category,
      manualDecision: normalized.item.manualDecision,
      year: normalized.vehicle.year,
      damage: normalized.vehicle.damage,
      yard: normalized.vehicle.yard,
      imageUrl: normalized.vehicle.imageUrls[0] ?? null,
      imageCount: normalized.vehicle.imageUrls.length,
      lot: normalized.vehicle.lot,
      url: normalized.vehicle.url,
      saleStatus: normalized.vehicle.saleStatus,
      price: normalized.vehicle.price,
      fipe: normalized.vehicle.fipe,
    })

    summaries.push({
      externalId: normalized.vehicle.externalId,
      url: normalized.vehicle.url,
      saleStatus: normalized.vehicle.saleStatus,
      inserted: wasInserted,
      brand: normalized.vehicle.brand,
      model: normalized.vehicle.model,
      category: normalized.item.category,
      year: normalized.vehicle.year,
      damage: normalized.vehicle.damage,
      yard: normalized.vehicle.yard,
      imageUrl: normalized.vehicle.imageUrls[0] ?? null,
      manualDecision: normalized.item.manualDecision,
    })
  }

  if (summaries.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Nenhum veiculo valido para salvar.',
      data: { skipped },
    })
  }

  return {
    ok: true,
    received: rawItems.length,
    accepted: summaries.length,
    inserted,
    updated,
    skipped,
    vehicles: summaries,
  }
})

async function normalizeVehicle(value: unknown): Promise<{ ok: true, vehicle: NormalizedVehicle, item: CopartExtensionEvent } | { ok: false, reason: string }> {
  const item = normalizeInput(value)
  if (!item) return { ok: false, reason: 'payload_invalido' }

  if (item.manualDecision === 'skip') return { ok: false, reason: 'ignorado_manualmente' }

  if (!FINAL_SALE_STATUSES.includes(item.saleStatus)) {
    return { ok: false, reason: 'status_nao_finalizado' }
  }

  const brand = item.brand
  if (!brand) return { ok: false, reason: 'marca_ausente' }

  const model = item.model
  if (!model) return { ok: false, reason: 'modelo_ausente' }

  const isManualSave = item.manualDecision === 'save'
  if (!isManualSave && !item.category) return { ok: false, reason: 'categoria_ausente' }
  if (!isManualSave && item.category && !isAllowedCopartCategory(item.category)) return { ok: false, reason: 'categoria_descartada' }

  const url = buildVehicleUrl(item)
  if (!url) return { ok: false, reason: 'url_ausente' }

  const title = buildTitle(item, brand, model)
  if (!title) return { ok: false, reason: 'titulo_ausente' }

  const description = buildDescription(item, title)

  if (!isManualSave && isBlockedDamage([item.damage, item.condition, title, description])) {
    return { ok: false, reason: 'monta_descartada' }
  }

  const now = new Date()
  const fipe = positiveNumber(item.fipe)
  const bid = positiveNumber(item.bid)
  const location = parseLocation(item.yard)
  const externalId = await buildExternalId('copart', url)
  const isFinished = item.saleStatus !== 'unknown'

  return {
    ok: true,
    item,
    vehicle: {
      source: 'copart',
      externalId,
      brand,
      model,
      year: parseYear(item.yearModel),
      color: null,
      km: null,
      fuel: null,
      title,
      description,
      price: bid,
      priceRaw: item.bidRaw,
      url,
      imageUrls: item.imageUrl ? [item.imageUrl] : [],
      auctionDate: null,
      lot: item.lot,
      damage: item.damage,
      yard: item.yard,
      auctionStatus: isFinished ? 'finished' : 'unknown',
      auctionStatusRaw: item.message,
      auctionStatusCheckedAt: isFinished ? now : null,
      saleStatus: item.saleStatus,
      saleStatusRaw: item.message ?? item.eventType,
      saleStatusCheckedAt: isFinished ? now : null,
      soldPrice: item.saleStatus === 'sold' ? bid : null,
      soldPriceRaw: item.saleStatus === 'sold' ? item.bidRaw : null,
      fipe,
      fipeCode: null,
      fipeReferenceMonth: null,
      fipeFuel: null,
      fipeCheckedAt: fipe != null ? now : null,
      fipeBrandMatched: null,
      fipeModelMatched: null,
      location: item.yard,
      city: location.city,
      state: location.state,
      scrapedAt: item.observedAt,
      expiresAt: new Date(item.observedAt.getTime() + CACHE_TTL_MS),
      status: 'scraped',
      sentAt: null,
      sentTo: null,
    },
  }
}

function normalizeInput(value: unknown): CopartExtensionEvent | null {
  if (!isRecord(value)) return null

  const vehicleUrl = normalizeUrl(value['vehicleUrl'])
  const imageUrl = normalizeUrl(value['imageUrl'])
  const bid = toNumber(value['bid']) ?? toNumber(value['bidRaw'])
  const fipe = toNumber(value['fipe']) ?? toNumber(value['fipeRaw'])

  return {
    auctionId: normalizeText(value['auctionId']),
    lot: normalizeText(value['lot']),
    code: normalizeText(value['code']),
    description: normalizeText(value['description']),
    version: normalizeText(value['version']),
    yearModel: normalizeText(value['yearModel']),
    brand: normalizeText(value['brand']),
    model: normalizeText(value['model']),
    category: normalizeText(value['category']),
    fipe,
    fipeRaw: normalizeText(value['fipeRaw']),
    damage: normalizeText(value['damage']),
    condition: normalizeText(value['condition']),
    yard: normalizeText(value['yard']),
    bid,
    bidRaw: normalizeText(value['bidRaw']),
    saleStatus: normalizeSaleStatus(value['saleStatus'], value['message']),
    manualDecision: normalizeManualDecision(value['manualDecision']),
    eventType: normalizeText(value['eventType']),
    imageUrl,
    vehicleUrl,
    message: normalizeText(value['message']),
    observedAt: toDate(value['observedAt']) ?? new Date(),
  }
}

function buildVehicleUpdate(vehicle: NormalizedVehicle): Partial<NormalizedVehicle> {
  const update: Partial<NormalizedVehicle> = {
    brand: vehicle.brand,
    model: vehicle.model,
    year: vehicle.year,
    color: vehicle.color,
    km: vehicle.km,
    fuel: vehicle.fuel,
    title: vehicle.title,
    description: vehicle.description,
    price: vehicle.price,
    priceRaw: vehicle.priceRaw,
    url: vehicle.url,
    imageUrls: vehicle.imageUrls,
    auctionDate: vehicle.auctionDate,
    lot: vehicle.lot,
    damage: vehicle.damage,
    yard: vehicle.yard,
    auctionStatus: vehicle.auctionStatus,
    auctionStatusRaw: vehicle.auctionStatusRaw,
    auctionStatusCheckedAt: vehicle.auctionStatusCheckedAt,
    saleStatus: vehicle.saleStatus,
    saleStatusRaw: vehicle.saleStatusRaw,
    saleStatusCheckedAt: vehicle.saleStatusCheckedAt,
    soldPrice: vehicle.soldPrice,
    soldPriceRaw: vehicle.soldPriceRaw,
    location: vehicle.location,
    city: vehicle.city,
    state: vehicle.state,
  }

  if (vehicle.fipe != null) {
    update.fipe = vehicle.fipe
    update.fipeCheckedAt = vehicle.fipeCheckedAt
    update.fipeCode = vehicle.fipeCode
    update.fipeReferenceMonth = vehicle.fipeReferenceMonth
    update.fipeFuel = vehicle.fipeFuel
    update.fipeBrandMatched = vehicle.fipeBrandMatched
    update.fipeModelMatched = vehicle.fipeModelMatched
  }

  return update
}

function buildVehicleInsert(
  vehicle: NormalizedVehicle,
  update: Partial<NormalizedVehicle>,
): Partial<NormalizedVehicle> {
  const insert: Partial<NormalizedVehicle> = {
    source: vehicle.source,
    externalId: vehicle.externalId,
    scrapedAt: vehicle.scrapedAt,
    expiresAt: vehicle.expiresAt,
    status: vehicle.status,
    sentAt: vehicle.sentAt,
    sentTo: vehicle.sentTo,
    fipe: vehicle.fipe,
    fipeCheckedAt: vehicle.fipeCheckedAt,
    fipeCode: vehicle.fipeCode,
    fipeReferenceMonth: vehicle.fipeReferenceMonth,
    fipeFuel: vehicle.fipeFuel,
    fipeBrandMatched: vehicle.fipeBrandMatched,
    fipeModelMatched: vehicle.fipeModelMatched,
  }

  for (const key of Object.keys(update) as Array<keyof NormalizedVehicle>) {
    delete insert[key]
  }

  return insert
}

function getInputArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body['events'])) return body['events']
  if (isRecord(body)) return [body]
  return []
}

function getRawLogContext(value: unknown): Record<string, string | number | null> {
  if (!isRecord(value)) {
    return {
      auctionId: null,
      lot: null,
      code: null,
      brand: null,
      model: null,
      category: null,
      yearModel: null,
      damage: null,
      yard: null,
      saleStatus: null,
      manualDecision: null,
      bid: null,
      fipe: null,
    }
  }

  return {
    auctionId: normalizeText(value['auctionId']),
    lot: normalizeText(value['lot']),
    code: normalizeText(value['code']),
    brand: normalizeText(value['brand']),
    model: normalizeText(value['model']),
    category: normalizeText(value['category']),
    yearModel: normalizeText(value['yearModel']),
    damage: normalizeText(value['damage']),
    yard: normalizeText(value['yard']),
    saleStatus: normalizeText(value['saleStatus']),
    manualDecision: normalizeText(value['manualDecision']),
    bid: toNumber(value['bid']) ?? toNumber(value['bidRaw']),
    fipe: toNumber(value['fipe']) ?? toNumber(value['fipeRaw']),
  }
}

function buildVehicleUrl(item: CopartExtensionEvent): string | null {
  if (item.vehicleUrl) return item.vehicleUrl

  const code = item.code?.replace(/\D/g, '')
  return code ? `https://www.copart.com.br/lot/${code}` : null
}

function buildTitle(item: CopartExtensionEvent, brand: string, model: string): string | null {
  const title = normalizeText(item.description)
    ?? [parseYear(item.yearModel), brand, model].filter(value => value != null).join(' ')

  return normalizeText(title)
}

function buildDescription(item: CopartExtensionEvent, fallbackTitle: string): string {
  return [
    item.description,
    item.version,
    item.category ? `Categoria: ${item.category}` : null,
    item.condition ? `Condicao: ${item.condition}` : null,
    item.auctionId && item.lot ? `Leilao/Lote: ${item.auctionId}/${item.lot}` : null,
  ].map(value => normalizeText(value)).filter((text): text is string => text != null).join(' | ') || fallbackTitle
}

function parseYear(value: string | null): number | null {
  if (!value) return null

  const years = value.match(/\b(19\d{2}|20\d{2})\b/g)
  if (!years || years.length === 0) return null

  const year = Number.parseInt(years[years.length - 1]!, 10)
  return Number.isFinite(year) ? year : null
}

function parseLocation(value: string | null): { city: string | null, state: string | null } {
  if (!value) return { city: null, state: null }

  const match = value.match(/^(.*?)\s*-\s*([A-Z]{2})$/)
  if (!match) return { city: value, state: null }

  return {
    city: normalizeText(match[1]) ?? value,
    state: match[2] ?? null,
  }
}

function normalizeSaleStatus(status: unknown, message: unknown): VehicleSaleStatus {
  const sourceText = normalizeForMatch([status, message].map(value => typeof value === 'string' ? value : '').join(' '))

  if (sourceText.includes('CONDICIONAL')) return 'conditional'
  if (sourceText.includes('NAO VENDIDO') || sourceText.includes('NAO FOI VENDIDO')) return 'not_sold'
  if (sourceText.includes('VENDIDO') || sourceText.includes('ARREMATADO') || sourceText.includes('LANCE VENCEDOR')) return 'sold'
  if (status === 'conditional') return 'conditional'
  if (status === 'not_sold') return 'not_sold'
  if (status === 'sold') return 'sold'

  return 'unknown'
}

function normalizeManualDecision(value: unknown): 'auto' | 'save' | 'skip' {
  if (value === 'save' || value === 'skip') return value
  return 'auto'
}

function isAllowedCopartCategory(category: string): boolean {
  return ALLOWED_COPART_CATEGORIES.has(normalizeCategory(category))
}

function normalizeCategory(category: string): string {
  return normalizeForMatch(category).replace(/[^A-Z0-9]+/g, ' ').trim()
}

function isBlockedDamage(values: Array<string | null>): boolean {
  const text = normalizeForMatch(values.filter(Boolean).join(' '))

  return /GRANDE\s+MONTA|SUCATA|PERDA\s+TOTAL|IRRECUPERAVEL|RECUPERACAO\s+IMPOSSIVEL/.test(text)
}

function positiveNumber(value: number | null): number | null {
  return value != null && value >= 0 ? value : null
}

function normalizeUrl(value: unknown): string | null {
  const text = normalizeText(value)
  if (!text) return null

  try {
    const url = new URL(text, 'https://www.copart.com.br')
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  }
  catch {
    return null
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  if (typeof value !== 'string') return null

  const match = value.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/)
  if (!match) return null

  const parsed = Number.parseFloat(match[1]!.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string') return null

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const text = value.replace(/\s+/g, ' ').trim()
  return text || null
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
