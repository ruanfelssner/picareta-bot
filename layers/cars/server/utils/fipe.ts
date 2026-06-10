export type FipeApiConfig = {
  enabled: boolean
  baseUrl: string
  vehicleType: 'cars' | 'motorcycles' | 'trucks'
  subscriptionToken: string
  reference: number | null
  timeoutMs: number
}

type FipeBrand = { code: string; name: string }
type FipeModel = { code: string; name: string }
type FipeYear = { code: string; name: string }
type FipeReference = { code: string | number; month?: string }
type FipePriceResponse = {
  price?: string; brand?: string; model?: string; modelYear?: number
  fuel?: string; codeFipe?: string; referenceMonth?: string
}

export type FipeLookupInput = { brand: string; model: string; year: number }

export type FipeLookupResult =
  | { ok: true; data: { price: number | null; priceRaw: string | null; codeFipe: string | null; referenceMonth: string | null; modelYear: number | null; fuel: string | null; brandMatched: string; modelMatched: string } }
  | { ok: false; reason: string }

function parsePriceToCents(priceRaw: string | null | undefined): number | null {
  if (!priceRaw) return null
  const match = priceRaw.match(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i)
  if (!match) return null
  const normalized = match[1]!.replace(/\./g, '').replace(',', '.')
  const value = Number.parseFloat(normalized)
  return Number.isNaN(value) || value < 0 ? null : Math.round(value * 100)
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function normalizeLookupText(value: string): string {
  return value.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').replace(/\s+([,;])/g, '$1').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function tokenize(value: string): string[] {
  return normalizeForMatch(value).split(' ').map(t => t.trim()).filter(t => t.length >= 2 || t === 'T')
}

const TOKEN_ALIASES: Record<string, string[]> = {
  CL: ['COMF', 'COMFORT', 'COMFORTLINE'], COMF: ['CL', 'COMFORT', 'COMFORTLINE'],
  COMFORT: ['CL', 'COMF', 'COMFORTLINE'], COMFORTLINE: ['CL', 'COMF', 'COMFORT'],
  HL: ['HIGH', 'HIGHLINE'], HIGH: ['HL', 'HIGHLINE'], HIGHLINE: ['HL', 'HIGH'],
}

function buildTokenMatchScore(a: string, b: string): number {
  if (a === b) return 1
  const aA = TOKEN_ALIASES[a] ?? [], aB = TOKEN_ALIASES[b] ?? []
  if (aA.includes(b) || aB.includes(a)) return 0.9
  if (a.length >= 3 && b.length >= 3 && (b.startsWith(a) || a.startsWith(b))) return 0.72
  if (a.length >= 3 && b.length >= 3 && (b.includes(a) || a.includes(b))) return 0.45
  return 0
}

function buildStringSimilarityScore(targetRaw: string, candidateRaw: string): number {
  const target = normalizeForMatch(targetRaw)
  const candidate = normalizeForMatch(candidateRaw)
  if (!target || !candidate) return 0
  if (target === candidate) return 10_000
  if (candidate.startsWith(target)) return 8_000 - (candidate.length - target.length)
  if (candidate.includes(target)) return 7_000 - (candidate.length - target.length)
  if (target.startsWith(candidate)) return 6_000 - (target.length - candidate.length)
  const tTokens = tokenize(target), cTokens = tokenize(candidate)
  if (tTokens.length === 0 || cTokens.length === 0) return 0
  let common = 0, orderedHits = 0
  for (const [i, tok] of tTokens.entries()) {
    let best = 0
    for (const ct of cTokens) best = Math.max(best, buildTokenMatchScore(tok, ct))
    common += best
    const same = cTokens[i]
    if (same && buildTokenMatchScore(tok, same) >= 0.7) orderedHits++
  }
  const coverage = common / Math.max(1, tTokens.length)
  const precision = common / Math.max(1, cTokens.length)
  const compact = target.replace(/\s+/g, ''), compactC = candidate.replace(/\s+/g, '')
  const compactBonus = compact.length >= 3 && compactC.includes(compact) ? 0.15 : 0
  const orderedBonus = tTokens.length > 0 ? Math.min(0.18, (orderedHits / tTokens.length) * 0.18) : 0
  return Math.round((coverage * 0.78 + precision * 0.16 + compactBonus + orderedBonus) * 1_000)
}

function stripAuctionMetadata(value: string, year: number): string {
  let text = normalizeLookupText(value)
  text = text.replace(/\(([^)]*)\)/g, (full, inner: string) => {
    const n = normalizeForMatch(inner)
    if (!n) return ' '
    if (/^[A-Z]{2}$/.test(n)) return ' '
    if (/\b(?:REF|REFERENCIA|PLACA|CHASSI|RENAVAM|KM|PATIO|LOTE|LEILAO)\b/.test(n)) return ' '
    return full
  })
  const yr = '(?:19|20)\\d{2}'
  text = text.replace(new RegExp(`\\b${yr}\\s*/\\s*${yr}\\b`, 'gi'), ' ')
    .replace(/\bANO(?:\/MODELO|\s+MODELO)?\s*[:.-]?\s*(?:19|20)\d{2}(?:\s*\/\s*(?:19|20)\d{2})?/gi, ' ')
  if (Number.isFinite(year) && year > 0) text = text.replace(new RegExp(`\\b${escapeRegExp(String(Math.floor(year)))}\\b`, 'g'), ' ')
  text = text.replace(/\b(?:PLACA\s+FINAL|FINAL\s+(?:DE|DA)\s+PLACA|FINAL\s+PLACA|PLACA)\b.*$/i, ' ')
    .replace(/\b(?:REF\.?|REFERENCIA|REFERÊNCIA)\b.*$/i, ' ')
    .replace(/\b(?:CHASSI|RENAVAM|SINISTRO|SUCATA|DUT|IPVA|LICENCIAMENTO|ALIENACAO|ALIENAÇÃO|OBS\.?)\b.*$/i, ' ')
  return normalizeLookupText(text.replace(/\s*[,;]\s*$/g, ''))
}

