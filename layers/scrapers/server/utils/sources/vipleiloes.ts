import { load } from 'cheerio'
import { resolve } from 'node:path'
import { chromium, type Page } from 'playwright'
import type { AuctionFilters } from '#shared/types/filters'
import type { VehicleRecord } from '#shared/types/vehicle'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperOptions, type ScraperSource } from '../source-types'
import { buildPlaywrightLaunchOptions } from '../playwright-launch'

const BASE_URL = 'https://www.vipleiloes.com.br'
const START_URL_FALLBACKS = [`${BASE_URL}/Veiculos/Home`, `${BASE_URL}/veiculos/home`, `${BASE_URL}/?lang=en`]
const DEFAULT_REQUEST_DELAY_MS = 3_000
const DEFAULT_MAX_PAGES = 40
const HARD_MAX_PAGES = 160
const DEFAULT_PROFILE_PATH = 'data/vipleiloes-profile'
const AJAX_MAX_ATTEMPTS = 3
const AJAX_RATE_LIMIT_BASE_DELAY_MS = 5_000

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

const IMAGE_URL_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-url'] as const
const IMAGE_SRCSET_ATTRS = ['srcset', 'data-srcset'] as const
const BRAZIL_STATE_CODES = new Set([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
])

type SearchFragmentParseResult = { vehicles: RawScrapedVehicle[]; nextAjaxUrl: string | null; currentPage: number | null; totalResults: number | null }
type PartialFetchResult = { ok: boolean; status: number; requestUrl: string; html: string; error?: string }
type ImageAttrReader = (attr: string) => string | undefined
type VipClassification = { name: string; damage: string }

const DEFAULT_CLASSIFICATIONS: VipClassification[] = [
  { name: 'Usados', damage: 'usado' },
  { name: 'Seminovos', damage: 'seminovo' },
  { name: 'Sinistrados', damage: 'sinistrado' },
]

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Scraping cancelado.'))
      return
    }

    const timeout = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timeout)
      reject(new Error('Scraping cancelado.'))
    }, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error('Scraping cancelado.')
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

