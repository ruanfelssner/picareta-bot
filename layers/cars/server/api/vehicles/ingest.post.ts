import type { VehicleRecord, VehicleSaleStatus, VehicleSource } from '#shared/types/vehicle'
import { buildExternalId } from '#shared/utils/hash'
import { normalizeDamage } from '#shared/utils/damage'
import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'
import { VehicleModel } from '../../utils/schemas/vehicle'
import { areVehicleBrandsCompatible, inferSodreStateFromLocation, normalizeSodreLiveIdentity } from '../../utils/sodre-live-identity'
import { getVehicleRetentionDate } from '#shared/utils/vehicle-retention'
import { syncVehicleToPicareta } from '../../utils/picareta-sync'

type LiveAuctionSource = Extract<VehicleSource, 'copart' | 'vipleiloes' | 'sodre'>

type LiveAuctionExtensionEvent = {
  source: LiveAuctionSource
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
  consignor: string | null
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
  source: LiveAuctionSource
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
  consignor: string | null
  imageUrl: string | null
  manualDecision: 'auto' | 'save' | 'skip'
}

type SkippedVehicleSummary = {
  index: number
  reason: string
}

const MAX_BATCH_SIZE = 25
const FINAL_SALE_STATUSES: VehicleSaleStatus[] = ['sold', 'conditional', 'not_sold']
const SUPPORTED_EXTENSION_SOURCES = new Set<LiveAuctionSource>(['copart', 'vipleiloes', 'sodre'])
const AUTO_SAVE_ALLOWED_STATES = new Set(['PR'])
const BRAZIL_STATE_CODES = new Set([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
])
const ALLOWED_COPART_CATEGORIES = new Set([
  'AUTOMOVEIS',
  'SUV GRANDES',
  'SUV PEQUENOS',
  'PICAPES GRANDES',
  'PICAPES PEQUENAS',
  'CAMINHAO',
  'CAMINHOES',
  'CAMINHOES LEVES',
  'CAMINHOES PESADOS',
  'CAMINHOES PEQUENOS',
  'CAMINHOES E REBOCADORES',
  'REBOCADOR',
  'REBOCADORES',
  'ONIBUS',
  'MICROONIBUS',
  'ONIBUS E MICROONIBUS',
  'MOTO',
  'MOTOS',
  'MOTOCICLETA',
  'MOTOCICLETAS',
])

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)

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

  console.info('[live-auction-ingest] recebido', {
    at: new Date().toISOString(),
    received: rawItems.length,
  })

  for (const [index, rawItem] of rawItems.slice(0, MAX_BATCH_SIZE).entries()) {
    const normalized = await normalizeVehicle(rawItem)

    if (!normalized.ok) {
      skipped.push({ index, reason: normalized.reason })
      console.info('[live-auction-ingest] ignorado', {
        at: new Date().toISOString(),
        index,
        reason: normalized.reason,
        ...getRawLogContext(rawItem),
      })
      continue
    }

    const existingByUrl = await VehicleModel.findOne({
      source: normalized.vehicle.source,
      url: normalized.vehicle.url,
    }).sort({ createdAt: 1, _id: 1 }).select({ _id: 1, brand: 1 }).lean()
    const existing = existingByUrl ?? await VehicleModel.findOne({ externalId: normalized.vehicle.externalId }).select({ _id: 1, brand: 1 }).lean()
    if (existing && !areVehicleBrandsCompatible(normalized.vehicle.brand, existing.brand)) {
      const reason = 'identidade_conflitante'
      skipped.push({ index, reason })
      console.info('[live-auction-ingest] ignorado', {
        at: new Date().toISOString(),
        index,
        reason,
        existingBrand: existing.brand,
        ...getRawLogContext(rawItem),
      })
      continue
    }

    const vehicleUpdate = buildVehicleUpdate(normalized.vehicle)
    const vehicleInsert = buildVehicleInsert(normalized.vehicle, vehicleUpdate)

    await VehicleModel.updateOne(
      existing ? { _id: existing._id } : { externalId: normalized.vehicle.externalId },
      {
        $set: vehicleUpdate,
        $setOnInsert: vehicleInsert,
      },
      { upsert: true },
    )

    try {
      await syncVehicleToPicareta(normalized.vehicle)
    } catch (error) {
      console.error('[live-auction-ingest] falha ao sincronizar resultado com Picareta', {
        externalId: normalized.vehicle.externalId,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    const wasInserted = !existing
    if (wasInserted) inserted += 1
    else updated += 1

    console.info('[live-auction-ingest] salvo', {
      at: new Date().toISOString(),
      action: wasInserted ? 'insert' : 'update',
      source: normalized.vehicle.source,
      externalId: normalized.vehicle.externalId,
      title: normalized.vehicle.title,
      brand: normalized.vehicle.brand,
      model: normalized.vehicle.model,
      category: normalized.item.category,
      manualDecision: normalized.item.manualDecision,
      year: normalized.vehicle.year,
      damage: normalized.vehicle.damage,
      yard: normalized.vehicle.yard,
      consignor: normalized.vehicle.consignor,
      imageUrl: normalized.vehicle.imageUrls[0] ?? null,
      imageCount: normalized.vehicle.imageUrls.length,
      lot: normalized.vehicle.lot,
      url: normalized.vehicle.url,
      saleStatus: normalized.vehicle.saleStatus,
      price: normalized.vehicle.price,
      fipe: normalized.vehicle.fipe,
    })

    summaries.push({
      source: normalized.item.source,
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
      consignor: normalized.vehicle.consignor,
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

async function normalizeVehicle(value: unknown): Promise<{ ok: true, vehicle: NormalizedVehicle, item: LiveAuctionExtensionEvent } | { ok: false, reason: string }> {
  const item = normalizeInput(value)
  if (!item) return { ok: false, reason: 'payload_invalido' }
  if (!SUPPORTED_EXTENSION_SOURCES.has(item.source)) return { ok: false, reason: 'fonte_nao_suportada' }

  if (item.manualDecision === 'skip') return { ok: false, reason: 'ignorado_manualmente' }

  const isManualSave = item.manualDecision === 'save'
  if (!FINAL_SALE_STATUSES.includes(item.saleStatus) && !isManualSave) {
    return { ok: false, reason: 'status_nao_finalizado' }
  }

  const brand = item.brand
  if (!brand) return { ok: false, reason: 'marca_ausente' }

  const model = item.model
  if (!model) return { ok: false, reason: 'modelo_ausente' }

  const categoryBlockReason = getCategoryBlockReason(item)
  if (!isManualSave && categoryBlockReason) return { ok: false, reason: categoryBlockReason }

  const location = parseLocation(item.yard, item.source === 'sodre' ? item.description : null)
  const stateBlockReason = getStateBlockReason(location.state)
  if (!isManualSave && stateBlockReason) return { ok: false, reason: stateBlockReason }

  const url = buildVehicleUrl(item)
  if (!url) return { ok: false, reason: 'url_ausente' }

  const title = buildTitle(item, brand, model)
  if (!title) return { ok: false, reason: 'titulo_ausente' }

  const description = buildDescription(item, title)

  const now = new Date()
  const fipe = positiveNumber(item.fipe)
  const bid = positiveNumber(item.bid)
  const damage = getNormalizedDamage(item)
  const storedLocation = getStoredLocation(item, location)
  const externalId = await buildExternalId(item.source, url)
  const isFinished = item.saleStatus !== 'unknown'

  return {
    ok: true,
    item,
    vehicle: {
      source: item.source,
      externalId,
      brand,
      model,
      year: parseYear(item.yearModel),
      color: null,
      km: null,
      fuel: null,
      title,
      description,
      version: item.version,
      category: item.category,
      price: bid,
      priceRaw: item.bidRaw,
      url,
      imageUrls: item.imageUrl ? [item.imageUrl] : [],
      auctionDate: item.observedAt,
      lot: item.lot,
      damage,
      condition: item.condition,
      yard: storedLocation.yard,
      consignor: item.consignor,
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
      location: storedLocation.location,
      city: storedLocation.city,
      state: storedLocation.state,
      scrapedAt: item.observedAt,
      expiresAt: getVehicleRetentionDate(item.observedAt),
      status: 'scraped',
      sentAt: null,
      sentTo: null,
      collectedVia: 'extension',
    },
  }
}

function normalizeInput(value: unknown): LiveAuctionExtensionEvent | null {
  if (!isRecord(value)) return null

  const source = normalizeSource(value['source'])
  const imageUrl = normalizeUrl(value['imageUrl'], source)
  const rawIdentity = {
    auctionId: normalizeText(value['auctionId']),
    code: normalizeText(value['code']),
    imageUrl,
    vehicleUrl: normalizeUrl(value['vehicleUrl'], source),
  }
  const identity = source === 'sodre' ? normalizeSodreLiveIdentity(rawIdentity) : rawIdentity
  const bid = toNumber(value['bid']) ?? toNumber(value['bidRaw'])
  const fipe = toNumber(value['fipe']) ?? toNumber(value['fipeRaw'])

  return {
    source,
    auctionId: identity.auctionId,
    lot: normalizeText(value['lot']),
    code: identity.code,
    description: normalizeText(value['description']),
    version: normalizeText(value['version']),
    yearModel: normalizeText(value['yearModel']),
    brand: normalizeText(value['brand']),
    model: normalizeText(value['model']),
    category: normalizeText(value['category']) ?? (source === 'vipleiloes' ? 'Automóveis' : null),
    fipe,
    fipeRaw: normalizeText(value['fipeRaw']),
    damage: normalizeText(value['damage']) ?? (source === 'vipleiloes' ? 'Sem monta' : null),
    condition: normalizeText(value['condition']),
    yard: normalizeText(value['yard']),
    consignor: normalizeText(value['consignor']),
    bid,
    bidRaw: normalizeText(value['bidRaw']),
    saleStatus: normalizeSaleStatus(value['saleStatus'], value['message']),
    manualDecision: normalizeManualDecision(value['manualDecision']),
    eventType: normalizeText(value['eventType']),
    imageUrl,
    vehicleUrl: identity.vehicleUrl,
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
    version: vehicle.version,
    category: vehicle.category,
    price: vehicle.price,
    priceRaw: vehicle.priceRaw,
    url: vehicle.url,
    imageUrls: vehicle.imageUrls,
    auctionDate: vehicle.auctionDate,
    lot: vehicle.lot,
    damage: vehicle.damage,
    condition: vehicle.condition,
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
    collectedVia: vehicle.collectedVia,
  }

  if (vehicle.consignor != null) {
    update.consignor = vehicle.consignor
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

  return keepPresentVehicleFields(update)
}

function keepPresentVehicleFields(update: Partial<NormalizedVehicle>): Partial<NormalizedVehicle> {
  return Object.fromEntries(
    Object.entries(update).filter(([, value]) => {
      if (value === null || value === undefined) return false
      if (typeof value === 'string' && value.trim() === '') return false
      if (Array.isArray(value) && value.length === 0) return false
      return true
    }),
  ) as Partial<NormalizedVehicle>
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
    consignor: vehicle.consignor,
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
      source: null,
      auctionId: null,
      lot: null,
      code: null,
      brand: null,
      model: null,
      category: null,
      yearModel: null,
      damage: null,
      yard: null,
      consignor: null,
      saleStatus: null,
      manualDecision: null,
      bid: null,
      fipe: null,
    }
  }

  return {
    source: normalizeText(value['source']),
    auctionId: normalizeText(value['auctionId']),
    lot: normalizeText(value['lot']),
    code: normalizeText(value['code']),
    brand: normalizeText(value['brand']),
    model: normalizeText(value['model']),
    category: normalizeText(value['category']),
    yearModel: normalizeText(value['yearModel']),
    damage: normalizeText(value['damage']),
    yard: normalizeText(value['yard']),
    consignor: normalizeText(value['consignor']),
    saleStatus: normalizeText(value['saleStatus']),
    manualDecision: normalizeText(value['manualDecision']),
    bid: toNumber(value['bid']) ?? toNumber(value['bidRaw']),
    fipe: toNumber(value['fipe']) ?? toNumber(value['fipeRaw']),
  }
}

function buildVehicleUrl(item: LiveAuctionExtensionEvent): string | null {
  if (item.vehicleUrl) return item.vehicleUrl

  if (item.source === 'vipleiloes') {
    const slug = item.code && /[a-z]/i.test(item.code) ? item.code : null
    if (slug) return `https://www.vipleiloes.com.br/evento/anuncio/${encodeURIComponent(slug)}`

    const auctionId = item.auctionId?.trim()
    const lot = item.lot?.replace(/\D/g, '')
    if (auctionId && lot) return `https://www.vipleiloes.com.br/eventoonline/${encodeURIComponent(auctionId)}#lote-${lot}`
  }

  if (item.source === 'sodre') {
    const auctionId = item.auctionId?.replace(/\D/g, '')
    const code = item.code?.replace(/\D/g, '')
    if (auctionId && code) return `https://leilao.sodresantoro.com.br/leilao/${auctionId}/lote/${code}/`
  }

  const code = item.code?.replace(/\D/g, '')
  return code ? `https://www.copart.com.br/lot/${code}` : null
}

function buildTitle(item: LiveAuctionExtensionEvent, brand: string, model: string): string | null {
  const title = normalizeText(item.description)
    ?? [parseYear(item.yearModel), brand, model].filter(value => value != null).join(' ')

  return normalizeText(title)
}

function buildDescription(item: LiveAuctionExtensionEvent, fallbackTitle: string): string {
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

function parseLocation(value: string | null, fallbackDescription: string | null = null): { city: string | null, state: string | null } {
  if (!value) {
    const fallbackState = extractBrazilState(fallbackDescription)
    return { city: null, state: fallbackState }
  }

  const cityStateMatch = value.match(/^(.*?)\s*-\s*([A-Z]{2})$/i)
  if (cityStateMatch) {
    return {
      city: normalizeText(cityStateMatch[1]) ?? value,
      state: cityStateMatch[2]?.toUpperCase() ?? null,
    }
  }

  const addressMatch = value.match(/,\s*([^,]+?)\s*,\s*([A-Z]{2})(?:\b|,)/i)
  if (addressMatch) {
    return {
      city: normalizeText(addressMatch[1]) ?? value,
      state: addressMatch[2]?.toUpperCase() ?? null,
    }
  }

  const normalized = normalizeForMatch(value)
  const labeledStateMatch = normalized.match(/^(?:LOCAL DO LOTE|LOCAL|ESTADO|UF)?\s*:?\s*([A-Z]{2})$/)
  if (labeledStateMatch?.[1] && BRAZIL_STATE_CODES.has(labeledStateMatch[1])) {
    return {
      city: null,
      state: labeledStateMatch[1],
    }
  }

  const state = extractBrazilState(value)
  if (state) {
    return {
      city: value,
      state,
    }
  }

  const inferredState = inferSodreStateFromLocation(value)
  if (inferredState) {
    return {
      city: value,
      state: inferredState,
    }
  }

  return {
    city: value,
    state: extractBrazilState(fallbackDescription),
  }
}

function extractBrazilState(value: string | null): string | null {
  if (!value) return null

  const normalized = normalizeForMatch(value)
  const slashStateMatch = normalized.match(/\/\s*([A-Z]{2})(?=$|[\s,.;:)\-])/)
  if (slashStateMatch?.[1] && BRAZIL_STATE_CODES.has(slashStateMatch[1])) return slashStateMatch[1]

  return null
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

function normalizeSource(value: unknown): LiveAuctionSource {
  const text = normalizeForMatch(typeof value === 'string' ? value : '')

  if (text === 'VIPLEILOES' || text === 'VIP LEILOES' || text === 'VIP-LEILOES') return 'vipleiloes'
  if (text === 'SODRE' || text === 'SODRE SANTORO' || text === 'SODRESANTORO') return 'sodre'
  return 'copart'
}

function getCategoryBlockReason(item: LiveAuctionExtensionEvent): string | null {
  if (item.source !== 'copart') return null
  if (!item.category) return 'categoria_ausente'
  if (!isAllowedCopartCategory(item.category)) return 'categoria_descartada'

  return null
}

function getStateBlockReason(state: string | null): string | null {
  if (!state) return 'estado_ausente'

  const stateCode = normalizeForMatch(state)
  if (!AUTO_SAVE_ALLOWED_STATES.has(stateCode)) return `estado_ignorado_${stateCode.toLowerCase()}`

  return null
}

function getStoredLocation(
  item: LiveAuctionExtensionEvent,
  location: { city: string | null, state: string | null },
): { yard: string | null, location: string | null, city: string | null, state: string | null } {
  // VIP e Sodre expoem so um endereco completo no texto ao vivo — guarda so a UF, descarta a rua.
  if (item.source === 'vipleiloes' || item.source === 'sodre') {
    return {
      yard: location.state,
      location: location.state,
      city: null,
      state: location.state,
    }
  }

  return {
    yard: item.yard,
    location: item.yard,
    city: location.city,
    state: location.state,
  }
}

function getNormalizedDamage(item: LiveAuctionExtensionEvent): string | null {
  return normalizeDamage(item.damage ?? (item.source === 'vipleiloes' ? 'Sem monta' : null))
}

function isAllowedCopartCategory(category: string): boolean {
  return ALLOWED_COPART_CATEGORIES.has(normalizeCategory(category))
}

function normalizeCategory(category: string): string {
  return normalizeForMatch(category).replace(/[^A-Z0-9]+/g, ' ').trim()
}

function positiveNumber(value: number | null): number | null {
  return value != null && value >= 0 ? value : null
}

function normalizeUrl(value: unknown, source: LiveAuctionSource = 'copart'): string | null {
  const text = normalizeText(value)
  if (!text) return null

  try {
    const baseUrl = source === 'vipleiloes'
      ? 'https://www.vipleiloes.com.br'
      : source === 'sodre'
        ? 'https://leilao.sodresantoro.com.br'
        : 'https://www.copart.com.br'
    const url = new URL(text, baseUrl)
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
