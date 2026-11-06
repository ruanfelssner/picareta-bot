import { SOURCE_META, DISABLED_AUCTION_SOURCES, isAuctionSourceDisabled } from '#shared/constants/sources'
import type { VehicleMarketAnalysis, VehicleMarketAnalysisBasis } from '#shared/types/market-analysis'
import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { estimateVehicleFees } from '#shared/utils/auction-fees'
import {
  classifyDamage,
  damageLabel,
  mean,
  normalizeBrand,
  round1,
} from './market-analytics'
import { VehicleModel } from './schemas/vehicle'
import { areVehicleBrandsCompatible } from './sodre-live-identity'
import { referenceCompatibility, vehicleReferenceIdentity } from '../../../../shared/utils/vehicle-reference-identity'

export type MarketHistoryRecord = Pick<
  VehicleRecord,
  'source' | 'brand' | 'model' | 'year' | 'damage' | 'price' | 'soldPrice' | 'fipe' | 'saleStatus'
> & Partial<Pick<VehicleRecord, 'version' | 'description' | 'title' | 'url' | 'auctionDate' | 'scrapedAt'>>

export async function loadMarketHistory(includeWithoutFipe = false): Promise<MarketHistoryRecord[]> {
  return (await VehicleModel.find(
    {
      source: { $nin: [...DISABLED_AUCTION_SOURCES] },
      saleStatus: { $in: ['sold', 'conditional'] },
      ...(includeWithoutFipe ? {} : { fipe: { $gt: 0 } }),
      $or: [
        { soldPrice: { $gt: 0 } },
        { price: { $gt: 0 } },
      ],
    },
    { source: 1, brand: 1, model: 1, year: 1, damage: 1, price: 1, soldPrice: 1, fipe: 1, saleStatus: 1, ...(includeWithoutFipe ? { version: 1, description: 1, title: 1, url: 1, auctionDate: 1, scrapedAt: 1 } : {}) },
  ).lean()) as unknown as MarketHistoryRecord[]
}

type MarketGroup = {
  soldValues: number[]
  conditionalValues: number[]
}

type MarketAnalysisCandidate = {
  key: string
  basis: VehicleMarketAnalysisBasis
  minimumSample: number
}

const MODEL_MINIMUM_SAMPLE = 3
const SEGMENT_MINIMUM_SAMPLE = 10
const GLOBAL_MINIMUM_SAMPLE = 30
const KEY_SEPARATOR = '\u001f'

function normalizeToken(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
}

function sourceName(source: VehicleSource): string {
  return SOURCE_META[source]?.name ?? source
}

function effectivePrice(record: Pick<MarketHistoryRecord, 'price' | 'soldPrice'>): number | null {
  const price = record.soldPrice ?? record.price
  return typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null
}

function fipePct(record: MarketHistoryRecord): number | null {
  const price = effectivePrice(record)
  if (price == null || record.fipe == null || record.fipe <= 0) return null
  return (price / record.fipe) * 100
}

function addValue(
  groups: Map<string, MarketGroup>,
  key: string,
  value: number,
  saleStatus: MarketHistoryRecord['saleStatus'],
): void {
  const group = groups.get(key)
  if (group) {
    if (saleStatus === 'sold') group.soldValues.push(value)
    if (saleStatus === 'conditional') group.conditionalValues.push(value)
    return
  }
  groups.set(key, {
    soldValues: saleStatus === 'sold' ? [value] : [],
    conditionalValues: saleStatus === 'conditional' ? [value] : [],
  })
}

function makeKey(...parts: string[]): string {
  return parts.join(KEY_SEPARATOR)
}

