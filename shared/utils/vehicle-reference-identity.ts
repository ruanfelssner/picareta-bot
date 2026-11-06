export type ReferenceIdentityInput = {
  brand: string | null
  model: string | null
  version?: string | null
  title?: string | null
  description?: string | null
  fuel?: string | null
  fipeFuel?: string | null
  fipeModelMatched?: string | null
}

export const referenceToken = (value: string | null | undefined): string => String(value ?? '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

const TRIMS = /\b(?:ACTIVE|COMFORTLINE|HIGHLINE|TRENDLINE|MSI|TSI|TFSI|MPI|TURBO|LTZ?|LS|XEI|XLI|GLI|GLX|GLS|EXL?|LX|ELX|SE|SEL|XRE|XRX|PREMIER|PREMIUM|EXPRESSION|DYNAMIQUE|AUTHENTIQUE|LIFE|ZEN|INTENSE|DRIVE|ATTRACTIVE|VIVACE|ECONOMY|CITY|TITAN|POWER|RALLYE|GTI|GT|TREND|TOTAL|FLEX|MI|AT|MT|CVT|AUTOMATICO|MANUAL|\d+\s+\d+|\d+[VP])\b/
const NOISE = /\b(?:TOTAL|FLEX|GASOLINA|ALCOOL|DIESEL|MI|MPI|MSI|TSI|TFSI|TWIN|TURBO|AUTOMATICO|MANUAL|AT|MT|CVT|\d+\s+\d+|\d+[VP]|NOVO|G[1-9]|\d{4})\b/g

export function vehicleReferenceIdentity(input: ReferenceIdentityInput) {
  const brand = referenceToken(input.brand).replace(/^(?:IMP|IMPORTADO) /, '')
  const rawModel = String(input.model ?? '').replace(new RegExp(`^(?:${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|VW|GM)\\s+`, 'i'), '')
  const model = referenceToken(rawModel)
  const details = [rawModel, input.version, input.fipeModelMatched].filter(Boolean).join(' ')
  // Descrição de veículo antes de localização, mensagens e dados do pregão.
  const fallback = [input.title, input.description?.split(/\|| - PL|Categoria:|Bem encontra-se:/i)[0]].filter(Boolean).join(' ')
  const text = [details, fallback].filter(Boolean).join(' ')
  const normalized = referenceToken(text)
  const engineOf = (value: string) => value.match(/\b([1-6])[.,\s]([0-9])\b/)?.slice(1).join('.') ?? null
  const engines = new Set([...details.matchAll(/\b([1-6])[.,\s]([0-9])\b/g)].map(match => `${match[1]}.${match[2]}`))
  const engine = engineOf(details) ?? engineOf(fallback)
  const variant = referenceToken([model, input.version, input.fipeModelMatched, fallback].join(' ')).match(/\b(3\d{2})\s*(IA|I|E|D)\b/)
  let family = model.split(TRIMS)[0]?.trim() || model
  if (/\bBMW\b/.test(brand)) {
    family = variant ? `${variant[1]}${variant[2] === 'IA' ? 'I' : variant[2]}`
      : /^(?:320|SERIE 3|SERIES 3|3 SERIES)$/.test(model) ? '320I' : family
  }
  const fuelText = referenceToken(input.fuel ?? input.fipeFuel) || normalized
  const fuel = /\bFLEX\b|GAS(?:OLINA)?\s+(?:E\s+)?ALC(?:OOL)?|ALC(?:OOL)?\s+GAS/.test(fuelText) ? 'FLEX'
    : /\bDIESEL\b/.test(fuelText) ? 'DIESEL' : /\bGASOLINA\b/.test(fuelText) ? 'GASOLINA'
      : /\bALCOOL\b/.test(fuelText) ? 'ALCOOL' : /\bELETRIC[OA]\b/.test(fuelText) ? 'ELETRICO' : null
  const transmission = /\b(?:AUTOMATIC[OA]|AT|CVT|DSG|TIPTRONIC|TIP|I MOTION|IMOTION)\b/.test(normalized) ? 'AUTOMATICO'
    : /\b(?:MANUAL|MT)\b/.test(normalized) ? 'MANUAL' : null
  const generation = normalized.match(/\bG([1-9])\b/)?.[0] ?? (/\bNOVO\b/.test(normalized) ? 'NOVO' : null)
  const doors = normalized.match(/\b([245])\s*P\b/)?.[1] ?? null
  const valves = normalized.match(/\b(8|12|16|20|24)\s*V\b/)?.[1] ?? null
  const body = normalized.match(/\b(?:SEDAN|HATCH|CABRIOLET|COUPE|GRAN TURISMO)\b/)?.[0] ?? null
  const trimText = referenceToken([rawModel, input.version, input.fipeModelMatched].filter(Boolean).join(' '))
    .split(family).join(' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim()
  const trims = [...new Set(trimText.split(' ').filter(part => /^[A-Z][A-Z0-9]+$/.test(part) && part !== 'BMW' && part !== 'SERIE'))].sort()
  const numbers = [...new Set(referenceToken(details.replace(/\b[1-6][.,\s][0-9]\b/g, ' ')).split(' ')
    .filter(part => /^\d+$/.test(part) && !/^(?:[245]|8|12|16|20|24|(?:19|20)\d{2})$/.test(part)))].sort()
  return { family, engine, fuel, transmission, generation, doors, valves, body, trims, numbers, conflicted: engines.size > 1
    || (/\b(?:AUTOMATIC[OA]|AT|CVT|DSG|TIPTRONIC)\b/.test(normalized) && /\b(?:MANUAL|MT)\b/.test(normalized))
    || new Set([...normalized.matchAll(/\b([245])\s*P\b/g)].map(match => match[1])).size > 1
    || new Set([...normalized.matchAll(/\bG([1-9])\b/g)].map(match => match[1])).size > 1
    || (/\bDIESEL\b/.test(normalized) && /\b(?:FLEX|GASOLINA|ALCOOL)\b/.test(normalized)) }
}

export function referenceCompatibility(target: ReferenceIdentityInput, candidate: ReferenceIdentityInput): number {
  const a = vehicleReferenceIdentity(target), b = vehicleReferenceIdentity(candidate)
  if (!a.family || a.family !== b.family || a.conflicted || b.conflicted) return 0
  let score = 100
  for (const key of ['engine', 'fuel', 'transmission', 'generation', 'doors', 'valves', 'body'] as const) {
    if (a[key] && b[key] && a[key] !== b[key]) return 0
    if (a[key] && !b[key]) score -= key === 'engine' ? 25 : 8
    if (!a[key] && b[key]) score -= 2
  }
  if (a.numbers.length && b.numbers.length && a.numbers.join(' ') !== b.numbers.join(' ')) return 0
  if (a.trims.length && b.trims.length && a.trims.some(trim => !b.trims.includes(trim))) return 0
  const distinctive = ['CITY', 'TITAN', 'POWER', 'RALLYE', 'GTI', 'CROSS', 'SPORT', 'MOTION']
  if (a.trims.some(trim => distinctive.includes(trim)) && b.trims.some(trim => distinctive.includes(trim))
    && !a.trims.some(trim => distinctive.includes(trim) && b.trims.includes(trim))) return 0
  for (const trim of a.trims) if (!b.trims.includes(trim)) score -= 6
  for (const trim of b.trims) if (!a.trims.includes(trim)) score -= 3
  return Math.max(1, score)
}
