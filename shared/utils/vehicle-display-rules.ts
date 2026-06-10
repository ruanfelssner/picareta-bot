import type { AuctionComboRule } from '#shared/types/filters'
import type { VehicleRecord } from '#shared/types/vehicle'

export interface VehicleDisplayRuleMatch {
  index: number
  mode: 'include' | 'exclude'
  label: string
}

export interface VehicleDisplayRuleEvaluation {
  passes: boolean
  activeRuleCount: number
  includeRuleCount: number
  excludeRuleCount: number
  matchedIncludes: VehicleDisplayRuleMatch[]
  matchedExcludes: VehicleDisplayRuleMatch[]
  reasons: string[]
}

function normalizeForRule(value: string | number | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function containsRuleTerm(haystack: string, needle: string | null): boolean {
  const normalizedNeedle = normalizeForRule(needle)
  if (!normalizedNeedle) return true

  return ` ${haystack} `.includes(` ${normalizedNeedle} `)
}

function hasRuleFields(rule: AuctionComboRule): boolean {
  return Boolean(
    normalizeForRule(rule.brand).length > 0
    || normalizeForRule(rule.model).length > 0
    || normalizeForRule(rule.text).length > 0
    || rule.minYear != null,
  )
}

function formatRuleLabel(rule: AuctionComboRule): string {
  const pieces: string[] = []

  if (normalizeForRule(rule.brand)) pieces.push(`marca ${rule.brand}`)
  if (normalizeForRule(rule.model)) pieces.push(`modelo ${rule.model}`)
  if (normalizeForRule(rule.text)) pieces.push(`texto "${rule.text}"`)
  if (rule.minYear != null) pieces.push(`ano >= ${rule.minYear}`)

  return pieces.join(' + ') || 'regra sem campos'
}

function buildVehicleRuleText(vehicle: VehicleRecord) {
  const titleText = normalizeForRule([
    vehicle.brand,
    vehicle.model,
    vehicle.title,
    vehicle.description,
  ].join(' '))

  return {
    brand: normalizeForRule([vehicle.brand, vehicle.title].join(' ')),
    model: normalizeForRule([vehicle.model, vehicle.title].join(' ')),
    text: titleText,
  }
}

function ruleMatchesVehicle(rule: AuctionComboRule, vehicle: VehicleRecord): boolean {
  if (!hasRuleFields(rule)) return false

  const vehicleText = buildVehicleRuleText(vehicle)
  const brandMatches = containsRuleTerm(vehicleText.brand, rule.brand)
  const modelMatches = containsRuleTerm(vehicleText.model, rule.model)
  const textMatches = containsRuleTerm(vehicleText.text, rule.text)
  const yearMatches = rule.minYear == null || (vehicle.year != null && vehicle.year >= rule.minYear)

  return brandMatches && modelMatches && textMatches && yearMatches
}

function toMatch(rule: AuctionComboRule, index: number): VehicleDisplayRuleMatch {
  return {
    index,
    mode: rule.mode,
    label: formatRuleLabel(rule),
  }
}

export function evaluateVehicleDisplayRules(
  vehicle: VehicleRecord,
  rules: AuctionComboRule[],
): VehicleDisplayRuleEvaluation {
  const activeRules = rules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled && hasRuleFields(rule))

  const includeRules = activeRules.filter(({ rule }) => rule.mode === 'include')
  const excludeRules = activeRules.filter(({ rule }) => rule.mode === 'exclude')

  const matchedIncludes = includeRules
    .filter(({ rule }) => ruleMatchesVehicle(rule, vehicle))
    .map(({ rule, index }) => toMatch(rule, index))

  const matchedExcludes = excludeRules
    .filter(({ rule }) => ruleMatchesVehicle(rule, vehicle))
    .map(({ rule, index }) => toMatch(rule, index))

  const base = {
    activeRuleCount: activeRules.length,
    includeRuleCount: includeRules.length,
    excludeRuleCount: excludeRules.length,
    matchedIncludes,
    matchedExcludes,
  }

  if (activeRules.length === 0) {
    return {
      ...base,
      passes: true,
      reasons: ['Exibido porque não há regras de exibição ativas.'],
    }
  }

  if (matchedExcludes.length > 0) {
    const first = matchedExcludes[0]!
    return {
      ...base,
      passes: false,
      reasons: [
        `Oculto pela regra de exclusão #${first.index + 1}: ${first.label}.`,
        includeRules.length > 0
          ? 'Regras de exclusão removem o veículo mesmo quando alguma inclusão também casa.'
          : 'Não há regra de inclusão ativa; tudo passa, exceto o que casa com exclusão.',
      ],
    }
  }

  if (includeRules.length > 0) {
    if (matchedIncludes.length > 0) {
      const first = matchedIncludes[0]!
      return {
        ...base,
        passes: true,
        reasons: [
          `Exibido pela regra de inclusão #${first.index + 1}: ${first.label}.`,
          'Nenhuma regra de exclusão ativa casou.',
        ],
      }
    }

    return {
      ...base,
      passes: false,
      reasons: [
        'Oculto porque não casou com nenhuma regra de inclusão ativa.',
        `${includeRules.length} regra(s) de inclusão ativa(s) definem o que aparece.`,
      ],
    }
  }

  return {
    ...base,
    passes: true,
    reasons: ['Exibido porque nenhuma regra de exclusão ativa casou.'],
  }
}
