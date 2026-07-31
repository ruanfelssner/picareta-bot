import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { calculateTotalFipePercent, estimateVehicleFees } from '#shared/utils/auction-fees'
import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'
import { buildVehicleMarketAnalysis, loadMarketHistory } from '../../utils/vehicle-market-analysis'
import { VehicleModel } from '../../utils/schemas/vehicle'
import { areVehicleBrandsCompatible, normalizeSodreLiveIdentity } from '../../utils/sodre-live-identity'

type LiveAssistantSource = Extract<VehicleSource, 'copart' | 'vipleiloes' | 'sodre'>

type LiveAssistantInput = {
  source: LiveAssistantSource
  auctionId: string | null
  lot: string | null
  code: string | null
  description: string | null
  yearModel: string | null
  brand: string | null
  model: string | null
  damage: string | null
  yard: string | null
  consignor: string | null
  bid: number | null
  fipe: number | null
  imageUrl: string | null
  vehicleUrl: string | null
}

type VehicleCandidate = VehicleRecord & { _id: string }

const SUPPORTED_SOURCES = new Set<LiveAssistantSource>(['copart', 'vipleiloes', 'sodre'])

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)

  const rawBody = await readBody<unknown>(event).catch((): unknown => null)
  const input = normalizeInput(rawBody)
  if (!input) {
    throw createError({ statusCode: 400, message: 'Dados do lote inválidos.' })
  }

  const matchedVehicle = await findMatchedVehicle(input)
  const vehicle = buildAnalysisVehicle(input, matchedVehicle)
  const marketHistory = await loadMarketHistory()
  const marketAnalysis = buildVehicleMarketAnalysis(vehicle, marketHistory)
  const feeEstimate = estimateVehicleFees(vehicle, input.bid)
  const fipePercent = calculatePercent(input.bid, vehicle.fipe)
  const totalFipePercent = calculateTotalFipePercent(feeEstimate?.total ?? null, vehicle.fipe)

  return {
    matched: matchedVehicle != null,
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
      bid: input.bid,
      fipe: vehicle.fipe,
      fipeCode: matchedVehicle?.fipeCode ?? null,
      fipeReferenceMonth: matchedVehicle?.fipeReferenceMonth ?? null,
      fipeFuel: matchedVehicle?.fipeFuel ?? null,
      fipeBrandMatched: matchedVehicle?.fipeBrandMatched ?? null,
      fipeModelMatched: matchedVehicle?.fipeModelMatched ?? null,
    },
    metrics: {
      fipePercent,
      feeEstimate,
      totalFipePercent,
      marketAnalysis,
      marketStatus: marketAnalysis && input.bid != null
        ? input.bid <= marketAnalysis.maxBid ? 'within' : 'above'
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
    damage: nullableString(value['damage']),
    yard: nullableString(value['yard']),
    consignor: nullableString(value['consignor']),
    bid: positiveNumber(value['bid']),
    fipe: positiveNumber(value['fipe']),
    imageUrl,
    vehicleUrl: identity.vehicleUrl,
  }
}

async function findMatchedVehicle(input: LiveAssistantInput): Promise<VehicleCandidate | null> {
  const identityClauses: Record<string, unknown>[] = []

  if (input.vehicleUrl) identityClauses.push({ url: input.vehicleUrl })
  if (input.lot) identityClauses.push({ lot: input.lot })

  if (input.code) {
    const codePattern = new RegExp(escapeRegExp(input.code), 'i')
    identityClauses.push(
      { url: codePattern },
      { title: codePattern },
      { description: codePattern },
    )
  }

  if (input.brand && input.model) {
    const modelToken = normalizeToken(input.model).split(' ')[0]
    if (modelToken) {
      identityClauses.push({
        brand: new RegExp(`^${escapeRegExp(input.brand)}$`, 'i'),
        model: new RegExp(escapeRegExp(modelToken), 'i'),
      })
    }
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
    if (!isCandidateCompatible(input, candidate)) continue

    const score = scoreCandidate(input, candidate)
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }

  return bestScore >= 35 ? best : null
}

function isCandidateCompatible(input: LiveAssistantInput, candidate: VehicleCandidate): boolean {
  return areVehicleBrandsCompatible(input.brand, candidate.brand)
}

function scoreCandidate(input: LiveAssistantInput, candidate: VehicleCandidate): number {
  let score = 0
  const candidateText = normalizeToken([candidate.url, candidate.title, candidate.description].join(' '))

  if (input.vehicleUrl && candidate.url === input.vehicleUrl) score += 120
  if (input.code && candidateText.includes(normalizeToken(input.code))) score += 80
  if (input.lot && normalizeToken(candidate.lot) === normalizeToken(input.lot)) score += 30
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

function buildAnalysisVehicle(input: LiveAssistantInput, matched: VehicleCandidate | null): VehicleRecord {
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
    year: parseYear(input.yearModel) ?? matched?.year ?? null,
    color: matched?.color ?? null,
    km: matched?.km ?? null,
    fuel: matched?.fuel ?? null,
    title,
    description,
    price: input.bid,
    priceRaw: null,
    url: input.vehicleUrl ?? matched?.url ?? 'http://localhost:3000/cars',
    imageUrls: input.imageUrl ? [input.imageUrl] : matched?.imageUrls ?? [],
    auctionDate: matched?.auctionDate ?? now,
    lot: input.lot ?? matched?.lot ?? null,
    damage: input.damage ?? matched?.damage ?? null,
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
    fipe: input.fipe ?? matched?.fipe ?? null,
    fipeCode: matched?.fipeCode ?? null,
    fipeReferenceMonth: matched?.fipeReferenceMonth ?? null,
    fipeFuel: matched?.fipeFuel ?? null,
    fipeCheckedAt: matched?.fipeCheckedAt ?? null,
    fipeBrandMatched: matched?.fipeBrandMatched ?? null,
    fipeModelMatched: matched?.fipeModelMatched ?? null,
    location: matched?.location ?? null,
    city: matched?.city ?? null,
    state: matched?.state ?? null,
    scrapedAt: matched?.scrapedAt ?? now,
    expiresAt: matched?.expiresAt ?? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    status: matched?.status ?? 'scraped',
    sentAt: matched?.sentAt ?? null,
    sentTo: matched?.sentTo ?? null,
    collectedVia: matched?.collectedVia ?? null,
  }
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