function buildGroups(history: MarketHistoryRecord[]): Map<string, MarketGroup> {
  const groups = new Map<string, MarketGroup>()

  for (const record of history) {
    if (isAuctionSourceDisabled(record.source)) continue
    const pct = fipePct(record)
    if (pct == null) continue

    const source = record.source
    const brand = normalizeBrand(record.brand)
    const model = normalizeToken(record.model)
    const year = record.year != null ? String(record.year) : ''
    const damage = classifyDamage(record.damage)

    if (year) {
      addValue(groups, makeKey('source-model-year', source, brand, model, year), pct, record.saleStatus)
      addValue(groups, makeKey('market-model-year', brand, model, year), pct, record.saleStatus)
    }
    addValue(groups, makeKey('source-model', source, brand, model), pct, record.saleStatus)
    addValue(groups, makeKey('market-model', brand, model), pct, record.saleStatus)
    addValue(groups, makeKey('source', source), pct, record.saleStatus)
    addValue(groups, makeKey('market'), pct, record.saleStatus)

    if (damage !== 'sem_info') {
      if (year) {
        addValue(groups, makeKey('source-model-year-damage', source, brand, model, year, damage), pct, record.saleStatus)
        addValue(groups, makeKey('model-year-damage', brand, model, year, damage), pct, record.saleStatus)
      }
      addValue(groups, makeKey('source-model-damage', source, brand, model, damage), pct, record.saleStatus)
      addValue(groups, makeKey('model-damage', brand, model, damage), pct, record.saleStatus)
      addValue(groups, makeKey('source-damage', source, damage), pct, record.saleStatus)
      addValue(groups, makeKey('damage-market', damage), pct, record.saleStatus)
    }
  }

  return groups
}

function candidateLabel(
  candidate: MarketAnalysisCandidate,
  vehicle: VehicleRecord,
  sampleSize: number,
): string {
  const source = sourceName(vehicle.source)
  const year = vehicle.year != null ? String(vehicle.year) : null
  const damage = damageLabel(classifyDamage(vehicle.damage)).toLowerCase()

  switch (candidate.basis) {
    case 'model-year-source-damage':
      return `${sampleSize} vendidos do modelo ${year}, na ${source}, ${damage}`
    case 'model-year-source':
      return `${sampleSize} vendidos do modelo ${year}, na ${source}`
    case 'model-year-damage':
      return `${sampleSize} vendidos do modelo ${year}, ${damage}`
    case 'model-year-market':
      return `${sampleSize} vendidos do modelo ${year} no mercado`
    case 'model-source-damage':
      return `${sampleSize} vendidos do modelo na ${source}, ${damage}`
    case 'model-source':
      return `${sampleSize} vendidos do modelo na ${source}`
    case 'model-damage':
      return `${sampleSize} vendidos do modelo, ${damage}`
    case 'model-market':
      return `${sampleSize} vendidos do modelo no mercado`
    case 'source-damage':
      return `${sampleSize} vendidos na ${source}, ${damage}`
    case 'source':
      return `${sampleSize} vendidos na ${source}`
    case 'damage-market':
      return `${sampleSize} vendidos no mercado, ${damage}`
    case 'market':
      return `${sampleSize} vendidos no mercado`
  }

  return 'Histórico de arremates'
}

function findCandidate(
  candidates: MarketAnalysisCandidate[],
  groups: Map<string, MarketGroup>,
): { candidate: MarketAnalysisCandidate; averagePct: number; conditionalAveragePct: number | null; sampleSize: number } | null {
  for (const candidate of candidates) {
    const group = groups.get(candidate.key)
    if (!group || group.soldValues.length < candidate.minimumSample) continue

    const averagePct = mean(group.soldValues)
    if (averagePct == null) continue

    return {
      candidate,
      averagePct,
      conditionalAveragePct: mean(group.conditionalValues),
      sampleSize: group.soldValues.length,
    }
  }

  return null
}

function calculateMaxBid(vehicle: VehicleRecord, targetTotal: number): { maxBid: number; feesIncluded: boolean } {
  const probe = estimateVehicleFees(vehicle, 1)
  if (probe == null) {
    return { maxBid: Math.floor(targetTotal / 100) * 100, feesIncluded: false }
  }

  let low = 0
  let high = Math.floor(targetTotal)
  let best = 0

  while (low <= high) {
    const bid = Math.floor((low + high) / 2)
    const total = bid > 0 ? estimateVehicleFees(vehicle, bid)?.total ?? Number.POSITIVE_INFINITY : 0

    if (total <= targetTotal) {
      best = bid
      low = bid + 1
    }
    else {
      high = bid - 1
    }
  }

  return {
    maxBid: Math.floor(best / 100) * 100,
    feesIncluded: true,
  }
}