function cleanVipVehicleTitle(raw: string | null | undefined): string {
  return normalizeSpace(raw)
    .replace(/FINANCIE\s+J[AÁÀÂÃ]/giu, ' ')
    .replace(/ABERTO\s+PARA\s+LANCES/giu, ' ')
    .replace(/(?:^|\s)[|·:–—-]+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeText(raw: string | null | undefined): string {
  return normalizeSpace(raw).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

function normalizeUpperText(raw: string | null | undefined): string {
  return normalizeSpace(raw)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
}

function isVipNetworkFailure(result: PartialFetchResult): boolean {
  if (result.ok || result.status !== 0) return false
  const error = normalizeText(result.error)
  return /network|failedtofetch|fetchfailed|internetdisconnected|namenotresolved|connection|socket|econn|etimedout/.test(error)
}

function stopVipOnNetworkFailure(
  result: PartialFetchResult,
  classification: VipClassification,
  vehicles: RawScrapedVehicle[],
  log: (msg: string) => void,
): void {
  if (!isVipNetworkFailure(result)) return

  const reason = normalizeSpace(result.error) || 'network error'
  const message = `[vipleiloes][${classification.name}] Falha de rede (${reason}). Encerrando o scraping da VIP.`
  log(message)
  if (vehicles.length > 0) {
    throw new PartialScraperResultError(`${message} Resultado parcial preservado.`, vehicles)
  }
  throw new Error(message)
}

function buildSearchHandlerPath(classification: VipClassification): string {
  return `/pesquisa?classificacao=${encodeURIComponent(classification.name)}&handler=pesquisar`
}

function buildSearchPageHandlerPath(classification: VipClassification, pageNumber: number): string {
  const params = new URLSearchParams({
    SortOrder: 'DataInicio',
    pageNumber: String(pageNumber),
    handler: 'pesquisar',
    classificacao: classification.name,
  })
  return `/pesquisa?${params.toString()}`
}

function buildStartUrl(classification: VipClassification): string {
  return `${BASE_URL}/pesquisa?classificacao=${encodeURIComponent(classification.name)}`
}

function ensureClassificationQuery(urlLike: string, classification: VipClassification): string {
  const trimmed = normalizeSpace(urlLike)
  if (!trimmed) return buildSearchHandlerPath(classification)
  try {
    const url = new URL(trimmed, BASE_URL)
    url.searchParams.set('classificacao', classification.name)
    if (!url.searchParams.has('handler')) url.searchParams.set('handler', 'pesquisar')
    return `${url.pathname}${url.search}`
  }
  catch { return buildSearchHandlerPath(classification) }
}

function parsePageNumberFromUrl(urlLike: string): number | null {
  try {
    const parsed = new URL(urlLike, BASE_URL)
    const pageNumber = Number.parseInt(parsed.searchParams.get('pageNumber') ?? '', 10)
    return Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null
  }
  catch {
    return null
  }
}

function isPaginationResetResponse(parsed: SearchFragmentParseResult, requestedPage: number | null): boolean {
  return requestedPage != null && requestedPage > 1 && parsed.currentPage != null && parsed.currentPage < requestedPage
}

function parseMaxPagesFromEnv(): number {
  const raw = Number.parseInt((process.env.VIPLEILOES_MAX_PAGES ?? '').trim(), 10)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PAGES
  return Math.max(1, Math.min(HARD_MAX_PAGES, raw))
}

function parseRequestDelayFromEnv(): number {
  const raw = Number.parseInt((process.env.VIPLEILOES_REQUEST_DELAY_MS ?? '').trim(), 10)
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_REQUEST_DELAY_MS
  return Math.min(10_000, raw)
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  const value = normalizeText(raw)
  if (!value) return fallback
  if (['1', 'true', 'yes', 'sim'].includes(value)) return true
  if (['0', 'false', 'no', 'nao'].includes(value)) return false
  return fallback
}

function getHeadless(defaultHeadless: boolean): boolean {
  return parseBooleanEnv(process.env.VIPLEILOES_HEADLESS ?? process.env.HEADLESS, defaultHeadless)
}

function getProfilePath(): string {
  return resolve(process.cwd(), process.env.VIPLEILOES_PROFILE_PATH?.trim() || DEFAULT_PROFILE_PATH)
}

function parseClassificationsFromEnv(log: (msg: string) => void): VipClassification[] {
  const raw = normalizeSpace(process.env.VIPLEILOES_CLASSIFICATIONS)
  if (!raw) return DEFAULT_CLASSIFICATIONS

  const byName = new Map(DEFAULT_CLASSIFICATIONS.map((item) => [normalizeText(item.name), item]))
  const selected: VipClassification[] = []
  const seen = new Set<string>()

  for (const item of raw.split(',')) {
    const key = normalizeText(item)
    const classification = byName.get(key)
    if (!classification || seen.has(key)) continue
    selected.push(classification)
    seen.add(key)
  }

  if (selected.length === 0) {
    log(`[vipleiloes] VIPLEILOES_CLASSIFICATIONS sem classificações válidas; usando padrão.`)
    return DEFAULT_CLASSIFICATIONS
  }

  return selected
}

function toAbsoluteUrl(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  if (text.startsWith('http://') || text.startsWith('https://')) return text
  if (text.startsWith('//')) return `https:${text}`
  if (text.startsWith('/')) return `${BASE_URL}${text}`
  return `${BASE_URL}/${text}`
}

function extractFirstSrcsetUrl(raw: string | null | undefined): string {
  const text = normalizeSpace(raw)
  if (!text) return ''
  return normalizeSpace(text.split(',')[0]?.split(/\s+/)[0] ?? '')
}

function extractCssBackgroundUrl(raw: string | null | undefined): string {
  const match = (raw ?? '').match(/url\((['"]?)(.*?)\1\)/i)
  return normalizeSpace(match?.[2] ?? '')
}

function isUsableImageUrl(raw: string): boolean {
  const text = normalizeSpace(raw)
  if (!text || text.startsWith('data:') || /^(?:#|javascript:)/i.test(text)) return false
  return !/^(?:about:blank|blank)$/i.test(text)
}

function extractImageUrlFromAttrs(readAttr: ImageAttrReader): string {
  const candidates: string[] = []
  for (const attr of IMAGE_URL_ATTRS) candidates.push(readAttr(attr) ?? '')
  for (const attr of IMAGE_SRCSET_ATTRS) candidates.push(extractFirstSrcsetUrl(readAttr(attr)))
  candidates.push(extractCssBackgroundUrl(readAttr('style')))
  const picked = candidates.find(isUsableImageUrl) ?? ''
  return picked ? toAbsoluteUrl(picked) : ''
}

function pickFirstImageUrl(...readers: ImageAttrReader[]): string {
  for (const readAttr of readers) {
    const url = extractImageUrlFromAttrs(readAttr)
    if (url) return url
  }
  return ''
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const text = normalizeSpace(raw)
  const match = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i)
  if (!match) return { price: null, priceRaw: null }
  const numericText = match[1]!
  const parsed = Number.parseFloat(numericText.replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(parsed) || parsed <= 0) return { price: null, priceRaw: `R$ ${numericText}` }
  return { price: Math.round(parsed), priceRaw: `R$ ${numericText}` }
}

function parseYear(raw: string): number | null {
  const match = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:\d{2,4})\b/)
  if (match) return Number.parseInt(match[1]!, 10)
  const years = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)]
  if (years.length === 0) return null
  const parsed = Number.parseInt(years[0]?.[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseKm(raw: string): string | null {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return null
  const parsed = Number.parseInt(digits, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return parsed.toLocaleString('pt-BR')
}

function parseDatePtBr(dateRaw: string, hourRaw: string): Date | null {
  const dateText = normalizeSpace(dateRaw).replace(/^in[ií]cio:\s*/i, '')
  const hourText = normalizeSpace(hourRaw)
  const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!dateMatch) return null
  const d = Number.parseInt(dateMatch[1]!, 10), m = Number.parseInt(dateMatch[2]!, 10), y = Number.parseInt(dateMatch[3]!, 10)
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return null
  const hourMatch = hourText.match(/(\d{2}):(\d{2})/)
  const hour = hourMatch ? Number.parseInt(hourMatch[1]!, 10) : 0
  const minute = hourMatch ? Number.parseInt(hourMatch[2]!, 10) : 0
  const parsed = new Date(y, m - 1, d, hour, minute, 0, 0)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function looksLikeVehicleListingText(raw: string): boolean {
  const text = normalizeSpace(raw)
  if (!text) return false
  const hasYear = /\b(?:19|20)\d{2}\s*\/\s*(?:19|20)?\d{2}\b/.test(text)
  const hasListingHints = /valor atual|local:|r\$\s*[\d.]+(?:,\d+)?|km\b/i.test(text)
  const looksLikeAgenda = /vendedor\(es\):|leiloeiro:|lotes?\s+online/i.test(text)
  return hasYear && hasListingHints && !looksLikeAgenda
}

function parseDateTimeFromText(raw: string): Date | null {
  const text = normalizeSpace(raw)
  const match = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/)
  if (!match) return null
  return parseDatePtBr(match[1]!, match[2]!)
}

function extractDetailField(raw: string, labels: string[]): string | null {
  const text = normalizeSpace(raw)
  if (!text) return null
  const escapedLabels = labels.map(label => label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
  const nextLabels = [
    'Ve[ií]culo', 'Ano', 'Cor', 'Combust[ií]vel', 'KM', 'Quilometragem',
    'Funcionando na Entrada', 'Proced[eê]ncia', 'Localiza[cç][aã]o', 'Local',
    'Final da placa', 'Comitente', 'Chave', 'C[aâ]mbio', 'Oferta Inicial',
    'Valor Atual', 'Valor inicial', 'Lance Inicial', 'Detalhes do Lote', 'Lote',
    'In[ií]cio', 'Data do Leil[aã]o', 'Data do Evento',
  ].join('|')
  const match = text.match(new RegExp(`(?:${escapedLabels})\\s*[:,]?\\s*(.+?)(?=\\s+(?:${nextLabels})\\s*[:,]?|$)`, 'i'))
  return normalizeSpace(match?.[1] ?? '') || null
}

function parseDetailPrice(raw: string): { price: number | null; priceRaw: string | null } {
  const text = normalizeSpace(raw)
  const patterns = [
    /Valor Atual\s*:?[\s\S]{0,80}?R\$\s*[\d.]+(?:,\d{1,2})?/i,
    /Oferta Inicial\s*:?[\s\S]{0,80}?R\$\s*[\d.]+(?:,\d{1,2})?/i,
    /Valor inicial\s*:?[\s\S]{0,80}?R\$\s*[\d.]+(?:,\d{1,2})?/i,
    /Lance Inicial\s*:?[\s\S]{0,80}?R\$\s*[\d.]+(?:,\d{1,2})?/i,
  ]
  const match = patterns.map(pattern => text.match(pattern)?.[0] ?? '').find(Boolean) ?? ''
  return parsePrice(match)
}

function parseDetailAuctionDate(raw: string): Date | null {
  const text = normalizeSpace(raw)
  const match = text.match(/(?:In[ií]cio|Data do Leil[aã]o|Data do Evento)\s*:?[\s-]*(\d{2}\/\d{2}\/\d{4})(?:\s+(\d{2}:\d{2}))?/i)
  if (!match) return null
  return parseDatePtBr(match[1]!, match[2] ?? '')
}

function extractDetailImages(html: string): string[] {
  const $ = load(html)
  const urls: string[] = []
  const seen = new Set<string>()
  const add = (raw: string | null | undefined): void => {
    const url = toAbsoluteUrl(raw)
    if (!isUsableImageUrl(url) || seen.has(url)) return
    if (!/armazupvipleiloesprd|\/uploads\/|\/evento\/anuncio\//i.test(url)) return
    seen.add(url)
    urls.push(url)
  }

  add($('meta[property="og:image"]').attr('content'))
  $('img').each((_index, element) => {
    const image = $(element)
    for (const attr of IMAGE_URL_ATTRS) add(image.attr(attr))
    for (const attr of IMAGE_SRCSET_ATTRS) add(extractFirstSrcsetUrl(image.attr(attr)))
  })

  return urls.slice(0, 10)
}

function extractDetailPageText(html: string): string {
  const $ = load(html)
  const body = $('body').clone()
  body.find('script, style, noscript').remove()
  body.find('br, p, div, section, article, li, tr, td, th, dt, dd, h1, h2, h3, h4').append(' ')
  return normalizeSpace(body.text())
}

export function parseVipLeiloesDetailHtml(
  html: string,
  url: string,
  fallback: VehicleRecord,
): RawScrapedVehicle | null {
  const $ = load(html)
  const bodyText = extractDetailPageText(html)
  if (!bodyText || looksLikeCloudflareChallenge(html)) return null

  const vehicleField = extractDetailField(bodyText, ['Veículo', 'Veiculo'])
  const heading = normalizeSpace($('h1').first().text())
  const titleRaw = cleanVipVehicleTitle(
    (vehicleField || heading || `${fallback.brand} ${fallback.model}`)
      .replace(/^\d+\.\s*/, '')
      .replace(/\s+-\s+/, ' '),
  )
  const pageHasVehicleData = Boolean(
    vehicleField
    || /Detalhes do Lote|Oferta Inicial|Valor Atual|Funcionando na Entrada/i.test(bodyText),
  )
  if (!pageHasVehicleData) return null

  const imageAlt = normalizeSpace($('img[alt]').first().attr('alt') ?? '')
  const parsedBrandModel = parseBrandModel(titleRaw, inferBrandFromListingText(titleRaw), imageAlt)
  const parsedPrice = parseDetailPrice(bodyText)
  const yearField = extractDetailField(bodyText, ['Ano'])
  const kmField = extractDetailField(bodyText, ['KM', 'Quilometragem'])
  const locationField = extractDetailField(bodyText, ['Localização', 'Localizacao', 'Local'])
  const locationState = extractBrazilStateCode(locationField)
    ?? extractBrazilStateCode(fallback.yard)
    ?? extractBrazilStateCode(fallback.state)
  const status = extractVipStatusText(bodyText)
    || normalizeSpace(bodyText.match(/\b(?:Vendido|Arrematado|Encerrado|Condicional(?: negada| aprovada)?)\b/i)?.[0] ?? '')
    || null
  const initialPrice = normalizeSpace(bodyText.match(/(?:Oferta|Valor|Lance) Inicial\s*:?[\s\S]{0,80}?R\$\s*[\d.]+(?:,\d{1,2})?/i)?.[0] ?? '')
  const parsedImages = extractDetailImages(html)
  const parsedLot = bodyText.match(/\bLote\s*:\s*([A-Za-z0-9.-]+?)(?=\s|In[ií]cio|Data|$)/i)?.[1]?.trim() ?? null

  return {
    source: 'vipleiloes',
    brand: parsedBrandModel.brand === 'UNKNOWN' ? fallback.brand : parsedBrandModel.brand,
    model: parsedBrandModel.model === 'SEM MODELO' ? fallback.model : parsedBrandModel.model,
    year: parseYear(yearField || titleRaw) ?? fallback.year,
    damage: fallback.damage,
    price: parsedPrice.price ?? fallback.price,
    priceRaw: parsedPrice.priceRaw ?? fallback.priceRaw,
    imageUrls: parsedImages.length > 0 ? parsedImages : fallback.imageUrls,
    description: [status, initialPrice].filter(Boolean).join(' · ').slice(0, 240) || fallback.description,
    url,
    auctionDate: parseDetailAuctionDate(bodyText) ?? fallback.auctionDate,
    lot: parsedLot ?? fallback.lot,
    yard: locationState,
    city: null,
    state: locationState,
    km: kmField ? parseKm(kmField) : fallback.km,
    color: extractDetailField(bodyText, ['Cor']) ?? fallback.color,
    fuel: extractDetailField(bodyText, ['Combustível', 'Combustivel']) ?? fallback.fuel,
    fipe: null,
  }
}

function extractVipStatusText(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw)
  if (!text) return null
  const markers = [/\bREPASSE\b/i, /\bAo Vivo\b/i, /\bAberto para lances\b/i, /\bEm Breve\b/i]
  const hits = markers.map((pattern) => normalizeSpace(text.match(pattern)?.[0] ?? '')).filter(Boolean)
  const unique = Array.from(new Set(hits.map((item) => item.toUpperCase())))
  return unique.length > 0 ? unique.join(' · ') : null
}

function buildVipDamageLabel(classification: VipClassification, rawText: string, statusRaw: string | null): string {
  const parts = [classification.damage]
  if (/\bREPASSE\b/i.test(`${statusRaw ?? ''} ${rawText}`)) parts.push('repasse')
  return Array.from(new Set(parts.map((part) => normalizeSpace(part)).filter(Boolean))).join(' · ')
}

function extractBrazilStateCode(raw: string | null | undefined): string | null {
  const text = normalizeUpperText(raw)
  if (!text) return null

  const commaStateMatch = text.match(/,\s*([A-Z]{2})(?=\s*,|\s+CEP\b|\s*$)/)
  if (commaStateMatch?.[1] && BRAZIL_STATE_CODES.has(commaStateMatch[1])) {
    return commaStateMatch[1]
  }

  const dashStateMatch = text.match(/\s-\s*([A-Z]{2})(?=\s|$)/)
  if (dashStateMatch?.[1] && BRAZIL_STATE_CODES.has(dashStateMatch[1])) {
    return dashStateMatch[1]
  }

  const stateTokens = [...text.matchAll(/\b([A-Z]{2})\b/g)]
    .map(match => match[1])
    .filter((code): code is string => code != null && BRAZIL_STATE_CODES.has(code))
  const uniqueStates = Array.from(new Set(stateTokens))

  return uniqueStates.length === 1 ? uniqueStates[0] ?? null : null
}

function extractTitleFromListingText(raw: string): string {
  const text = normalizeSpace(raw)
  if (!text) return ''
  const explicitMatch = text.match(/(?:Lote:\s*[A-Za-z0-9.-]+\s+Local:\s*[A-Za-zÀ-ÿ0-9 .,/()-]+\s+)?(.+?\b(?:19|20)\d{2}\s*\/\s*(?:19|20)?\d{2}\b)/i)
  if (explicitMatch?.[1]) return cleanVipVehicleTitle(explicitMatch[1])
  return cleanVipVehicleTitle(text.split(/\bValor Atual\b/i)[0] ?? text)
}

function parseListingText(raw: string, statusRaw: string | null): { titleRaw: string; lot: string | undefined; yard: string | null; state: string | null; km: string | null; auctionDate: Date | null; description: string } {
  const text = normalizeSpace(raw)
  const titleRaw = extractTitleFromListingText(text)
  const lot = text.match(/\bLote:\s*([A-Za-z0-9.-]+)/i)?.[1]?.trim() || undefined
  const yardMatch = text.match(/(?:Local(?:iza(?:ção|cao)\s+do\s+lote| do lote)?|Local)\s*:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)(?=\s+R\$|\s+\d{1,3}(?:\.\d{3})*(?:,\d+)?\s*Km|\s+\d{2}\/\d{2}\/\d{4}|\s+Lance|\s*$)/i) ?? text.match(/\bLocal:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)\s+R\$/i)
  const state = extractBrazilStateCode(yardMatch?.[1])
  const yard = state
  const kmMatch = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s*Km\b/i)
  const km = kmMatch ? parseKm(kmMatch[1]!) : null
  const auctionDate = parseDateTimeFromText(text)
  const initialPriceLine = text.match(/Lance Inicial:\s*R\$\s*[\d.]+(?:,\d{1,2})?/i)?.[0] ?? null
  const status = normalizeSpace(statusRaw) || extractVipStatusText(text) || ''
  return { titleRaw, lot, yard, state, km, auctionDate, description: [status || null, initialPriceLine].filter(Boolean).join(' · ').slice(0, 240) }
}

const BRAND_TITLE_ALIASES: Array<{ alias: string; canonical: string }> = [
  { alias: 'MERCEDES BENZ', canonical: 'MERCEDES-BENZ' }, { alias: 'LAND ROVER', canonical: 'LAND ROVER' },
  { alias: 'CAOA CHERY', canonical: 'CAOA CHERY' }, { alias: 'GREAT WALL', canonical: 'GWM' },
  { alias: 'VOLKSWAGEN', canonical: 'VOLKSWAGEN' }, { alias: 'CHEVROLET', canonical: 'CHEVROLET' },
  { alias: 'HYUNDAI', canonical: 'HYUNDAI' }, { alias: 'CITROEN', canonical: 'CITROEN' },
  { alias: 'PEUGEOT', canonical: 'PEUGEOT' }, { alias: 'RENAULT', canonical: 'RENAULT' },
  { alias: 'TOYOTA', canonical: 'TOYOTA' }, { alias: 'NISSAN', canonical: 'NISSAN' },
  { alias: 'HONDA', canonical: 'HONDA' }, { alias: 'MITSUBISHI', canonical: 'MITSUBISHI' },
  { alias: 'MERCEDES', canonical: 'MERCEDES-BENZ' }, { alias: 'VOLVO', canonical: 'VOLVO' },
  { alias: 'JAGUAR', canonical: 'JAGUAR' }, { alias: 'PORSCHE', canonical: 'PORSCHE' },
  { alias: 'CHERY', canonical: 'CHERY' }, { alias: 'SUZUKI', canonical: 'SUZUKI' },
  { alias: 'SUBARU', canonical: 'SUBARU' }, { alias: 'KIA', canonical: 'KIA' },
  { alias: 'FIAT', canonical: 'FIAT' }, { alias: 'FORD', canonical: 'FORD' },
  { alias: 'JEEP', canonical: 'JEEP' }, { alias: 'AUDI', canonical: 'AUDI' },
  { alias: 'BMW', canonical: 'BMW' }, { alias: 'MINI', canonical: 'MINI' },
  { alias: 'RAM', canonical: 'RAM' }, { alias: 'BYD', canonical: 'BYD' },
  { alias: 'GWM', canonical: 'GWM' }, { alias: 'VW', canonical: 'VOLKSWAGEN' },
]

function normalizeAlphaNumWords(raw: string): string {
  return normalizeText(raw).replace(/[^a-z0-9]+/g, ' ').trim()
}

function inferBrandFromModelToken(modelTokenRaw: string): string {
  const token = normalizeAlphaNumWords(modelTokenRaw).replace(/\s+/g, '').toUpperCase()
  if (!token) return ''
  if (/^(GLE|GLA|GLB|GLC|GLK|GLS|CLA|CLS|C\d{3}|E\d{3}|S\d{3}|A\d{3}|B\d{3}|ML\d{3}|SL[KRC]?)/.test(token)) return 'MERCEDES-BENZ'
  return ''
}

function inferBrandFromListingText(raw: string): string {
  const normalized = normalizeAlphaNumWords(raw)
  if (!normalized) return ''
  for (const { alias, canonical } of BRAND_TITLE_ALIASES) {
    const aliasNormalized = normalizeAlphaNumWords(alias)
    if (!aliasNormalized) continue
    if (normalized === aliasNormalized || normalized.startsWith(`${aliasNormalized} `) || normalized.includes(` ${aliasNormalized} `)) return canonical
  }
  return ''
}

function inferBrandFromTitle(titleRaw: string): string {
  const normalizedTitle = normalizeAlphaNumWords(titleRaw)
  if (!normalizedTitle) return ''
  for (const { alias, canonical } of BRAND_TITLE_ALIASES) {
    const aliasNormalized = normalizeAlphaNumWords(alias)
    if (!aliasNormalized) continue
    if (normalizedTitle === aliasNormalized || normalizedTitle.startsWith(`${aliasNormalized} `)) return canonical
  }
  return ''
}

function buildModelFromTitle(titleRaw: string, brandRaw: string): string {
  const titleWords = normalizeAlphaNumWords(titleRaw).split(' ').filter(Boolean)
  if (titleWords.length === 0) return ''
  const brandWords = normalizeAlphaNumWords(brandRaw).split(' ').filter(Boolean)
  const yearLike = (token: string): boolean => /^(?:19|20)\d{2}$/.test(token)
  const dropDuplicates = (tokens: string[]): string[] => { const out: string[] = []; for (const t of tokens) { if (out[out.length - 1] !== t) out.push(t) }; return out }
  if (brandWords.length > 0 && titleWords.length > brandWords.length && brandWords.every((word, idx) => titleWords[idx] === word)) {
    return dropDuplicates(titleWords.slice(brandWords.length).filter((t) => !yearLike(t))).join(' ').toUpperCase()
  }
  return dropDuplicates(titleWords.filter((t) => !yearLike(t))).join(' ').toUpperCase()
}

function parseBrandModel(titleRaw: string, brandRaw: string, imageAltRaw: string): { brand: string; model: string } {
  const title = cleanVipVehicleTitle(titleRaw)
  const imageAlt = cleanVipVehicleTitle(imageAltRaw)
  const titleModel = normalizeSpace(title.split(/\s+-\s+/)[0] ?? title)
  const altParts = imageAlt.split(/\s+-\s+/).map((part) => normalizeSpace(part)).filter(Boolean)
  const brandFromAlt = altParts[0] ?? ''
  const modelFromAlt = altParts.slice(1).join(' - ')
  const inferredBrand = inferBrandFromTitle(titleModel)
  const modelFromTitle = buildModelFromTitle(titleModel, normalizeSpace(brandRaw || brandFromAlt || inferredBrand))
  const inferredBrandFromModel = inferBrandFromModelToken(normalizeSpace(modelFromTitle.split(' ')[0] ?? ''))
  const brand = normalizeSpace(brandRaw || brandFromAlt || inferredBrand || inferredBrandFromModel).toUpperCase() || 'UNKNOWN'
  return { brand, model: normalizeSpace(modelFromTitle || modelFromAlt).toUpperCase() || 'SEM MODELO' }
}

function parseTotalResults(raw: string): number | null {
  const match = normalizeSpace(raw).match(/([\d.]+)\s+resultados?\s+encontrados/i)
  if (!match) return null
  const parsed = Number.parseInt(match[1]!.replace(/\./g, ''), 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseSearchFragment(html: string, classification: VipClassification, log: (msg: string) => void): SearchFragmentParseResult {
  const $ = load(html)
  const vehicles: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()

  const pushVehicle = (url: string, listingRawText: string, statusRaw: string | null, imageUrl: string, imageAltRaw: string): void => {
    const listing = parseListingText(listingRawText, statusRaw)
    if (!listing.titleRaw || !looksLikeVehicleListingText(listingRawText)) return
    const brandHint = inferBrandFromListingText(listingRawText)
    const { brand, model } = parseBrandModel(listing.titleRaw, brandHint, imageAltRaw)
    const { price, priceRaw } = parsePrice(listingRawText)
    vehicles.push({
      source: 'vipleiloes', brand, model, year: parseYear(listing.titleRaw),
      damage: buildVipDamageLabel(classification, listingRawText, statusRaw),
      price, priceRaw, imageUrls: imageUrl ? [imageUrl] : [],
      description: listing.description || normalizeSpace(statusRaw).slice(0, 240),
      url, auctionDate: listing.auctionDate, lot: listing.lot, km: listing.km, yard: listing.yard, city: null, state: listing.state, fipe: null,
    })
  }

  $('.card.card-anuncio, .card-anuncio').each((_index, element) => {
    const card = $(element)
    const bodyAnchor = card.find("a.anc-body[href*='/evento/anuncio/']").first().length > 0
      ? card.find("a.anc-body[href*='/evento/anuncio/']").first()
      : card.find("a[href*='/evento/anuncio/'], a[href*='/Veiculos/DetalharVeiculo/'], a[href*='/veiculos/detalharveiculo/']").first()
    const href = bodyAnchor.attr('href') ?? ''
    const url = toAbsoluteUrl(href)
    if (!url || seenUrls.has(url)) return
    seenUrls.add(url)
    const listingRawText = normalizeSpace(bodyAnchor.text() || card.text())
    const status = normalizeSpace(card.find('.situacao').first().text()) || extractVipStatusText(card.text()) || null
    const imageUrl = pickFirstImageUrl((attr) => card.find('.crd-image img').first().attr(attr), (attr) => bodyAnchor.find('img').first().attr(attr), (attr) => card.find('img').first().attr(attr), (attr) => card.find('.crd-image').first().attr(attr))
    const imageAlt = normalizeSpace(card.find('.crd-image img').first().attr('alt') ?? bodyAnchor.find('img').first().attr('alt') ?? card.find('img').first().attr('alt') ?? '')
    pushVehicle(url, listingRawText, status, imageUrl, imageAlt)
  })

  $('a[href]').each((_index, element) => {
    const anchor = $(element)
    const hrefRaw = anchor.attr('href') ?? ''
    const href = toAbsoluteUrl(hrefRaw)
    if (!href || seenUrls.has(href)) return
    const isDetailUrl = /\/Veiculos\/DetalharVeiculo\//i.test(href) || /\/evento\/anuncio\//i.test(href)
    const anchorText = normalizeSpace(anchor.text())
    if (!isDetailUrl && !looksLikeVehicleListingText(anchorText)) return
    const container = anchor.closest('.card').length > 0 ? anchor.closest('.card') : anchor.closest('article, li, .item, .swiper-slide, .col')
    const mergedText = normalizeSpace(`${anchorText} ${container.text()}`)
    if (!looksLikeVehicleListingText(mergedText)) return
    const imageUrl = pickFirstImageUrl((attr) => container.find('img').first().attr(attr), (attr) => anchor.find('img').first().attr(attr))
    const imageAlt = normalizeSpace(container.find('img').first().attr('alt') ?? anchor.find('img').first().attr('alt') ?? '')
    seenUrls.add(href)
    pushVehicle(href, mergedText, extractVipStatusText(container.text()), imageUrl, imageAlt)
  })

  const activePageText = normalizeSpace($('#CurrentPage').attr('value')) || normalizeSpace($('.pagination .page-item.active .page-link').first().text())
  const activePageParsed = Number.parseInt(activePageText, 10)
  const currentPage = Number.isFinite(activePageParsed) ? activePageParsed : null

  let nextAjaxUrl = $('.page-item.page-go:not(.disabled) a.page-link[aria-label="Next"]').first().attr('data-ajax-url') ?? ''
  if (!nextAjaxUrl) {
    const candidates = $('.pagination a.page-link[data-ajax-url]').toArray()
      .map((item) => ($(item).attr('data-ajax-url') ?? '').replace(/&amp;/g, '&').trim())
      .filter((url) => /pageNumber=\d+/i.test(url))
      .map((url) => ({ url, pageNumber: Number.parseInt(url.match(/pageNumber=(\d+)/i)?.[1] ?? '', 10) }))
      .filter((item) => Number.isFinite(item.pageNumber))
    const nextCandidate = candidates.filter((item) => currentPage == null || item.pageNumber > currentPage).sort((a, b) => a.pageNumber - b.pageNumber)[0]
    nextAjaxUrl = nextCandidate?.url ?? ''
  }
  nextAjaxUrl = ensureClassificationQuery(nextAjaxUrl.replace(/&amp;/g, '&').trim(), classification)
  if (nextAjaxUrl && !/handler=pesquisar/i.test(nextAjaxUrl)) {
    const onclickText = $('.page-item.page-go:not(.disabled) a.page-link[aria-label="Next"]').first().attr('onclick') ?? ''
    const onclickUrl = onclickText.match(/['"]([^'"]*handler=pesquisar[^'"]*)['"]/i)?.[1] ?? ''
    nextAjaxUrl = onclickUrl ? ensureClassificationQuery(onclickUrl.replace(/&amp;/g, '&'), classification) : ''
  }

  log(`[vipleiloes][${classification.name}] Página ${currentPage ?? '?'}: ${vehicles.length} lote(s) extraído(s).`)
  return { vehicles, nextAjaxUrl: nextAjaxUrl || null, currentPage, totalResults: parseTotalResults($('#resultadosEncontrados').first().text()) }
}

async function collectFromCurrentPageHtml(
  page: Page,
  all: RawScrapedVehicle[],
  seenUrls: Set<string>,
  classification: VipClassification,
  log: (msg: string) => void,
  publishVehicle?: (vehicle: RawScrapedVehicle) => Promise<void>,
): Promise<{ added: number; parsed: SearchFragmentParseResult }> {
  const html = await page.content()
  const parsed = parseSearchFragment(html, classification, log)
  let added = 0
  for (const vehicle of parsed.vehicles) {
    if (seenUrls.has(vehicle.url)) continue
    seenUrls.add(vehicle.url)
    all.push(vehicle)
    added += 1
    await publishVehicle?.(vehicle)
  }
  return { added, parsed }
}

async function clickLoadMoreIfAvailable(page: Page): Promise<boolean> {
  const loadMore = page.locator("button:has-text('Exibir Mais'), a:has-text('Exibir Mais')").first()
  const visible = await loadMore.isVisible().catch(() => false)
  if (!visible) return false
  await loadMore.click({ timeout: 8_000 }).catch(() => undefined)
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => undefined)
  await page.waitForTimeout(1_200)
  return true
}

function looksLikeCloudflareChallenge(html: string): boolean {
  const marker = html.toLowerCase()
  return marker.includes('just a moment') || marker.includes('performing security verification') || marker.includes('enable javascript and cookies to continue') || marker.includes('cdn-cgi/challenge-platform')
}

function isHtmlDocument(raw: string): boolean {
  return /<html[\s>]/i.test(raw) && /<body[\s>]/i.test(raw)
}

function looksLikeVipListingPage(rawHtml: string): boolean {
  const html = rawHtml.toLowerCase()
  return html.includes('detalharveiculo') || html.includes('card-anuncio') || html.includes('resultadosencontrados') || html.includes('filtro.classificacao') || html.includes('formpost')
}

async function detectVipProtection(page: Page): Promise<string | null> {
  const html = await page.content().catch(() => '')
  const text = (await page.textContent('body').catch(() => '')) ?? ''
  const marker = `${html}\n${text}`.toLowerCase()
  if (marker.includes('just a moment') || marker.includes('performing security verification') || marker.includes('enable javascript and cookies to continue') || marker.includes('cdn-cgi/challenge-platform')) return 'cloudflare'
  return null
}

async function detectVipProtectionWithRetry(page: Page, log: (msg: string) => void): Promise<string | null> {
  let reason = await detectVipProtection(page)
  if (!reason) return null
  log('[vipleiloes] Desafio anti-bot detectado, aguardando validação automática...')
  await page.waitForTimeout(6_000)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined)
  await page.waitForTimeout(2_000)
  return detectVipProtection(page)
}

function isVipVehicleDetailUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase()
    return (
      (hostname === 'vipleiloes.com.br' || hostname.endsWith('.vipleiloes.com.br'))
      && (/\/evento\/anuncio\//i.test(url.pathname) || /\/veiculos\/detalharveiculo\//i.test(url.pathname))
    )
  }
  catch {
    return false
  }
}

export async function fetchVipLeiloesVehicleByUrl(
  url: string,
  fallback: VehicleRecord,
  options?: ScraperOptions,
): Promise<RawScrapedVehicle> {
  if (!isVipVehicleDetailUrl(url)) {
    throw new Error('[vipleiloes] URL de detalhe inválida.')
  }

  const log = options?.log ?? console.log
  const headless = getHeadless(options?.headless ?? true)
  const profilePath = getProfilePath()
  const signal = options?.signal
  const context = await chromium.launchPersistentContext(profilePath, {
    ...buildPlaywrightLaunchOptions(headless),
    userAgent: USER_AGENT,
    locale: 'pt-BR',
  })
  const closeContextOnAbort = () => {
    void context.close().catch(() => undefined)
  }

  signal?.addEventListener('abort', closeContextOnAbort, { once: true })

  try {
    throwIfAborted(signal)
    const page = context.pages()[0] ?? (await context.newPage())
    log(`[vipleiloes] Atualizando somente o lote: ${url}`)
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
    await page.waitForTimeout(1_500)

    const protection = await detectVipProtectionWithRetry(page, log)
    if (protection) {
      throw new Error(`[vipleiloes] Bloqueio anti-bot ao atualizar o lote (${protection}).`)
    }

    const html = await page.content()
    const vehicle = parseVipLeiloesDetailHtml(html, url, fallback)
    if (!vehicle) {
      throw new Error('[vipleiloes] A página abriu, mas os dados do lote não foram encontrados.')
    }

    log(`[vipleiloes] Lote atualizado: ${vehicle.brand} ${vehicle.model} · ${vehicle.priceRaw ?? 'sem preço'}.`)
    return vehicle
  }
  finally {
    signal?.removeEventListener('abort', closeContextOnAbort)
    await context.close().catch(() => undefined)
  }
}

async function fetchSearchPartial(page: Page, ajaxUrl: string, classification: VipClassification): Promise<PartialFetchResult> {
  return page.evaluate(async ({ ajaxUrlInput, defaultPath, classificationName }) => {
    try {
      const form = document.getElementById('formPost')
      if (!(form instanceof HTMLFormElement)) return { ok: false, status: 0, requestUrl: ajaxUrlInput || defaultPath, html: '', error: 'form_not_found' }
      const requestUrlRaw = new URL(ajaxUrlInput || defaultPath, window.location.origin)
      requestUrlRaw.searchParams.set('classificacao', classificationName)
      if (!requestUrlRaw.searchParams.get('handler')) requestUrlRaw.searchParams.set('handler', 'pesquisar')
      const requestUrl = requestUrlRaw.toString()
      const pageNumber = new URL(requestUrl).searchParams.get('pageNumber')?.trim() ?? ''
      const body = new URLSearchParams()
      new FormData(form).forEach((value, key) => { if (typeof value === 'string') body.append(key, value) })
      const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '').trim()
      const classificacaoSelect = form.querySelector('select[name="Filtro.Classificacao"]') as HTMLSelectElement | null
      const selectedOption = classificacaoSelect ? Array.from(classificacaoSelect.options).find((o) => { const ok = normalize(o.textContent ?? ''); const tk = normalize(classificationName); return Boolean(ok && tk) && (ok.includes(tk) || tk.includes(ok)) }) ?? null : null
      const classificationValue = (selectedOption?.value ?? classificationName).trim() || classificationName
      if (classificacaoSelect) classificacaoSelect.value = classificationValue
      body.set('Filtro.Classificacao', classificationValue)
      body.set('Filtro.SelecaoVeiculos', 'true')
      body.set('Filtro.SelecaoOutros', 'false')
      if (pageNumber) { body.set('CurrentPage', pageNumber); body.set('Filtro.CurrentPage', pageNumber) }
      if (!body.get('Filtro.OrdenarPor')) body.set('Filtro.OrdenarPor', 'DataInicio')
      const response = await fetch(requestUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: body.toString(), credentials: 'same-origin' })
      return { ok: response.ok, status: response.status, requestUrl: response.url || requestUrl, html: await response.text() }
    }
    catch (error) {
      return { ok: false, status: 0, requestUrl: ajaxUrlInput || defaultPath, html: '', error: error instanceof Error ? error.message : String(error) }
    }
  }, { ajaxUrlInput: ajaxUrl, defaultPath: buildSearchHandlerPath(classification), classificationName: classification.name })
}

async function fetchSearchPartialWithRetry(
  page: Page,
  ajaxUrl: string,
  classification: VipClassification,
  log: (msg: string) => void,
  signal?: AbortSignal,
): Promise<PartialFetchResult> {
  let lastResult: PartialFetchResult | null = null

  for (let attempt = 1; attempt <= AJAX_MAX_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal)
    const result = await fetchSearchPartial(page, ajaxUrl, classification)
    lastResult = result
    if (result.status !== 429 || attempt === AJAX_MAX_ATTEMPTS) return result

    const waitMs = AJAX_RATE_LIMIT_BASE_DELAY_MS * attempt
    log(`[vipleiloes][${classification.name}] Rate limit HTTP 429 na paginação; aguardando ${waitMs}ms (tentativa ${attempt + 1}/${AJAX_MAX_ATTEMPTS}).`)
    await sleep(waitMs, signal)
  }

  return lastResult ?? { ok: false, status: 0, requestUrl: ajaxUrl, html: '', error: 'no_response' }
}

async function run(
  _filters: AuctionFilters,
  options?: ScraperOptions,
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const maxPages = parseMaxPagesFromEnv()
  const requestDelayMs = parseRequestDelayFromEnv()
  const headless = getHeadless(options?.headless ?? true)
  const signal = options?.signal
  const profilePath = getProfilePath()
  const classifications = parseClassificationsFromEnv(log)
  const context = await chromium.launchPersistentContext(profilePath, {
    ...buildPlaywrightLaunchOptions(headless),
    userAgent: USER_AGENT,
    locale: 'pt-BR',
  })
  const closeContextOnAbort = () => {
    void context.close().catch(() => undefined)
  }

  if (signal?.aborted) {
    await context.close().catch(() => undefined)
    throw new Error('Scraping cancelado.')
  }

  signal?.addEventListener('abort', closeContextOnAbort, { once: true })

  const existingPage = context.pages()[0]
  const page = existingPage ?? (await context.newPage())
  const all: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()
  let hadPartialCollection = false
  const publishVehicle = async (vehicle: RawScrapedVehicle): Promise<void> => {
    await options?.onVehicle?.(vehicle)
  }

  try {
    log(`[vipleiloes] Iniciando (${classifications.map((item) => item.name).join(', ')})...`)
    log(`[vipleiloes] Perfil persistente: ${profilePath}`)
    log(`[vipleiloes] Delay entre páginas: ${requestDelayMs}ms · headless=${headless ? 'true' : 'false'}`)

    for (const classification of classifications) {
      throwIfAborted(signal)
      const classificationStartCount = all.length
      const visitedAjaxUrls = new Set<string>()
      log(`[vipleiloes][${classification.name}] Iniciando classificação...`)

      const startCandidates = [buildStartUrl(classification), ...START_URL_FALLBACKS]
      let selectedLooksReady = false
      for (const candidate of startCandidates) {
        throwIfAborted(signal)
        log(`[vipleiloes][${classification.name}] Abrindo URL inicial candidata: ${candidate}`)
        await page.goto(candidate, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined)
        await page.waitForTimeout(1_500)
        const protection = await detectVipProtectionWithRetry(page, log)
        if (protection) {
          const message = `[vipleiloes][${classification.name}] Bloqueio anti-bot persistente.`
          log(message)
          if (all.length > 0) {
            throw new PartialScraperResultError(`${message} Resultado parcial preservado.`, all)
          }
          return []
        }
        const html = await page.content().catch(() => '')
        selectedLooksReady = looksLikeVipListingPage(html) && !/\/canal(?:\/|$|\?)/i.test(page.url())
        if (selectedLooksReady) break
      }

      if (!selectedLooksReady) log(`[vipleiloes][${classification.name}] Nenhuma URL inicial confirmou listagem claramente. Prosseguindo com fallback.`)

      let ajaxUrl: string | null = buildSearchPageHandlerPath(classification, 1)
      let pageAttempt = 0
      let loggedTotal = false
      let reportedTotal: number | null = null

      while (pageAttempt < maxPages) {
        throwIfAborted(signal)
        if (!ajaxUrl) {
          const clicked = await clickLoadMoreIfAvailable(page)
          if (!clicked) { log('[vipleiloes] Sem próxima página. Encerrando.'); break }
          const domAfterClick = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log, publishVehicle)
          if (reportedTotal == null && domAfterClick.parsed.totalResults != null) reportedTotal = domAfterClick.parsed.totalResults
          if (!loggedTotal && domAfterClick.parsed.totalResults != null) { loggedTotal = true; log(`[vipleiloes][${classification.name}] ${domAfterClick.parsed.totalResults} resultado(s) reportado(s).`) }
          log(`[vipleiloes][${classification.name}] Após 'Exibir Mais': +${domAfterClick.added} novo(s), acumulado=${all.length}.`)
          ajaxUrl = domAfterClick.parsed.nextAjaxUrl ? ensureClassificationQuery(domAfterClick.parsed.nextAjaxUrl, classification) : null
          await sleep(requestDelayMs, signal); continue
        }

        const normalizedAjaxUrl = ensureClassificationQuery(ajaxUrl.replace(/&amp;/g, '&'), classification)
        if (visitedAjaxUrls.has(normalizedAjaxUrl)) {
          log(`[vipleiloes] Loop de paginação detectado. Encerrando.`)
          const collectedInClassification = all.length - classificationStartCount
          if (reportedTotal != null && collectedInClassification < reportedTotal) {
            hadPartialCollection = true
            log(`[vipleiloes][${classification.name}] Paginação incompleta: ${collectedInClassification}/${reportedTotal} coletado(s).`)
          }
          break
        }
        visitedAjaxUrls.add(normalizedAjaxUrl); pageAttempt += 1

        log(`[vipleiloes][${classification.name}] Coletando página ${pageAttempt}/${maxPages} (${normalizedAjaxUrl})...`)
        let partial = await fetchSearchPartialWithRetry(page, normalizedAjaxUrl, classification, log, signal)

        if (partial.ok && isHtmlDocument(partial.html) && !partial.html.includes('card-anuncio') && looksLikeCloudflareChallenge(partial.html)) {
          log('[vipleiloes] Challenge detectado no AJAX. Recarregando sessão...')
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => undefined)
          await page.waitForTimeout(2_000)
          partial = await fetchSearchPartialWithRetry(page, normalizedAjaxUrl, classification, log, signal)
        }

        stopVipOnNetworkFailure(partial, classification, all, log)

        if (!partial.ok) {
          if (partial.status === 429) {
            hadPartialCollection = all.length > classificationStartCount
            log(`[vipleiloes][${classification.name}] Rate limit persistente na paginação; coleta parcial preservada.`)
            break
          }
          const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log, publishVehicle)
          log(`[vipleiloes][${classification.name}] Fallback DOM: +${domFallback.added} novo(s), acumulado=${all.length}.`)
          ajaxUrl = domFallback.parsed.nextAjaxUrl ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification) : null
          if (!ajaxUrl) { const clicked = await clickLoadMoreIfAvailable(page); if (!clicked) break; const domC = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log, publishVehicle); ajaxUrl = domC.parsed.nextAjaxUrl ? ensureClassificationQuery(domC.parsed.nextAjaxUrl, classification) : null }
          await sleep(requestDelayMs, signal); continue
        }

        if (looksLikeCloudflareChallenge(partial.html) || (isHtmlDocument(partial.html) && !partial.html.includes('card-anuncio'))) {
          const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log, publishVehicle)
          log(`[vipleiloes][${classification.name}] Fallback DOM (challenge/HTML): +${domFallback.added} novo(s), acumulado=${all.length}.`)
          ajaxUrl = domFallback.parsed.nextAjaxUrl ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification) : null
          if (!ajaxUrl) break
          await sleep(requestDelayMs, signal); continue
        }

        let parsed = parseSearchFragment(partial.html, classification, log)
        const requestedPage = parsePageNumberFromUrl(normalizedAjaxUrl)
        if (isPaginationResetResponse(parsed, requestedPage)) {
          log(`[vipleiloes][${classification.name}] Resposta voltou para página ${parsed.currentPage} ao pedir página ${requestedPage}; tentando novamente.`)
          await sleep(Math.max(requestDelayMs, AJAX_RATE_LIMIT_BASE_DELAY_MS), signal)
          partial = await fetchSearchPartialWithRetry(page, normalizedAjaxUrl, classification, log, signal)
          stopVipOnNetworkFailure(partial, classification, all, log)
          if (!partial.ok) {
            if (partial.status === 429) {
              hadPartialCollection = all.length > classificationStartCount
              log(`[vipleiloes][${classification.name}] Rate limit persistente na paginação; coleta parcial preservada.`)
              break
            }
            const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log, publishVehicle)
            log(`[vipleiloes][${classification.name}] Fallback DOM: +${domFallback.added} novo(s), acumulado=${all.length}.`)
            ajaxUrl = domFallback.parsed.nextAjaxUrl ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification) : null
            await sleep(requestDelayMs, signal); continue
          }
          parsed = parseSearchFragment(partial.html, classification, log)
          if (isPaginationResetResponse(parsed, requestedPage)) {
            hadPartialCollection = all.length > classificationStartCount
            log(`[vipleiloes][${classification.name}] Paginação reiniciou para página ${parsed.currentPage} ao pedir página ${requestedPage}; encerrando classificação como parcial.`)
            break
          }
        }
        if (parsed.totalResults != null) reportedTotal = parsed.totalResults
        if (!loggedTotal && parsed.totalResults != null) { loggedTotal = true; log(`[vipleiloes][${classification.name}] ${parsed.totalResults} resultado(s) reportado(s).`) }
        let added = 0
        for (const vehicle of parsed.vehicles) {
          if (seenUrls.has(vehicle.url)) continue
          seenUrls.add(vehicle.url)
          all.push(vehicle)
          added += 1
          await publishVehicle(vehicle)
        }
        log(`[vipleiloes][${classification.name}] Página ${parsed.currentPage ?? pageAttempt}: +${added} novo(s), acumulado=${all.length}.`)

        const nextUrl = parsed.nextAjaxUrl?.replace(/&amp;/g, '&').trim() ?? ''
        ajaxUrl = nextUrl ? ensureClassificationQuery(nextUrl, classification) : null
        if (!ajaxUrl && added === 0) {
          const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log, publishVehicle)
          ajaxUrl = domFallback.parsed.nextAjaxUrl ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification) : null
        }
        await sleep(requestDelayMs, signal)
      }

      if (pageAttempt >= maxPages && ajaxUrl) {
        log(`[vipleiloes][${classification.name}] Limite de ${maxPages} página(s) atingido.`)
        const collectedInClassification = all.length - classificationStartCount
        if (reportedTotal != null && collectedInClassification < reportedTotal) hadPartialCollection = true
      }
      log(`[vipleiloes][${classification.name}] Classificação concluída: +${all.length - classificationStartCount} novo(s), acumulado=${all.length}.`)
      await sleep(requestDelayMs, signal)
    }

    if (hadPartialCollection && all.length > 0) {
      throw new PartialScraperResultError('[vipleiloes] Coleta parcial por paginação incompleta. Resultado parcial preservado.', all)
    }
  }
  catch (error) {
    if (error instanceof PartialScraperResultError) throw error

    log(`[vipleiloes] Erro: ${error instanceof Error ? error.message : String(error)}`)
    if (all.length > 0) {
      throw new PartialScraperResultError('[vipleiloes] Erro após coleta parcial. Resultado parcial preservado.', all)
    }
    return []
  }
  finally {
    signal?.removeEventListener('abort', closeContextOnAbort)
    await context.close().catch(() => undefined)
  }

  log(`[vipleiloes] Total: ${all.length} veículo(s).`)
  return all
}

export const vipLeiloesSource: ScraperSource = {
  id: 'vipleiloes',
  name: 'VIP Leilões',
  run,
}
