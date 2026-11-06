import { areVehicleBrandsCompatible } from './sodre-live-identity'
import { referenceCompatibility, referenceToken, vehicleReferenceIdentity } from '../../../../shared/utils/vehicle-reference-identity'

export type LiveAssistantFipeCandidate = {
  id: string
  brand: string | null
  model: string | null
  version?: string | null
  description?: string | null
  title?: string | null
  url?: string | null
  source?: string | null
  year: number | null
  fipe: number | null
  fuel?: string | null
  checkedAt?: Date | string | null
  fipeCode?: string | null
  fipeReferenceMonth?: string | null
  fipeFuel?: string | null
  fipeBrandMatched?: string | null
  fipeModelMatched?: string | null
}

export type LiveAssistantFipeReference = {
  vehicleId: string
  brand: string
  model: string
  year: number
  value: number
  checkedAt: string | null
  sampleSize: number
  source: string | null
  label: 'Referência não exata'
  fipeCode: string | null
  fipeReferenceMonth: string | null
  fipeFuel: string | null
  fipeBrandMatched: string | null
  fipeModelMatched: string | null
}

type LiveAssistantFipeTarget = {
  id: string | null
  brand: string | null
  model: string | null
  version?: string | null
  description?: string | null
  title?: string | null
  url?: string | null
  source?: string | null
  year: number | null
  fuel?: string | null
}

export function selectLiveAssistantFipeReference(
  target: LiveAssistantFipeTarget,
  records: LiveAssistantFipeCandidate[],
): LiveAssistantFipeReference | null {
  const targetModel = referenceToken(target.model)
  if (!target.brand || !targetModel || !target.year) return null

  const candidates = records
    .filter(record => record.id !== target.id
      && record.year === target.year
      && record.fipe != null
      && Number.isFinite(record.fipe)
      && record.fipe > 0
      && record.brand != null
      && areVehicleBrandsCompatible(target.brand, record.brand)
      && (!record.fipeBrandMatched || areVehicleBrandsCompatible(target.brand, record.fipeBrandMatched))
      && (!target.url || !record.url || target.url.split('?')[0].replace(/\/+$/, '') !== record.url.split('?')[0].replace(/\/+$/, '')))
    .map(record => ({ record, score: referenceCompatibility(target, record) }))
    .filter(candidate => candidate.score > 0)
    .sort((first, second) => second.score - first.score
      || checkedAtValue(second.record.checkedAt).localeCompare(checkedAtValue(first.record.checkedAt))
      || first.record.id.localeCompare(second.record.id))

  // Uma cotação antiga da mesma configuração não vence a mais recente pelo preço.
  const signatures = new Set<string>()
  const latest = candidates.filter(({ record }) => {
    const signature = JSON.stringify(vehicleReferenceIdentity(record))
    if (signatures.has(signature)) return false
    signatures.add(signature)
    return true
  }).sort((a, b) => b.score - a.score || (a.record.fipe ?? 0) - (b.record.fipe ?? 0))
  const match = latest[0]?.record
  if (!match?.brand || !match.model || match.fipe == null || match.year == null) return null

  return {
    vehicleId: match.id,
    brand: match.brand,
    model: match.version ?? match.fipeModelMatched ?? match.model,
    year: match.year,
    value: match.fipe,
    checkedAt: checkedAtValue(match.checkedAt) || null,
    label: 'Referência não exata',
    sampleSize: new Set(candidates.filter(c => JSON.stringify(vehicleReferenceIdentity(c.record)) === JSON.stringify(vehicleReferenceIdentity(match))).map(c => c.record.url?.split('?')[0] ?? c.record.id)).size,
    source: match.source ?? null,
    fipeCode: match.fipeCode ?? null,
    fipeReferenceMonth: match.fipeReferenceMonth ?? null,
    fipeFuel: match.fipeFuel ?? null,
    fipeBrandMatched: match.fipeBrandMatched ?? null,
    fipeModelMatched: match.fipeModelMatched ?? null,
  }
}

function checkedAtValue(value: Date | string | null | undefined): string {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString()
  if (typeof value !== 'string' || !value.trim()) return ''
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}
