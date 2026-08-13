import { SOURCE_META } from '#shared/constants/sources'
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

export type MarketHistoryRecord = Pick<
  VehicleRecord,
  'source' | 'brand' | 'model' | 'year' | 'damage' | 'price' | 'soldPrice' | 'fipe' | 'saleStatus'
>

export async function loadMarketHistory(): Promise<MarketHistoryRecord[]> {
  return (await VehicleModel.find(
    {
      saleStatus: { $in: ['sold', 'conditional'] },
      fipe: { $gt: 0 },
      $or: [
        { soldPrice: { $gt: 0 } },
        { price: { $gt: 0 } },
      ],
    },
    { source: 1, brand: 1, model: 1, year: 1, damage: 1, price: 1, soldPrice: 1, fipe: 1, saleStatus: 1 },
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