function buildModelQueries(model: string, year: number): string[] {
  const raw = normalizeLookupText(model)
  const first = raw.split(/[;,]/, 1)[0] ?? ''
  const stripped = stripAuctionMetadata(raw, year)
  const strippedFirst = stripAuctionMetadata(first, year)
  const seen = new Set<string>()
  const out: string[] = []
  for (const q of [strippedFirst, stripped, first, raw]) {
    const key = normalizeForMatch(q)
    if (q && key && !seen.has(key)) { seen.add(key); out.push(q) }
  }
  return out
}

function rankByName<T extends { code: string; name: string }>(items: T[], query: string, limit = 5): Array<{ item: T; score: number }> {
  const nq = normalizeForMatch(query)
  if (!nq || items.length === 0) return []
  return items.map(item => ({ item, score: buildStringSimilarityScore(nq, item.name) }))
    .filter(e => e.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit))
}

function rankByNameAcrossQueries<T extends { code: string; name: string }>(items: T[], queries: string[], limit = 5): Array<{ item: T; score: number }> {
  const nqs = queries.map(q => normalizeForMatch(q)).filter(Boolean)
  if (nqs.length === 0 || items.length === 0) return []
  return items.map(item => ({ item, score: nqs.reduce((best, q) => Math.max(best, buildStringSimilarityScore(q, item.name)), 0) }))
    .filter(e => e.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit))
}

function pickYearCode(years: FipeYear[], year: number): FipeYear | null {
  if (!Number.isFinite(year) || year <= 0) return null
  const ys = String(Math.floor(year))
  const exact = years.find(y => String(y.code).startsWith(`${ys}-`))
  if (exact) return exact
  const byName = years.find(y => new RegExp(`\\b${escapeRegExp(ys)}\\b`).test(y.name))
  if (byName) return byName
  const sorted = [...years].map(y => { const cy = Number(String(y.code).split('-')[0]); return { item: y, distance: Number.isFinite(cy) ? Math.abs(cy - year) : Number.MAX_SAFE_INTEGER } }).sort((a, b) => a.distance - b.distance)
  const best = sorted[0]
  return best && best.distance <= 2 ? best.item : null
}