export function buildVehicleMarketAnalysis(
  vehicle: VehicleRecord,
  history: MarketHistoryRecord[],
): VehicleMarketAnalysis | null {
  return buildVehicleMarketAnalysisFromGroups(vehicle, buildGroups(history))
}

function buildVehicleMarketAnalysisFromGroups(
  vehicle: VehicleRecord,
  groups: Map<string, MarketGroup>,
): VehicleMarketAnalysis | null {
  if (vehicle.fipe == null || vehicle.fipe <= 0) return null

  const source = vehicle.source
  const brand = normalizeBrand(vehicle.brand)
  const model = normalizeToken(vehicle.model)
  const year = vehicle.year != null ? String(vehicle.year) : null
  const damage = classifyDamage(vehicle.damage)
  const candidates: MarketAnalysisCandidate[] = []

  if (year && damage !== 'sem_info') {
    candidates.push({
      key: makeKey('source-model-year-damage', source, brand, model, year, damage),
      basis: 'model-year-source-damage',
      minimumSample: MODEL_MINIMUM_SAMPLE,
    })
  }

  if (year) {
    candidates.push({
      key: makeKey('source-model-year', source, brand, model, year),
      basis: 'model-year-source',
      minimumSample: MODEL_MINIMUM_SAMPLE,
    })
  }

  if (year && damage !== 'sem_info') {
    candidates.push({
      key: makeKey('model-year-damage', brand, model, year, damage),
      basis: 'model-year-damage',
      minimumSample: MODEL_MINIMUM_SAMPLE,
    })
  }

  if (year) {
    candidates.push({
      key: makeKey('market-model-year', brand, model, year),
      basis: 'model-year-market',
      minimumSample: MODEL_MINIMUM_SAMPLE,
    })
  }

  if (damage !== 'sem_info') {
    candidates.push({
      key: makeKey('source-model-damage', source, brand, model, damage),
      basis: 'model-source-damage',
      minimumSample: MODEL_MINIMUM_SAMPLE,
    })
  }

  candidates.push({
    key: makeKey('source-model', source, brand, model),
    basis: 'model-source',
    minimumSample: MODEL_MINIMUM_SAMPLE,
  })

  if (damage !== 'sem_info') {
    candidates.push({
      key: makeKey('model-damage', brand, model, damage),
      basis: 'model-damage',
      minimumSample: MODEL_MINIMUM_SAMPLE,
    })
  }

  candidates.push({
    key: makeKey('market-model', brand, model),
    basis: 'model-market',
    minimumSample: MODEL_MINIMUM_SAMPLE,
  })

  if (damage !== 'sem_info') {
    candidates.push({
      key: makeKey('source-damage', source, damage),
      basis: 'source-damage',
      minimumSample: SEGMENT_MINIMUM_SAMPLE,
    })
  }

  candidates.push({
    key: makeKey('source', source),
    basis: 'source',
    minimumSample: SEGMENT_MINIMUM_SAMPLE,
  })

  if (damage !== 'sem_info') {
    candidates.push({
      key: makeKey('damage-market', damage),
      basis: 'damage-market',
      minimumSample: SEGMENT_MINIMUM_SAMPLE,
    })
  }

  candidates.push({
    key: makeKey('market'),
    basis: 'market',
    minimumSample: GLOBAL_MINIMUM_SAMPLE,
  })

  const match = findCandidate(candidates, groups)
  if (!match) return null

  const targetTotal = Math.round(vehicle.fipe * (match.averagePct / 100))
  if (targetTotal <= 0) return null

  const { maxBid, feesIncluded } = calculateMaxBid(vehicle, targetTotal)

  return {
    maxBid,
    maxTotal: targetTotal,
    averagePct: round1(match.averagePct),
    conditionalAveragePct: match.conditionalAveragePct != null ? round1(match.conditionalAveragePct) : null,
    sampleSize: match.sampleSize,
    basis: match.candidate.basis,
    basisLabel: candidateLabel(match.candidate, vehicle, match.sampleSize),
    feesIncluded,
  }
}

