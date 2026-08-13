import { classifyDamage } from '#shared/utils/damage'
import type { DamageBucket } from '#shared/utils/damage'

export { classifyDamage }
export type { DamageBucket }

const DAMAGE_LABELS: Record<DamageBucket, string> = {
  pequena: 'Pequena monta',
  media: 'Média monta',
  grande: 'Grande monta / perda',
  sem_monta: 'Sem monta',
  sem_info: 'Sem informação',
  outros: 'Outros',
}

export function damageLabel(bucket: DamageBucket): string {
  return DAMAGE_LABELS[bucket]
}

export function normalizeBrand(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toUpperCase() || 'DESCONHECIDA'
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((a, b) => a + b, 0) / values.length
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export const PCT_BANDS = ['<40%', '40-45%', '45-50%', '50-55%', '55-60%', '60-65%', '65-70%', '70-75%', '75-80%', '>80%'] as const

export function pctBand(pct: number): string {
  if (pct < 40) return '<40%'
  if (pct < 45) return '40-45%'
  if (pct < 50) return '45-50%'
  if (pct < 55) return '50-55%'
  if (pct < 60) return '55-60%'
  if (pct < 65) return '60-65%'
  if (pct < 70) return '65-70%'
  if (pct < 75) return '70-75%'
  if (pct < 80) return '75-80%'
  return '>80%'
}

export const MIN_OUTCOME_SAMPLE = 30
export const MIN_SEGMENT_SAMPLE = 10

export type OpportunityLevel = 'alta' | 'media' | 'baixa' | 'insuficiente'

export function classifyOpportunity(n: number, conditionalMean: number | null, diff: number | null): OpportunityLevel {
  if (n < MIN_SEGMENT_SAMPLE) return 'insuficiente'
  if (n >= MIN_OUTCOME_SAMPLE && conditionalMean != null && conditionalMean <= 60 && diff != null && diff >= 8) return 'alta'
  if (n >= MIN_SEGMENT_SAMPLE && n < MIN_OUTCOME_SAMPLE && conditionalMean != null && conditionalMean <= 65 && diff != null && diff >= 4) return 'media'
  return 'baixa'
}
