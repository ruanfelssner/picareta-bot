import { areVehicleBrandsCompatible } from './sodre-live-identity'

export type LiveAssistantFipeCandidate = {
  id: string
  brand: string | null
  model: string | null
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
  year: number | null
  fuel?: string | null
}

const token = (value: string | null | undefined) => String(value ?? '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toUpperCase()
  .replace(/[^A-Z0-9]+/g, ' ')
  .trim()

// A versão pode estar abreviada, mas família, números do modelo e ano são
// obrigatórios. O critério é o mesmo usado pelas oportunidades do Picareta.
function similarity(target: string, candidate: string): number {
  if (target === candidate) return 100
  const targetParts = target.split(' ')
  const candidateParts = candidate.split(' ')
  if (targetParts[0] !== candidateParts[0]) return 0

  const targetNumbers = targetParts.filter(part => /\d/.test(part))
  const candidateNumbers = candidateParts.filter(part => /\d/.test(part))
  if (targetNumbers.length && candidateNumbers.length && targetNumbers.join(' ') !== candidateNumbers.join(' ')) return 0

  const common = targetParts.filter(part => candidateParts.includes(part)).length
  const score = common / Math.max(targetParts.length, candidateParts.length)
  return score >= 0.5 ? score * 90 : 0
}

export function selectLiveAssistantFipeReference(
  target: LiveAssistantFipeTarget,
  records: LiveAssistantFipeCandidate[],
): LiveAssistantFipeReference | null {
  const targetModel = token(target.model)
  if (!target.brand || !targetModel || !target.year) return null

  const candidates = records
    .filter(record => record.id !== target.id
      && record.year === target.year
      && record.fipe != null
      && Number.isFinite(record.fipe)
      && record.fipe > 0
      && record.brand != null
      && areVehicleBrandsCompatible(target.brand, record.brand)
      && (!target.fuel || !record.fuel || token(target.fuel) === token(record.fuel)))
    .map(record => ({ record, score: similarity(targetModel, token(record.model)) }))
    .filter(candidate => candidate.score > 0)
    .sort((first, second) => second.score - first.score
      || (first.score < 100 ? (first.record.fipe ?? 0) - (second.record.fipe ?? 0) : 0)
      || checkedAtValue(second.record.checkedAt).localeCompare(checkedAtValue(first.record.checkedAt))
      || first.record.id.localeCompare(second.record.id))

  const match = candidates[0]?.record
  if (!match?.brand || !match.model || match.fipe == null || match.year == null) return null

  return {
    vehicleId: match.id,
    brand: match.brand,
    model: match.model,
    year: match.year,
    value: match.fipe,
    checkedAt: checkedAtValue(match.checkedAt) || null,
    label: 'Referência não exata',
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