export function buildVehicleMarketAnalyses(
  vehicles: VehicleRecord[],
  history: MarketHistoryRecord[],
): Array<VehicleMarketAnalysis | null> {
  const groups = buildGroups(history)
  return vehicles.map(vehicle => buildVehicleMarketAnalysisFromGroups(vehicle, groups))
}


export type LiveVehicleMarketAnalysis = Omit<VehicleMarketAnalysis, 'averagePct'> & {
  averagePct: number | null
  averageValue: number
  conditionalAverageValue: number | null
  comparisonMode: 'value'
  sourceBreakdown: Array<{ source: VehicleSource; sourceLabel: string; sampleSize: number; averageValue: number }>
}

/** Ao vivo: uma venda real já é referência, inclusive quando não há FIPE. */
export function buildLiveVehicleMarketAnalysis(vehicle: VehicleRecord, history: MarketHistoryRecord[]): LiveVehicleMarketAnalysis | null {
  const seen = new Set<string>()
  const records = history.slice().sort((a, b) => String(b.scrapedAt ?? '').localeCompare(String(a.scrapedAt ?? ''))).filter(record => {
    if (isAuctionSourceDisabled(record.source) || !['sold', 'conditional'].includes(record.saleStatus)
      || effectivePrice(record) == null || !record.brand || !record.model
      || !areVehicleBrandsCompatible(record.brand, vehicle.brand)
      || referenceCompatibility(vehicle, record) === 0) return false
    if (!record.url) return true
    const timestamp = record.auctionDate ? new Date(record.auctionDate).getTime() : Number.NaN
    const day = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : ''
    const key = `${record.source}:${record.url.split('?')[0].replace(/\/+$/, '')}:${day}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (!vehicleReferenceIdentity(vehicle).family) return null
  const damage = classifyDamage(vehicle.damage)
  const year = (r: MarketHistoryRecord) => vehicle.year != null && r.year === vehicle.year
  const sameDamage = (r: MarketHistoryRecord) => damage !== 'sem_info' && classifyDamage(r.damage) === damage
  const candidates: Array<{ basis: VehicleMarketAnalysisBasis; accept: (r: MarketHistoryRecord) => boolean }> = [
    { basis: 'model-year-damage', accept: r => year(r) && sameDamage(r) },
    { basis: 'model-year-market', accept: year },
    { basis: 'model-damage', accept: sameDamage },
    { basis: 'model-market', accept: () => true },
  ]
  for (const candidate of candidates) {
    const sample = records.filter(candidate.accept)
    const sales = sample.filter(r => r.saleStatus === 'sold').map(r => effectivePrice(r)!).filter(Number.isFinite)
    const average = mean(sales)
    if (average == null) continue
    const conditional = mean(sample.filter(r => r.saleStatus === 'conditional').map(r => effectivePrice(r)!).filter(Number.isFinite))
    const fipe = vehicle.fipe != null && Number.isFinite(vehicle.fipe) && vehicle.fipe > 0 ? vehicle.fipe : null
    const sourceSales = new Map<VehicleSource, number[]>()
    for (const record of sample) {
      if (record.saleStatus !== 'sold') continue
      const values = sourceSales.get(record.source) ?? []
      values.push(effectivePrice(record)!)
      sourceSales.set(record.source, values)
    }
    const sourceBreakdown = [...sourceSales].map(([source, values]) => ({
      source, sourceLabel: sourceName(source), sampleSize: values.length, averageValue: Math.round(mean(values)!),
    })).sort((a, b) => b.sampleSize - a.sampleSize || a.sourceLabel.localeCompare(b.sourceLabel))
    const maxTotal = Math.round(average)
    return {
      ...calculateMaxBid(vehicle, maxTotal), maxTotal, averageValue: maxTotal,
      conditionalAverageValue: conditional == null ? null : Math.round(conditional), comparisonMode: 'value',
      averagePct: fipe == null ? null : round1(average / fipe * 100),
      conditionalAveragePct: fipe == null || conditional == null ? null : round1(conditional / fipe * 100),
      sourceBreakdown,
      sampleSize: sales.length, basis: candidate.basis,
      basisLabel: candidateLabel({ key: '', basis: candidate.basis, minimumSample: 1 }, vehicle, sales.length),
    }
  }
  return null
}