const brandCache = new Map<string, Promise<FipeBrand[]>>()
const modelCache = new Map<string, Promise<FipeModel[]>>()
const yearCache = new Map<string, Promise<FipeYear[]>>()
const referenceCache = new Map<string, Promise<number | null>>()

async function fipeFetch<T>(config: FipeApiConfig, url: string): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), config.timeoutMs)
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        ...(config.subscriptionToken ? { 'X-Subscription-Token': config.subscriptionToken, Authorization: `Bearer ${config.subscriptionToken}` } : {}),
      },
      signal: ac.signal,
    })
    const text = await res.text()
    let parsed: unknown = null
    try { parsed = text ? JSON.parse(text) : null } catch { throw new Error(`FIPE resposta inválida: ${text.slice(0, 120)}`) }
    if (!res.ok) {
      const msg = parsed && typeof parsed === 'object' && 'error' in parsed ? String((parsed as Record<string, unknown>).error) : `HTTP ${res.status}`
      throw new Error(`FIPE API: ${msg}`)
    }
    return parsed as T
  }
  finally { clearTimeout(timer) }
}

function withRef(url: string, ref: number | null): string {
  return ref != null ? `${url}${url.includes('?') ? '&' : '?'}reference=${ref}` : url
}

async function getBrands(config: FipeApiConfig): Promise<FipeBrand[]> {
  const key = `${config.vehicleType}|${config.reference ?? 'latest'}`
  return brandCache.get(key) ?? brandCache.set(key, fipeFetch<FipeBrand[]>(config, withRef(`${config.baseUrl}/${config.vehicleType}/brands`, config.reference))).get(key)!
}

async function getLatestReference(config: FipeApiConfig): Promise<number | null> {
  const key = `${config.baseUrl}|ref`
  return referenceCache.get(key) ?? referenceCache.set(key, fipeFetch<FipeReference[]>(config, `${config.baseUrl}/references`).then(refs => {
    if (!Array.isArray(refs)) return null
    for (const r of refs) { const n = Number(r?.code); if (Number.isFinite(n) && n > 0) return Math.floor(n) }
    return null
  })).get(key)!
}

async function resolveConfig(config: FipeApiConfig): Promise<FipeApiConfig> {
  if (config.reference != null) return config
  const reference = await getLatestReference(config)
  return reference != null ? { ...config, reference } : config
}

async function getModels(config: FipeApiConfig, brandCode: string): Promise<FipeModel[]> {
  const key = `${config.vehicleType}|${config.reference ?? 'latest'}|${brandCode}`
  return modelCache.get(key) ?? modelCache.set(key, fipeFetch<FipeModel[]>(config, withRef(`${config.baseUrl}/${config.vehicleType}/brands/${encodeURIComponent(brandCode)}/models`, config.reference))).get(key)!
}

async function getYears(config: FipeApiConfig, brandCode: string, modelCode: string): Promise<FipeYear[]> {
  const key = `${config.vehicleType}|${config.reference ?? 'latest'}|${brandCode}|${modelCode}`
  return yearCache.get(key) ?? yearCache.set(key, fipeFetch<FipeYear[]>(config, withRef(`${config.baseUrl}/${config.vehicleType}/brands/${encodeURIComponent(brandCode)}/models/${encodeURIComponent(modelCode)}/years`, config.reference))).get(key)!
}

