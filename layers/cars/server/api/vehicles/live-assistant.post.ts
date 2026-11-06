import { resolvePestanaLiveIdentity } from '../../utils/pestana-live-identity'
import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { normalizeDamage } from '#shared/utils/damage'
import { calculateTotalFipePercent, estimateVehicleFees, normalizePublishedAuctionFees, type PublishedAuctionFees } from '#shared/utils/auction-fees'
import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'
import { buildLiveVehicleMarketAnalysis, loadMarketHistory } from '../../utils/vehicle-market-analysis'
import { VehicleModel } from '../../utils/schemas/vehicle'
import { areVehicleBrandsCompatible, normalizeSodreLiveIdentity } from '../../utils/sodre-live-identity'
import { getVehicleRetentionDate } from '#shared/utils/vehicle-retention'
import { isSameLiveAssistantLot, liveLotCodePattern } from '../../utils/live-assistant-lot-identity'
import { findFavoriteLot } from '../../utils/favorite-lot-result'
import { recordLiveAuctionCapture } from '../../utils/live-auction-capture'
import { selectLiveAssistantFipeReference, type LiveAssistantFipeReference } from '../../utils/live-assistant-fipe-reference'

type LiveAssistantSource = Extract<VehicleSource, 'copart' | 'vipleiloes' | 'sodre' | 'pestana'>

type LiveAssistantInput = {
  source: LiveAssistantSource
  auctionId: string | null
  lot: string | null
  code: string | null
  description: string | null
  yearModel: string | null
  brand: string | null
  model: string | null
  version: string | null
  fuel: string | null
  damage: string | null
  yard: string | null
  consignor: string | null
  bid: number | null
  fipe: number | null
  imageUrl: string | null
  vehicleUrl: string | null
  allowDatabaseFipeReference: boolean
  publishedFees: PublishedAuctionFees | null
}

type VehicleCandidate = VehicleRecord & { _id: string }

const SUPPORTED_SOURCES = new Set<LiveAssistantSource>(['copart', 'vipleiloes', 'sodre', 'pestana'])

