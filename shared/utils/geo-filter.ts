const BRAZIL_STATE_ALIASES: Record<string, string> = {
  AC: 'AC', ACRE: 'AC', AL: 'AL', ALAGOAS: 'AL', AM: 'AM', AMAZONAS: 'AM',
  AP: 'AP', AMAPA: 'AP', BA: 'BA', BAHIA: 'BA', CE: 'CE', CEARA: 'CE',
  DF: 'DF', 'DISTRITO FEDERAL': 'DF', ES: 'ES', 'ESPIRITO SANTO': 'ES',
  GO: 'GO', GOIAS: 'GO', MA: 'MA', MARANHAO: 'MA', MG: 'MG', 'MINAS GERAIS': 'MG',
  MS: 'MS', 'MATO GROSSO DO SUL': 'MS', MT: 'MT', 'MATO GROSSO': 'MT',
  PA: 'PA', PARA: 'PA', PB: 'PB', PARAIBA: 'PB', PE: 'PE', PERNAMBUCO: 'PE',
  PI: 'PI', PIAUI: 'PI', PR: 'PR', PARANA: 'PR', RJ: 'RJ', 'RIO DE JANEIRO': 'RJ',
  RN: 'RN', 'RIO GRANDE DO NORTE': 'RN', RO: 'RO', RONDONIA: 'RO', RR: 'RR', RORAIMA: 'RR',
  RS: 'RS', 'RIO GRANDE DO SUL': 'RS', SC: 'SC', 'SANTA CATARINA': 'SC',
  SE: 'SE', SERGIPE: 'SE', SP: 'SP', 'SAO PAULO': 'SP', TO: 'TO', TOCANTINS: 'TO',
}

const STATE_MAIN_NAME_BY_CODE = Object.entries(BRAZIL_STATE_ALIASES).reduce<Record<string, string>>(
  (acc, [name, code]) => {
    if (name.length > 2 && !acc[code]) acc[code] = name
    return acc
  },
  {},
)

interface GeoFilterVehicleShape {
  source?: string | null
  state?: string | null
  city?: string | null
  yard?: string | null
  location?: string | null
  description?: string | null
  url?: string | null
}

function normalizeToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasBoundaryTerm(haystackNormalized: string, termNormalized: string): boolean {
  if (!termNormalized) return false
  const pattern = termNormalized.split(' ').filter(Boolean).map(escapeRegExp).join(' ')
  if (!pattern) return false
  return new RegExp(`(?:^| )${pattern}(?= |$)`).test(haystackNormalized)
}

function hasStateTerm(haystackNormalized: string, stateCode: string): boolean {
  const code = escapeRegExp(stateCode)
  return new RegExp(`(?:^| )${code}\\d*(?= |$)`).test(haystackNormalized)
}

export function normalizeBrazilState(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizeToken(value)
  if (!normalized) return null
  return BRAZIL_STATE_ALIASES[normalized] ?? null
}

export function sanitizeStateList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const state = normalizeBrazilState(raw)
    if (!state || seen.has(state)) continue
    seen.add(state)
    out.push(state)
  }
  return out
}

export function sanitizeCityList(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (typeof raw !== 'string') continue
    const city = raw.trim()
    if (!city) continue
    const key = normalizeToken(city)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(city)
  }
  return out
}

function buildVehicleLocationHaystack(vehicle: GeoFilterVehicleShape): string {
  const parts = [vehicle.state, vehicle.city, vehicle.yard, vehicle.location, vehicle.description, vehicle.url].filter(
    (value): value is string => typeof value === 'string' && value.trim().length > 0,
  )
  if (vehicle.source === 'favareto') parts.push('Curitiba PR')
  return normalizeToken(parts.join(' '))
}

export function matchesGeoFilters(
  vehicle: GeoFilterVehicleShape,
  filters: { states?: string[] | null; cities?: string[] | null },
): boolean {
  const states = sanitizeStateList(filters.states ?? [])
  const cities = sanitizeCityList(filters.cities ?? [])
  if (states.length === 0 && cities.length === 0) return true

  const haystack = buildVehicleLocationHaystack(vehicle)
  if (!haystack) return false

  if (states.length > 0) {
    const hasState = states.some((stateCode) => {
      const stateName = STATE_MAIN_NAME_BY_CODE[stateCode] ?? ''
      return (
        hasStateTerm(haystack, stateCode) ||
        (stateName ? hasBoundaryTerm(haystack, stateName) : false)
      )
    })
    if (!hasState) return false
  }

  if (cities.length > 0) {
    const hasCity = cities.some((city) => hasBoundaryTerm(haystack, normalizeToken(city)))
    if (!hasCity) return false
  }

  return true
}