export function getFipeConfigFromEnv(): FipeApiConfig {
  const baseUrl = (process.env.FIPE_API_BASE_URL ?? 'https://fipe.parallelum.com.br/api/v2').trim().replace(/\/$/, '')
  const vt = (process.env.FIPE_API_VEHICLE_TYPE ?? 'cars').trim().toLowerCase()
  const vehicleType: FipeApiConfig['vehicleType'] = vt === 'motorcycles' || vt === 'trucks' ? vt : 'cars'
  const subscriptionToken = (process.env.FIPE_API_TOKEN ?? process.env.X_SUBSCRIPTION_TOKEN ?? '').trim()
  const refVal = Number(process.env.FIPE_API_REFERENCE)
  const reference = Number.isFinite(refVal) && refVal > 0 ? Math.floor(refVal) : null
  const timeoutMs = Math.max(5_000, Number(process.env.FIPE_API_TIMEOUT_MS) || 15_000)
  const enabled = (process.env.FIPE_API_ENABLED ?? 'true').trim().toLowerCase() !== 'false'
  return { enabled, baseUrl, vehicleType, subscriptionToken, reference, timeoutMs }
}

export async function lookupFipe(config: FipeApiConfig, input: FipeLookupInput): Promise<FipeLookupResult> {
  if (!config.enabled) return { ok: false, reason: 'FIPE desabilitado' }
  const brandQuery = input.brand.trim()
  const modelQuery = input.model.trim()
  const year = Math.floor(input.year)
  if (!brandQuery || !modelQuery || !Number.isFinite(year) || year <= 0) return { ok: false, reason: 'Dados insuficientes' }

  try {
    const cfg = await resolveConfig(config)
    const brands = await getBrands(cfg)
    const brandMatch = rankByName(brands, brandQuery, 1)[0]
    if (!brandMatch || brandMatch.score < 560) return { ok: false, reason: `Marca não encontrada: "${brandQuery}"` }

    const models = await getModels(cfg, brandMatch.item.code)
    const modelQueries = buildModelQueries(modelQuery, year)
    const allQueries = [...modelQueries, ...modelQueries.map(q => `${brandQuery} ${q}`)]
    const ranked = rankByNameAcrossQueries(models, allQueries, 10)
    const bestModel = ranked[0]
    if (!bestModel || bestModel.score < 620) return { ok: false, reason: `Modelo não encontrado: "${modelQuery}"` }

    const candidates = ranked.filter(e => e.score >= Math.max(620, bestModel.score - 250)).slice(0, 8)
    let modelMatch = bestModel.item
    let years = await getYears(cfg, brandMatch.item.code, modelMatch.code)
    let yearMatch = pickYearCode(years, year)

    if (!yearMatch) {
      for (const c of candidates) {
        if (c.item.code === modelMatch.code) continue
        const cy = await getYears(cfg, brandMatch.item.code, c.item.code)
        const cy2 = pickYearCode(cy, year)
        if (!cy2) continue
        modelMatch = c.item; years = cy; yearMatch = cy2; break
      }
    }
    if (!yearMatch) return { ok: false, reason: `Ano não encontrado: ${year}` }

    const detail = await fipeFetch<FipePriceResponse>(cfg,
      withRef(`${cfg.baseUrl}/${cfg.vehicleType}/brands/${encodeURIComponent(brandMatch.item.code)}/models/${encodeURIComponent(modelMatch.code)}/years/${encodeURIComponent(yearMatch.code)}`, cfg.reference))

    const priceRaw = typeof detail.price === 'string' ? detail.price.trim() : null
    const cents = parsePriceToCents(priceRaw)
    const price = cents != null ? Math.round(cents / 100) : null

    return {
      ok: true,
      data: {
        price, priceRaw,
        codeFipe: typeof detail.codeFipe === 'string' ? detail.codeFipe.trim() : null,
        referenceMonth: typeof detail.referenceMonth === 'string' ? detail.referenceMonth.trim() : null,
        modelYear: typeof detail.modelYear === 'number' && Number.isFinite(detail.modelYear) ? detail.modelYear : null,
        fuel: typeof detail.fuel === 'string' ? detail.fuel.trim() : null,
        brandMatched: brandMatch.item.name,
        modelMatched: modelMatch.name,
      },
    }
  }
  catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