export default defineEventHandler(async (event) => {
  useDb()
  const actor = await assertLiveAuctionExtensionAuthorized(event)

  const rawBody = await readBody<unknown>(event).catch((): unknown => null)
  const input = normalizeInput(rawBody)
  if (!input) {
    throw createError({ statusCode: 400, message: 'Dados do lote inválidos.' })
  }
  // As taxas não dependem do histórico. O resumo pode calculá-las enquanto
  // a consulta completa segue em andamento, usando a mesma regra compartilhada.
  if (isRecord(rawBody) && rawBody['feesOnly'] === true) {
    const vehicle = buildAnalysisVehicle(input, null, input.bid, null)
    return { metrics: { feeEstimate: estimateVehicleFees(vehicle, input.bid, input.publishedFees) } }
  }
  if (input.source === 'pestana') {
    try { Object.assign(input, await resolvePestanaLiveIdentity(input)) }
    catch { /* A identidade leilão/lote ainda permite acompanhar; ingestão final exige o ID oficial. */ }
  }
  const captureSaved = isRecord(rawBody) ? await recordLiveAuctionCapture(input.source === 'pestana' ? { ...rawBody, code: input.code, vehicleUrl: input.vehicleUrl } : rawBody, actor) : false
  if (actor.kind === 'user' && !captureSaved) {
    throw createError({ statusCode: 422, message: 'O lote precisa de código, link ou leilão/lote para liberar a análise.' })
  }

  const matchedVehicle = await findMatchedVehicle(input)
  // Em uma página Copart recém-aberta o lance pode ficar vazio enquanto o
  // componente ao vivo carrega. Nesse intervalo, use o último valor já
  // capturado para o mesmo lote como fallback visual e de cálculo.
  const bid = input.bid ?? getMatchedBid(matchedVehicle)
  const [fipeReference, marketHistory, favorite] = await Promise.all([
    !input.allowDatabaseFipeReference || input.fipe != null || positiveNumber(matchedVehicle?.fipe) != null
      ? Promise.resolve(null)
      : findFipeReference(input, matchedVehicle),
    loadMarketHistory(true),
    findFavoriteLot(matchedVehicle),
  ])
  const vehicle = buildAnalysisVehicle(input, matchedVehicle, bid, fipeReference)
  const marketAnalysis = buildLiveVehicleMarketAnalysis(vehicle, marketHistory)
  const feeEstimate = estimateVehicleFees(vehicle, bid, input.publishedFees)
  const fipePercent = calculatePercent(bid, vehicle.fipe)
  const totalFipePercent = calculateTotalFipePercent(feeEstimate?.total ?? null, vehicle.fipe)

  return {
    capture: {
      saved: captureSaved,
      userId: actor.userId,
    },
    matched: matchedVehicle != null,
    favorite,
    vehicle: {
      _id: matchedVehicle?._id ?? null,
      source: vehicle.source,
      title: vehicle.title,
      brand: vehicle.brand,
      model: vehicle.model,
      year: vehicle.year,
      damage: vehicle.damage,
      yard: vehicle.yard,
      consignor: vehicle.consignor,
      imageUrl: input.imageUrl ?? matchedVehicle?.imageUrls[0] ?? null,
      url: vehicle.url,
      bid,
      fipe: vehicle.fipe,
      fipeOrigin: input.fipe != null
        ? 'auction_page'
        : positiveNumber(matchedVehicle?.fipe) != null ? 'matched_vehicle' : fipeReference ? 'database_reference' : null,
      fipeReference,
      fipeCode: fipeReference?.fipeCode ?? matchedVehicle?.fipeCode ?? null,
      fipeReferenceMonth: fipeReference?.fipeReferenceMonth ?? matchedVehicle?.fipeReferenceMonth ?? null,
      fipeFuel: fipeReference?.fipeFuel ?? matchedVehicle?.fipeFuel ?? null,
      fipeBrandMatched: fipeReference?.fipeBrandMatched ?? matchedVehicle?.fipeBrandMatched ?? null,
      fipeModelMatched: fipeReference?.fipeModelMatched ?? matchedVehicle?.fipeModelMatched ?? null,
    },
    metrics: {
      fipePercent,
      feeEstimate,
      totalFipePercent,
      marketAnalysis,
      marketStatus: marketAnalysis && bid != null
        ? bid <= marketAnalysis.averageValue ? 'within' : 'above'
        : null,
    },
  }
})

function normalizeInput(value: unknown): LiveAssistantInput | null {
  if (!isRecord(value)) return null

  const source = nullableString(value['source']) as LiveAssistantSource | null
  if (!source || !SUPPORTED_SOURCES.has(source)) return null

  const imageUrl = nullableString(value['imageUrl'])
  const rawIdentity = {
    auctionId: nullableString(value['auctionId']),
    code: nullableString(value['code']),
    imageUrl,
    vehicleUrl: nullableString(value['vehicleUrl']),
  }
  const identity = source === 'sodre' ? normalizeSodreLiveIdentity(rawIdentity) : rawIdentity

  return {
    source,
    auctionId: identity.auctionId,
    lot: nullableString(value['lot']),
    code: identity.code,
    description: nullableString(value['description']),
    yearModel: nullableString(value['yearModel']),
    brand: nullableString(value['brand']),
    model: nullableString(value['model']),
    version: nullableString(value['version']),
    fuel: nullableString(value['fuel']),
    damage: nullableString(value['damage']),
    yard: nullableString(value['yard']),
    consignor: nullableString(value['consignor']),
    bid: positiveNumber(value['bid']),
    fipe: positiveNumber(value['fipe']),
    imageUrl,
    vehicleUrl: identity.vehicleUrl,
    allowDatabaseFipeReference: value['allowDatabaseFipeReference'] === true,
    publishedFees: source === 'pestana' ? normalizePublishedAuctionFees(value['publishedFees']) : null,
  }
}

async function findMatchedVehicle(input: LiveAssistantInput): Promise<VehicleCandidate | null> {
  const identityClauses: Record<string, unknown>[] = []

  if (input.vehicleUrl) identityClauses.push({ url: input.vehicleUrl })
  if (input.auctionId && input.lot) identityClauses.push({ auctionId: input.auctionId, lot: input.lot })

  if (input.code) {
    const codePattern = liveLotCodePattern(input.code)
    identityClauses.push(
      { url: codePattern },
      { title: codePattern },
      { description: codePattern },
    )
  }

  if (identityClauses.length === 0) return null

  const docs = await VehicleModel.find({
    source: input.source,
    $or: identityClauses,
  })
    .sort({ scrapedAt: -1 })
    .limit(30)
    .lean()

  let best: VehicleCandidate | null = null
  let bestScore = 0

  for (const doc of docs) {
    const candidate = {
      ...doc,
      _id: String((doc as Record<string, unknown>)['_id']),
    } as VehicleCandidate
    if (!isSameLiveAssistantLot(input, candidate) || !isCandidateCompatible(input, candidate)) continue

    const score = scoreCandidate(input, candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return bestScore >= 35 ? best : null
}

function isCandidateCompatible(input: LiveAssistantInput, candidate: VehicleCandidate): boolean {
  if (!areVehicleBrandsCompatible(input.brand, candidate.brand)) return false

  const inputYear = parseYear(input.yearModel)
  if (inputYear == null || candidate.year == null || inputYear === candidate.year) return true

  // URL/código identificam o lote real. Já a busca ampla por marca/modelo não
  // pode transformar um veículo de outro ano em correspondência exata.
  const candidateText = normalizeToken([candidate.url, candidate.title, candidate.description].join(' '))
  return (input.vehicleUrl != null && candidate.url === input.vehicleUrl)
    || (input.code != null && candidateText.includes(normalizeToken(input.code)))
}

function scoreCandidate(input: LiveAssistantInput, candidate: VehicleCandidate): number {
  let score = 0
  const candidateText = normalizeToken([candidate.url, candidate.title, candidate.description].join(' '))

  if (input.vehicleUrl && candidate.url === input.vehicleUrl) score += 120
  if (input.code && candidateText.includes(normalizeToken(input.code))) score += 80
  if (input.auctionId && input.auctionId === candidate.auctionId && input.lot === candidate.lot) score += 120
  if (input.brand && normalizeToken(candidate.brand) === normalizeToken(input.brand)) score += 25

  if (input.model) {
    const inputModel = normalizeToken(input.model)
    const candidateModel = normalizeToken(candidate.model)
    if (candidateModel === inputModel) score += 40
    else if (candidateModel.includes(inputModel) || inputModel.includes(candidateModel)) score += 30
    else score += Math.round(tokenCoverage(inputModel, candidateModel) * 25)
  }

  const year = parseYear(input.yearModel)
  if (year != null && candidate.year === year) score += 10

  return score
}

function tokenCoverage(input: string, candidate: string): number {
  const inputTokens = input.split(' ').filter(token => token.length >= 2)
  if (inputTokens.length === 0) return 0
  const candidateTokens = new Set(candidate.split(' '))
  const matches = inputTokens.filter(token => candidateTokens.has(token)).length
  return matches / inputTokens.length
}

function getMatchedBid(matched: VehicleCandidate | null): number | null {
  if (!matched) return null
  if (matched.saleStatus === 'sold') return matched.soldPrice ?? matched.price ?? null
  return matched.price ?? matched.soldPrice ?? null
}

function buildAnalysisVehicle(
  input: LiveAssistantInput,
  matched: VehicleCandidate | null,
  bid: number | null,
  fipeReference: LiveAssistantFipeReference | null,
): VehicleRecord {
  const now = new Date()
  const brand = matched?.brand ?? input.brand ?? 'Não identificada'
  const model = matched?.model ?? input.model ?? input.description ?? 'Não identificado'
  const title = input.description ?? matched?.title ?? `${brand} ${model}`.trim()
  const description = input.description ?? matched?.description ?? title

  return {
    _id: matched?._id,
    source: input.source,
    externalId: matched?.externalId ?? `live-assistant:${input.source}:${input.code ?? input.lot ?? 'preview'}`,
    brand,
    model,
    version: input.version ?? matched?.version ?? null,
    year: parseYear(input.yearModel) ?? matched?.year ?? null,
    color: matched?.color ?? null,
    km: matched?.km ?? null,
    fuel: input.fuel ?? matched?.fuel ?? null,
    title,
    description,
    price: bid,
    priceRaw: null,
    url: input.vehicleUrl ?? matched?.url ?? 'http://localhost:3000/cars',
    imageUrls: input.imageUrl ? [input.imageUrl] : matched?.imageUrls ?? [],
    auctionDate: matched?.auctionDate ?? now,
    lot: input.lot ?? matched?.lot ?? null,
    damage: normalizeDamage(input.damage ?? matched?.damage),
    yard: input.yard ?? matched?.yard ?? null,
    consignor: input.consignor ?? matched?.consignor ?? null,
    auctionStatus: matched?.auctionStatus ?? 'unknown',
    auctionStatusRaw: matched?.auctionStatusRaw ?? null,
    auctionStatusCheckedAt: matched?.auctionStatusCheckedAt ?? null,
    saleStatus: matched?.saleStatus ?? 'unknown',
    saleStatusRaw: matched?.saleStatusRaw ?? null,
    saleStatusCheckedAt: matched?.saleStatusCheckedAt ?? null,
    soldPrice: matched?.soldPrice ?? null,
    soldPriceRaw: matched?.soldPriceRaw ?? null,
    fipe: input.fipe ?? positiveNumber(matched?.fipe) ?? fipeReference?.value ?? null,
    fipeCode: fipeReference?.fipeCode ?? matched?.fipeCode ?? null,
    fipeReferenceMonth: fipeReference?.fipeReferenceMonth ?? matched?.fipeReferenceMonth ?? null,
    fipeFuel: fipeReference?.fipeFuel ?? matched?.fipeFuel ?? null,
    fipeCheckedAt: fipeReference?.checkedAt ? new Date(fipeReference.checkedAt) : matched?.fipeCheckedAt ?? null,
    fipeBrandMatched: fipeReference?.fipeBrandMatched ?? matched?.fipeBrandMatched ?? null,
    fipeModelMatched: fipeReference?.fipeModelMatched ?? matched?.fipeModelMatched ?? null,
    location: matched?.location ?? null,
    city: matched?.city ?? null,
    state: matched?.state ?? null,
    scrapedAt: matched?.scrapedAt ?? now,
    expiresAt: matched?.expiresAt ?? getVehicleRetentionDate(now),
    status: matched?.status ?? 'scraped',
    sentAt: matched?.sentAt ?? null,
    sentTo: matched?.sentTo ?? null,
    collectedVia: matched?.collectedVia ?? null,
  }
}

async function findFipeReference(
  input: LiveAssistantInput,
  matched: VehicleCandidate | null,
): Promise<LiveAssistantFipeReference | null> {
  const brand = matched?.brand ?? input.brand
  const model = matched?.model ?? input.model
  const year = parseYear(input.yearModel) ?? matched?.year ?? null
  if (!brand || !model || year == null) return null

  const docs = await VehicleModel.find({
    year,
    fipe: { $gt: 0 },
    brand: brandSearchPattern(brand),
    $or: ['model', 'version', 'description', 'fipeModelMatched'].map(field => ({ [field]: modelFamilySearchPattern(model) })),
  })
    .select({
      brand: 1,
      model: 1,
      version: 1,
      description: 1,
      title: 1,
      url: 1,
      source: 1,
      year: 1,
      fipe: 1,
      fuel: 1,
      fipeCheckedAt: 1,
      scrapedAt: 1,
      fipeCode: 1,
      fipeReferenceMonth: 1,
      fipeFuel: 1,
      fipeBrandMatched: 1,
      fipeModelMatched: 1,
    })
    .sort({ fipeCheckedAt: -1, scrapedAt: -1 })
    .limit(500)
    .lean()

  return selectLiveAssistantFipeReference({
    id: matched?._id ?? null,
    brand,
    model,
    version: input.version ?? matched?.version,
    description: input.description ?? matched?.description,
    title: matched?.title,
    url: input.vehicleUrl ?? matched?.url,
    year,
    fuel: input.fuel ?? matched?.fuel ?? null,
  }, docs.map(doc => ({
    id: String((doc as Record<string, unknown>)['_id']),
    brand: doc.brand,
    model: doc.model,
    version: doc.version,
    description: doc.description,
    title: doc.title,
    url: doc.url,
    source: doc.source,
    year: doc.year,
    fipe: doc.fipe,
    fuel: doc.fuel ?? doc.fipeFuel,
    checkedAt: doc.fipeCheckedAt ?? doc.scrapedAt,
    fipeCode: doc.fipeCode,
    fipeReferenceMonth: doc.fipeReferenceMonth,
    fipeFuel: doc.fipeFuel,
    fipeBrandMatched: doc.fipeBrandMatched,
    fipeModelMatched: doc.fipeModelMatched,
  })))
}

function brandSearchPattern(value: string): RegExp {
  const normalized = normalizeToken(value)
  const aliases = normalized === 'VW' || normalized === 'VOLKSWAGEN'
    ? ['VW', 'VOLKSWAGEN']
    : normalized === 'GM' || normalized === 'CHEVROLET'
      ? ['GM', 'CHEVROLET']
      : [normalized]
  const patterns = aliases.map(alias => alias.split(' ').map(normalizedTextPattern).join('[^A-Z0-9]+'))
  return new RegExp(`(?:^|[^A-Z0-9])(?:${patterns.join('|')})(?:[^A-Z0-9]|$)`, 'i')
}

function modelFamilySearchPattern(value: string): RegExp {
  const family = normalizeToken(value).split(' ')[0] ?? ''
  if (/^3\d{2}(?:I|IA|E|D)?$|^SERIE$|^SERIES$/.test(family)) return /^(?:3\d{2}(?:i|ia|e|d)?|serie[s]?\s*3)(?:[^a-z0-9]|$)/i
  return new RegExp(`^${normalizedTextPattern(family)}(?:[^A-Z0-9]|$)`, 'i')
}

function normalizedTextPattern(value: string): string {
  const accentGroups: Record<string, string> = {
    A: '[AÀÁÂÃÄ]',
    C: '[CÇ]',
    E: '[EÈÉÊË]',
    I: '[IÌÍÎÏ]',
    N: '[NÑ]',
    O: '[OÒÓÔÕÖ]',
    U: '[UÙÚÛÜ]',
  }
  return [...value].map(character => accentGroups[character] ?? escapeRegExp(character)).join('')
}

function parseYear(value: string | null): number | null {
  if (!value) return null
  const years = [...value.matchAll(/\b((?:19|20)\d{2})\b/g)].map(match => Number(match[1]))
  return years.length > 0 ? Math.max(...years) : null
}

function calculatePercent(value: number | null, fipe: number | null): number | null {
  if (value == null || fipe == null || fipe <= 0) return null
  return Math.round((value / fipe) * 100)
}

function normalizeToken(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
