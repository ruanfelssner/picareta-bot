import { chromium, type BrowserContext, type Page, type Response } from 'playwright'
import type { AuctionFilters } from '#shared/types/filters'
import type { VehicleAuctionStatus, VehicleSaleStatus } from '#shared/types/vehicle'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperSource } from '../source-types'
import { buildPlaywrightLaunchOptions } from '../playwright-launch'
import { sanitizeCityList, sanitizeStateList } from '../location-filter'

const CALENDAR_URL = 'https://www.copart.com.br/auctionCalendar/'
const SEARCH_API_URL = 'https://www.copart.com.br/public/lots/search'
const FALLBACK_LOCATIONS = ['Curitiba - PR', 'Canoas - RS']
const DEFAULT_PROFILE_PATH = './data/copart-profile'
const COPART_PAGE_SIZE = 100
const DEFAULT_COPART_CATEGORIES = [
  'categoria:"Automóveis"',
  'categoria:"SUV Grandes"',
  'categoria:"SUV Pequenos"',
  'categoria:"Picapes Grandes"',
  'categoria:"Picapes Pequenas"',
]

const LOT_NUMBER_KEYS = ['lotNumberStr', 'lotNumber', 'lot_number', 'lotNum', 'lotId', 'lot_id', 'ln', 'numeroLote', 'lote']
const MAKE_KEYS = ['make', 'mkn', 'marca', 'brand', 'fabricante', 'makeName', 'make_name', 'makeDesc', 'lotMakeDesc']
const MODEL_KEYS = ['model', 'lm', 'modelo', 'modelName', 'model_name', 'modelDesc', 'lotModelDesc', 'modelGroup', 'modelDetail']
const YEAR_KEYS = ['year', 'yr', 'yn', 'ano', 'modelYear', 'lot_year', 'fy']
const PRICE_KEYS = ['currentHighBid', 'current_high_bid', 'currentBid', 'bp', 'bid', 'highBid', 'lance', 'lanceAtual', 'high_bid', 'ahb', 'actualBid', 'current_offer']
const FIPE_KEYS = ['fipeValue', 'fipe_value', 'valorFipe', 'fipe', 'la', 'estimatedRetailValue', 'estRetailValue']
const DAMAGE_KEYS = ['damageDescription', 'damage_description', 'dd', 'damage', 'classificacaodano', 'avaria', 'sinistro', 'primaryDamage', 'lossType']
const KM_KEYS = ['odometer', 'km', 'odometro', 'od', 'quilometragem', 'mileage']
const COLOR_KEYS = ['color', 'cor', 'colour', 'exteriorColor']
const YARD_KEYS = ['yardName', 'yn', 'saleName', 'syn', 'patioveiculo', 'patioleilao']
const THUMB_KEYS = ['thumbnailImage', 'thumbnail_image', 'thmb', 'img', 'image', 'foto', 'imageUrl', 'thumbnail', 'imageThumbnail', 'image_url', 'thumb', 'tims', 'heroImageUrl']
const DATE_KEYS = ['auction_date_utc', 'saleDate', 'auction_date', 'data', 'auctionDate', 'sale_date']
const AUCTION_STATUS_KEYS = [
  'auctionStatus',
  'auction_status',
  'saleStatus',
  'sale_status',
  'lotStatus',
  'lot_status',
  'lotStatusDesc',
  'lotStatusDescription',
  'statusDescription',
  'saleStatusDescription',
  'bidStatus',
  'biddingStatus',
  'dynamicLotDetailsStatus',
  'venda',
  'situacao',
  'situação',
]
const SALE_TARGET_SELECTOR = [
  "a[href*='saleListResult/auctionId/']",
  "a[data-url*='saleListResult/auctionId/']",
  "a[href*='saleListResult/inventory/']",
  "a[data-url*='saleListResult/inventory/']",
  "a[href*='saleListResult/']",
  "a[data-url*='saleListResult/']",
].join(', ')

type CopartLot = Record<string, unknown>
type CopartSaleTarget = { location: string; url: string; miscFilter: string; label: string }
type CopartApiResult = {
  returnCode?: number
  returnCodeDesc?: string
  data?: { results?: { totalElements?: number; content?: Array<Record<string, unknown>> } }
}

function normalizeToken(value: string): string {
  return value.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().toUpperCase()
}

function normalizeLooseText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function isLargeDamageCopart(input: string): boolean {
  const normalized = normalizeLooseText(input)
  if (!normalized) return false
  return (
    normalized.includes('grande monta') ||
    normalized.includes('sucata') ||
    normalized.includes('perda total') ||
    normalized.includes('irrecuperavel') ||
    normalized.includes('recuperacao impossivel')
  )
}

function normalizeCopartAuctionStatus(raw: string | null): VehicleAuctionStatus | null {
  const normalized = normalizeLooseText(raw ?? '')
  if (!normalized) return null

  if (
    normalized.includes('condicional') ||
    normalized.includes('nao vendido') ||
    normalized.includes('não vendido') ||
    normalized.includes('venda finalizada') ||
    normalized.includes('leilao finalizado') ||
    normalized.includes('leilao encerrado') ||
    normalized.includes('finalizado') ||
    normalized.includes('finalizada') ||
    normalized.includes('encerrado') ||
    normalized.includes('encerrada') ||
    normalized.includes('vendido')
  ) return 'finished'

  if (
    normalized.includes('venda futura') ||
    normalized.includes('leilao futuro') ||
    normalized.includes('futura') ||
    normalized.includes('futuro')
  ) return 'future'

  if (
    normalized.includes('aberto') ||
    normalized.includes('em andamento') ||
    normalized.includes('dar lance') ||
    normalized.includes('lance atual')
  ) return 'upcoming'

  return null
}

function normalizeCopartSaleStatus(raw: string | null): VehicleSaleStatus | null {
  const normalized = normalizeLooseText(raw ?? '')
  if (!normalized) return null

  if (
    normalized.includes('nao vendido') ||
    normalized.includes('não vendido') ||
    normalized.includes('sem venda') ||
    normalized.includes('no sale')
  ) return 'not_sold'

  if (
    normalized.includes('condicional') ||
    normalized.includes('venda condicional') ||
    normalized.includes('conditional')
  ) return 'conditional'

  if (
    normalized.includes('vendido') ||
    normalized.includes('arrematado') ||
    normalized.includes('lance vencedor') ||
    normalized.includes('sold')
  ) return 'sold'

  return null
}

function collectStatusTextCandidates(value: unknown, collector: string[], depth = 0): void {
  if (depth > 4 || value == null) return
  if (typeof value === 'string') {
    const normalized = normalizeLooseText(value)
    if (
      normalized.includes('venda') ||
      normalized.includes('leilao') ||
      normalized.includes('finaliz') ||
      normalized.includes('encerrad') ||
      normalized.includes('vendido') ||
      normalized.includes('sem venda') ||
      normalized.includes('no sale') ||
      normalized.includes('condicional') ||
      normalized.includes('arrematad') ||
      normalized.includes('futur')
    ) {
      collector.push(value.trim())
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStatusTextCandidates(item, collector, depth + 1)
    return
  }
  if (typeof value !== 'object') return

  const record = value as Record<string, unknown>
  for (const [key, child] of Object.entries(record)) {
    const normalizedKey = normalizeLooseText(key)
    const isPrimitive = typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean'
    if (AUCTION_STATUS_KEYS.some(statusKey => normalizeLooseText(statusKey) === normalizedKey) && isPrimitive) {
      collector.push(str(child).trim())
    }
    collectStatusTextCandidates(child, collector, depth + 1)
  }
}

function extractCopartAuctionStatusRaw(lot: CopartLot): string | null {
  const candidates: string[] = []
  collectStatusTextCandidates(lot, candidates)

  const cleaned = candidates
    .map(candidate => candidate.trim())
    .filter(Boolean)
    .filter((candidate, index, arr) => arr.findIndex(item => normalizeLooseText(item) === normalizeLooseText(candidate)) === index)

  return cleaned.find(candidate => normalizeCopartAuctionStatus(candidate) != null) ?? cleaned[0] ?? null
}

function extractCopartSaleStatusRaw(lot: CopartLot): string | null {
  const candidates: string[] = []
  collectStatusTextCandidates(lot, candidates)

  const cleaned = candidates
    .map(candidate => candidate.trim())
    .filter(Boolean)
    .filter((candidate, index, arr) => arr.findIndex(item => normalizeLooseText(item) === normalizeLooseText(candidate)) === index)

  return cleaned.find(candidate => normalizeCopartSaleStatus(candidate) != null) ?? null
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)]
}

function buildSearchCriteria(miscFilter: string): string {
  const searchFilter: Record<string, string[]> = { MISC: [miscFilter] }
  if (DEFAULT_COPART_CATEGORIES.length > 0) searchFilter.categoria = DEFAULT_COPART_CATEGORIES
  return JSON.stringify({ query: ['*'], filter: searchFilter, sort: ['auction_date_utc asc', 'brazil_default_sort asc'], watchListOnly: false, searchName: '', freeFormSearch: false })
}

function withSearchCriteria(baseUrl: string, searchCriteria: string): string {
  const url = new URL(baseUrl, 'https://www.copart.com.br')
  url.searchParams.set('searchCriteria', searchCriteria)
  if (!url.searchParams.has('liveAuction')) url.searchParams.set('liveAuction', 'false')
  if (!url.searchParams.has('from')) url.searchParams.set('from', '')
  return url.toString()
}

function buildSearchUrl(miscFilter: string, location: string): string {
  const yardMatch = miscFilter.match(/^(?:#PhysicalYardNo|physical_yard_number):(\d{1,5})$/i)
  const auctionMatch = miscFilter.match(/^auction_id:(\d{3,7})$/i)
  const basePath = yardMatch
    ? `https://www.copart.com.br/saleListResult/inventory/${yardMatch[1]}`
    : `https://www.copart.com.br/saleListResult/auctionId/${auctionMatch?.[1] ?? '0'}`
  const url = new URL(basePath)
  url.searchParams.set('location', location)
  url.searchParams.set('liveAuction', 'false')
  url.searchParams.set('from', '')
  return withSearchCriteria(url.toString(), buildSearchCriteria(miscFilter))
}

function buildCopartSearchPostBody(miscFilter: string | string[], categoryFilters: string[], opts?: { page?: number; size?: number; draw?: number }): URLSearchParams {
  const page = opts?.page ?? 0
  const size = opts?.size ?? COPART_PAGE_SIZE
  const draw = opts?.draw ?? 1
  const miscFilters = Array.isArray(miscFilter) ? miscFilter : [miscFilter]
  const params = new URLSearchParams()
  const columnsCount = 17
  params.set('draw', String(draw))
  for (let i = 0; i < columnsCount; i += 1) {
    params.set(`columns[${i}][data]`, String(i))
    params.set(`columns[${i}][name]`, '')
    params.set(`columns[${i}][searchable]`, 'true')
    params.set(`columns[${i}][orderable]`, i >= 2 && i <= 13 ? 'true' : 'false')
    params.set(`columns[${i}][search][value]`, '')
    params.set(`columns[${i}][search][regex]`, 'false')
  }
  params.set('order[0][column]', '1')
  params.set('order[0][dir]', 'asc')
  params.set('start', String(page * size))
  params.set('length', String(size))
  params.set('search[value]', '')
  params.set('search[regex]', 'false')
  params.set('sort', 'auction_date_utc asc,brazil_default_sort asc')
  params.set('defaultSort', 'true')
  params.set('filter[MISC]', miscFilters.join(','))
  if (categoryFilters.length > 0) {
    params.set('filter[categoria]', categoryFilters.join(','))
    params.set('includeTagByField[categoria]', '{!tag=categoria}')
  }
  params.set('query', '*')
  params.set('watchListOnly', 'false')
  params.set('freeFormSearch', 'false')
  params.set('page', String(page))
  params.set('size', String(size))
  return params
}

function getLocations(filters: AuctionFilters): string[] {
  const states = sanitizeStateList(filters.states ?? [])
  const cities = sanitizeCityList(filters.cities ?? [])
  const fromGeo = new Set<string>()
  if (states.length > 0 && cities.length > 0) {
    for (const city of cities) for (const state of states) fromGeo.add(`${city} - ${state}`)
  }
  else if (cities.length > 0) { for (const city of cities) fromGeo.add(city) }
  else if (states.length > 0) { for (const state of states) fromGeo.add(state) }
  return Array.from(fromGeo)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v != null ? String(v) : ''
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && !Number.isNaN(v)) return v
  if (typeof v === 'string') {
    const cleaned = v.replace(/[^\d.,-]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')
    const n = Number.parseFloat(cleaned)
    return Number.isNaN(n) ? null : n
  }
  return null
}

function int(v: unknown): number | null {
  const n = num(v)
  if (n === null) return null
  const rounded = Math.round(n)
  return Number.isFinite(rounded) ? rounded : null
}

function pick(lot: CopartLot, ...keys: string[]): string {
  for (const k of keys) if (lot[k] != null && lot[k] !== '') return str(lot[k])
  return ''
}

function pickN(lot: CopartLot, ...keys: string[]): number | null {
  for (const k of keys) { const v = num(lot[k]); if (v !== null) return v }
  return null
}

function pickYearFromTitle(title: string): number | null {
  const m = title.match(/\b(19|20)\d{2}\b/)
  return m ? Number.parseInt(m[0], 10) : null
}

function parseMakeModelFromTitle(title: string): { make: string; model: string } {
  const cleaned = title.trim().replace(/\s+/g, ' ')
  const yearMatch = cleaned.match(/\b(19|20)\d{2}\b/)
  const afterYear = yearMatch ? cleaned.slice((yearMatch.index ?? 0) + yearMatch[0].length).trim() : cleaned
  const parts = afterYear.split(' ').filter(Boolean)
  return { make: parts[0] ?? '', model: parts.slice(1).join(' ') }
}

function parseAuctionDate(raw: unknown): Date | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const millis = raw > 1e12 ? raw : raw * 1000
    const d = new Date(millis)
    return Number.isNaN(d.getTime()) ? null : d
  }
  const value = String(raw).trim()
  if (!value) return null
  if (/^\d+$/.test(value)) {
    const asNum = Number(value)
    if (Number.isFinite(asNum)) {
      const millis = asNum > 1e12 ? asNum : asNum * 1000
      const d = new Date(millis)
      if (!Number.isNaN(d.getTime())) return d
    }
  }
  const direct = new Date(value)
  if (!Number.isNaN(direct.getTime())) return direct
  const br = value.match(/^(\d{2})[./-](\d{2})[./-](\d{2,4})/)
  if (!br) return null
  const year = br[3]!.length === 2 ? 2000 + Number.parseInt(br[3]!, 10) : Number.parseInt(br[3]!, 10)
  const date = new Date(year, Number.parseInt(br[2]!, 10) - 1, Number.parseInt(br[1]!, 10))
  return Number.isNaN(date.getTime()) ? null : date
}

function absoluteCopartUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (trimmed.startsWith('//')) return `https:${trimmed}`
  if (trimmed.startsWith('./')) return `https://www.copart.com.br/${trimmed.slice(2)}`
  if (trimmed.startsWith('/')) return `https://www.copart.com.br${trimmed}`
  if (trimmed.startsWith('saleListResult/')) return `https://www.copart.com.br/${trimmed}`
  return ''
}

function normalizeCopartImageUrl(url: string): string {
  if (!url) return ''
  try {
    const parsed = new URL(url)
    if (parsed.searchParams.get('imageType')?.toLowerCase() === 'thumbnail') parsed.searchParams.delete('imageType')
    return parsed.toString()
  }
  catch { return url }
}

function hasUsableImage(lot: CopartLot): boolean {
  const raw = pick(lot, ...THUMB_KEYS)
  return raw ? absoluteCopartUrl(raw) !== '' : false
}

function looksLikeLotRecord(lot: CopartLot): boolean {
  const lotNum = pick(lot, ...LOT_NUMBER_KEYS)
  const make = pick(lot, ...MAKE_KEYS)
  const model = pick(lot, ...MODEL_KEYS)
  const year = pickN(lot, ...YEAR_KEYS)
  const bid = pickN(lot, ...PRICE_KEYS, ...FIPE_KEYS)
  const damage = pick(lot, ...DAMAGE_KEYS)
  const image = pick(lot, ...THUMB_KEYS)
  let score = 0
  if (lotNum.length >= 5) score += 2
  if (make && model) score += 2; else if (make || model) score += 1
  if (year !== null) score += 1
  if (bid !== null) score += 1
  if (damage) score += 1
  if (image) score += 1
  return score >= 4
}

function collectLotRecords(obj: unknown, collector: CopartLot[], depth = 0): void {
  if (depth > 10 || !obj || typeof obj !== 'object') return
  if (Array.isArray(obj)) { for (const item of obj) collectLotRecords(item, collector, depth + 1); return }
  const rec = obj as CopartLot
  if (looksLikeLotRecord(rec)) collector.push(rec)
  for (const value of Object.values(rec)) collectLotRecords(value, collector, depth + 1)
}

function dedupeLotRecords(lots: CopartLot[]): CopartLot[] {
  const keyToIndex = new Map<string, number>()
  const unique: CopartLot[] = []
  for (const lot of lots) {
    const lotNumber = pick(lot, ...LOT_NUMBER_KEYS).replace(/\D/g, '')
    const make = normalizeToken(pick(lot, ...MAKE_KEYS))
    const model = normalizeToken(pick(lot, ...MODEL_KEYS))
    const year = String(int(pickN(lot, ...YEAR_KEYS)) ?? '')
    const key = `${lotNumber}|${make}|${model}|${year}`
    if (!lotNumber && !make && !model) continue
    const existingIndex = keyToIndex.get(key)
    if (existingIndex != null) {
      const current = unique[existingIndex]!
      const currentHasImage = hasUsableImage(current)
      const newHasImage = hasUsableImage(lot)
      if (!currentHasImage && newHasImage) unique[existingIndex] = { ...current, ...lot }
      else if (!currentHasImage && !newHasImage) unique[existingIndex] = { ...lot, ...current }
      continue
    }
    keyToIndex.set(key, unique.length)
    unique.push(lot)
  }
  return unique
}

function extractLotsFromPayloads(payloads: unknown[]): CopartLot[] {
  const found: CopartLot[] = []
  for (const payload of payloads) collectLotRecords(payload, found, 0)
  return dedupeLotRecords(found)
}

async function extractEmbeddedJsonPayloads(page: Page): Promise<unknown[]> {
  const raw = await page.$$eval("script[type='application/json']", (scripts) =>
    scripts.map((s) => s.textContent ?? '').filter(Boolean),
  ).catch(() => [])
  const parsed: unknown[] = []
  for (const text of raw) { try { parsed.push(JSON.parse(text)) } catch { /* ignore */ } }
  return parsed
}

async function detectCopartProtection(page: Page): Promise<string | null> {
  const html = await page.content().catch(() => '')
  const bodyText = (await page.textContent('body').catch(() => '')) ?? ''
  const marker = `${html}\n${bodyText}`.toLowerCase()
  const isIncapsulaHint = marker.includes('_incapsula_resource')
  const isCaptchaHint = marker.includes('captcha')
  const isAccessDeniedHint = marker.includes('access denied') || marker.includes('request unsuccessful') || marker.includes('forbidden')
  const hasCalendarContentHint = marker.includes('calendário de leilões') || marker.includes('resultados de busca') || marker.includes('mostrar') || marker.includes('dar lance')
  const saleLinkCount = await page.locator(SALE_TARGET_SELECTOR).count().catch(() => 0)
  const hasSaleLinks = saleLinkCount > 0
  const tinyPage = bodyText.trim().length < 120
  if (isIncapsulaHint && !hasSaleLinks && !hasCalendarContentHint && tinyPage) return 'incapsula'
  if (isCaptchaHint && !hasSaleLinks && !hasCalendarContentHint) return 'captcha'
  if (isAccessDeniedHint && !hasSaleLinks && !hasCalendarContentHint) return 'access denied'
  return null
}

async function detectCopartProtectionWithRetry(page: Page, log: (msg: string) => void, contextLabel: string): Promise<string | null> {
  let reason = await detectCopartProtection(page)
  if (!reason) return null
  if (reason !== 'incapsula') return reason
  log(`[copart] ${contextLabel}: provável desafio Incapsula, aguardando validação automática...`)
  await page.waitForTimeout(4_000)
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
  await page.waitForTimeout(1_500)
  return detectCopartProtection(page)
}

async function extractSaleTargetsFromCalendar(page: Page, locations: string[]): Promise<CopartSaleTarget[]> {
  const desired = locations.map((loc) => normalizeToken(loc)).filter(Boolean)
  const anchors = await page.$$eval(
    SALE_TARGET_SELECTOR,
    (els) => els.map((el) => ({ href: el.getAttribute('href') ?? '', dataUrl: el.getAttribute('data-url') ?? '', text: (el.textContent ?? '').trim() })),
  ).catch(() => [])

  const targets: CopartSaleTarget[] = []
  const seen = new Set<string>()

  for (const anchor of anchors) {
    const raw = anchor.href || anchor.dataUrl
    const abs = absoluteCopartUrl(raw)
    if (!abs) continue
    let parsed: URL
    try { parsed = new URL(abs) } catch { continue }

    const inventoryPathMatch = parsed.pathname.match(/inventory\/(\d{1,5})/i)
    const yardQueryMatch = parsed.searchParams.get('yardNum')?.match(/^\d{1,5}$/)
    const auctionPathMatch = parsed.pathname.match(/auctionId\/(\d{3,7})/i)
    const salePathMatch = parsed.pathname.match(/\/saleListResult\/(\d{3,7})(?:\/|$)/i)
    const auctionQueryMatch = parsed.searchParams.get('auctionId')?.match(/^\d{3,7}$/i)

    const queryLocation = (parsed.searchParams.get('location') ?? '').replace(/\+/g, ' ').trim()
    const labelLocation = anchor.text.replace(/\s+/g, ' ').trim()
    const location = queryLocation || labelLocation || locations[0] || FALLBACK_LOCATIONS[0]!
    const locationNorm = normalizeToken(location)

    if (desired.length > 0 && !desired.some((loc) => locationNorm.includes(loc) || loc.includes(locationNorm))) continue

    const yardNumber = inventoryPathMatch?.[1] ?? yardQueryMatch?.[0] ?? ''
    const auctionId = auctionPathMatch?.[1] ?? auctionQueryMatch?.[0] ?? salePathMatch?.[1] ?? ''
    let miscFilter = ''
    let label = ''

    if (auctionId) { miscFilter = `auction_id:${auctionId}`; label = `auction ${auctionId}` }
    else if (yardNumber) { miscFilter = `#PhysicalYardNo:${yardNumber}`; label = `inventory ${yardNumber}` }
    else continue

    const key = `${miscFilter}|${locationNorm}`
    if (seen.has(key)) continue
    seen.add(key)
    targets.push({ location, url: parsed.toString(), miscFilter, label })
  }

  return targets
}

async function fetchLotsFromCopartApi(page: Page, miscFilter: string, log: (msg: string) => void): Promise<{ lots: CopartLot[]; complete: boolean }> {
  const callApiPage = async (pageNumber: number, draw: number) => {
    const body = buildCopartSearchPostBody(miscFilter, DEFAULT_COPART_CATEGORIES, { page: pageNumber, size: COPART_PAGE_SIZE, draw })
    return page.evaluate(
      async ({ url, payload }: { url: string; payload: string }) => {
        const res = await fetch(url, { method: 'POST', headers: { Accept: 'application/json, text/javascript, */*; q=0.01', 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }, body: payload })
        const text = await res.text()
        let json = null
        try { json = JSON.parse(text) } catch { /* ignore */ }
        return { ok: res.ok, status: res.status, json, preview: text.slice(0, 220) }
      },
      { url: SEARCH_API_URL, payload: body.toString() },
    )
  }

  const firstResponse = await callApiPage(0, 1)
  if (!firstResponse.ok || !firstResponse.json) {
    log(`[copart] API /public/lots/search falhou (HTTP ${firstResponse.status}).`)
    if (firstResponse.preview) log(`[copart] API preview: ${firstResponse.preview}`)
    return { lots: [], complete: false }
  }

  const apiResult = firstResponse.json as CopartApiResult
  const totalElements = apiResult.data?.results?.totalElements ?? 0
  const allContent = [...(apiResult.data?.results?.content ?? [])]
  const pageCount = Math.ceil(totalElements / COPART_PAGE_SIZE)
  let complete = true

  if (pageCount > 1) log(`[copart] API totalElements=${totalElements}; coletando ${pageCount} páginas de até ${COPART_PAGE_SIZE}.`)

  for (let pageNumber = 1; pageNumber < pageCount; pageNumber += 1) {
    const response = await callApiPage(pageNumber, pageNumber + 1)
    if (!response.ok || !response.json) {
      complete = false
      log(`[copart] API página ${pageNumber + 1}/${pageCount} falhou (HTTP ${response.status}).`)
      if (response.preview) log(`[copart] API preview: ${response.preview}`)
      continue
    }

    const pageResult = response.json as CopartApiResult
    const content = pageResult.data?.results?.content ?? []
    allContent.push(...content)
  }

  const mapped: CopartLot[] = allContent.map((item) => ({
    ...item,
    lotNumberStr: item.lotNumberStr ?? item.ln,
    lotNumber: item.lotNumberStr ?? item.ln,
    mkn: item.mkn, make: item.mkn, lm: item.lm, model: item.lm,
    year: item.lcy ?? item.manufactureYear,
    currentHighBid: item.hb ?? item.ahb ?? null,
    actualBid: item.ahb ?? null,
    fipeValue: item.la,
    damageDescription: item.dd ?? item.lossType,
    thumbnailImage: item.tims,
    auction_date_utc: item.ad,
    description: item.ld,
    yardName: item.yn,
    saleName: item.syn,
    drivabilityRating: item.drivabilityRating,
    vehicleType: item.vehicleType,
    damageClassification: item.damageClassification,
  }))

  log(`[copart] API /public/lots/search retornou ${mapped.length}/${totalElements} lote(s).`)
  return { lots: mapped, complete: complete && mapped.length >= totalElements }
}

async function setCopartPageSizePreference(context: BrowserContext, log: (msg: string) => void): Promise<void> {
  try {
    await context.addCookies([{ name: 'g2app.searchResultsPageLength', value: String(COPART_PAGE_SIZE), domain: '.copart.com.br', path: '/', secure: true, httpOnly: false, sameSite: 'Lax' }])
    log(`[copart] Preferência de paginação configurada: ${COPART_PAGE_SIZE}/página.`)
  }
  catch (error) { log(`[copart] Aviso: não foi possível configurar paginação (${error instanceof Error ? error.message : String(error)}).`) }
}

function pushAuctionId(ids: number[], value: unknown): void {
  const parsed = int(value)
  if (parsed === null || parsed < 1000) return
  if (!ids.includes(parsed)) ids.push(parsed)
}

function findAuctionIdsForLocations(obj: unknown, locations: string[], depth = 0): number[] {
  if (depth > 8 || !obj || typeof obj !== 'object') return []
  const ids: number[] = []
  const locationNeedles = locations.map((loc) => normalizeToken(loc)).filter(Boolean)
  if (Array.isArray(obj)) { for (const item of obj) ids.push(...findAuctionIdsForLocations(item, locations, depth + 1)); return ids }
  const rec = obj as Record<string, unknown>
  const serialized = normalizeToken(JSON.stringify(obj))
  const hasLocation = locationNeedles.length === 0 ? true : locationNeedles.some((needle) => serialized.includes(needle))
  if (hasLocation) {
    for (const [k, v] of Object.entries(rec)) {
      const key = k.toLowerCase()
      if (key === 'auctionid' || key === 'auction_id' || key === 'id') pushAuctionId(ids, v)
    }
  }
  for (const v of Object.values(rec)) ids.push(...findAuctionIdsForLocations(v, locations, depth + 1))
  return uniqueNumbers(ids)
}

async function run(
  filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const locations = getLocations(filters)
  const profilePath = process.env.COPART_PROFILE_PATH?.trim() || DEFAULT_PROFILE_PATH
  const headless = options?.headless ?? true

  log('[copart] Iniciando...')
  log(`[copart] Perfil: ${profilePath}`)
  log(`[copart] Localidades alvo: ${locations.join(', ') || '(todas)'}`)

  const context: BrowserContext = await chromium.launchPersistentContext(profilePath, {
    ...buildPlaywrightLaunchOptions(headless),
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'pt-BR',
  })
  const page = context.pages()[0] ?? await context.newPage()
  const results: RawScrapedVehicle[] = []
  const seenVehicleKeys = new Set<string>()
  let hasPartialCollection = false
  let skippedLargeDamageTotal = 0

  try {
    await setCopartPageSizePreference(context, log)

    const calJson: unknown[] = []
    const calendarHandler = async (r: Response) => {
      if ((r.headers()['content-type'] ?? '').includes('json')) {
        try { calJson.push(await r.json()) } catch { /* ignore */ }
      }
    }
    page.on('response', calendarHandler)
    await page.goto(CALENDAR_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    await page.waitForTimeout(2_000)
    page.off('response', calendarHandler)

    const protectionReason = await detectCopartProtectionWithRetry(page, log, 'calendário')
    if (protectionReason) {
      log(`[copart] Bloqueio detectado (${protectionReason}). Abra a Copart com o perfil configurado e complete login/captcha; depois rode novamente.`)
      return []
    }

    let saleTargets = await extractSaleTargetsFromCalendar(page, locations)
    if (saleTargets.length > 0) log(`[copart] Links do calendário: ${saleTargets.length} alvo(s): ${saleTargets.map((t) => `${t.label} (${t.location})`).join(' | ')}`)

    const auctionIds: number[] = []

    const hrefs: string[] = await page.$$eval('a[href]', (els) => els.map((e) => e.getAttribute('href') ?? '')).catch(() => [])
    for (const href of hrefs) {
      for (const match of href.matchAll(/(?:auctionId\/|saleListResult\/)(\d{3,7})/gi)) pushAuctionId(auctionIds, match[1])
      const q = href.match(/[?&]auctionId=(\d{3,7})/i)
      if (q) pushAuctionId(auctionIds, q[1])
    }

    if (auctionIds.length === 0) {
      const embedded: string | null = await page.evaluate(() => {
        const el = document.getElementById('__NEXT_DATA__') ?? document.querySelector("script[type='application/json']")
        return el?.textContent ?? null
      }).catch(() => null)
      if (embedded) {
        try { const parsed = JSON.parse(embedded); auctionIds.push(...findAuctionIdsForLocations(parsed, locations)) } catch { /* ignore */ }
      }
    }

    if (auctionIds.length === 0) {
      for (const json of calJson) auctionIds.push(...findAuctionIdsForLocations(json, locations))
    }

    if (auctionIds.length === 0 && calJson.length > 0) {
      log('[copart] Fallback: coletando todos auction IDs das respostas...')
      const allSerialized = JSON.stringify(calJson)
      const matches = [...allSerialized.matchAll(/"(?:auctionId|auction_id)"\s*:\s*(\d{4,6})/g)]
      for (const m of matches) pushAuctionId(auctionIds, m[1])
    }

    const uniqueAuctionIds = uniqueNumbers(auctionIds)
    if (saleTargets.length === 0) {
      log(`[copart] calJson recebidos: ${calJson.length} | IDs encontrados: ${uniqueAuctionIds.join(', ') || 'nenhum'}`)
      saleTargets = uniqueAuctionIds.map((auctionId) => ({
        location: locations[0] ?? FALLBACK_LOCATIONS[0]!,
        url: buildSearchUrl(`auction_id:${auctionId}`, locations[0] ?? FALLBACK_LOCATIONS[0]!),
        miscFilter: `auction_id:${auctionId}`,
        label: `auction ${auctionId}`,
      }))
    }

    if (saleTargets.length === 0) { log('[copart] Nenhum leilão/target encontrado no calendário.'); return [] }

    for (const target of saleTargets) {
      const targetLabel = `${target.label} (${target.location})`
      let skippedLargeDamageByTarget = 0
      const intercepted: unknown[] = []
      const lotHandler = async (r: Response) => {
        if ((r.headers()['content-type'] ?? '').includes('json')) {
          try { intercepted.push(await r.json()) } catch { /* ignore */ }
        }
      }
      page.on('response', lotHandler)
      const searchUrl = withSearchCriteria(target.url, buildSearchCriteria(target.miscFilter))
      log(`[copart] Acessando ${targetLabel}...`)
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
      await page.waitForTimeout(3_000)
      page.off('response', lotHandler)

      const lotProtectionReason = await detectCopartProtectionWithRetry(page, log, targetLabel)
      if (lotProtectionReason) { log(`[copart] ${targetLabel}: bloqueio detectado (${lotProtectionReason}), pulando.`); continue }

      const apiResult = await fetchLotsFromCopartApi(page, target.miscFilter, log)
      if (!apiResult.complete) hasPartialCollection = true
      const embeddedPayloads = await extractEmbeddedJsonPayloads(page)
      const inferredLots = extractLotsFromPayloads([...intercepted, ...embeddedPayloads])
      const lots = dedupeLotRecords([...apiResult.lots, ...inferredLots])

      log(`[copart] intercepted JSONs: ${intercepted.length} | embedded JSONs: ${embeddedPayloads.length} | API lots: ${apiResult.lots.length} | lotes candidatos: ${lots.length}`)
      if (lots.length === 0) continue

      const sample = lots[0]!
      log(`[copart] Campos do lote: ${Object.keys(sample).join(', ')}`)
      log(`[copart] Sample: ${JSON.stringify(sample).slice(0, 400)}`)

      for (const lot of lots) {
        const titleRaw = pick(lot, 'title', 'description', 'lotTitle', 'vehicleTitle', 'lotDescription')
        const titleMakeModel = parseMakeModelFromTitle(titleRaw)
        const makeRaw = (pick(lot, ...MAKE_KEYS) || titleMakeModel.make).toUpperCase()
        const modelRaw = pick(lot, ...MODEL_KEYS) || titleMakeModel.model
        const yearRaw = pickN(lot, ...YEAR_KEYS) ?? pickYearFromTitle(titleRaw)
        const year = yearRaw ? Math.round(yearRaw) : null
        const rawBid = pickN(lot, ...PRICE_KEYS)
        const currentBid = rawBid !== null && rawBid > 0 ? rawBid : null
        const fipe = pickN(lot, ...FIPE_KEYS)
        const thumbRaw = pick(lot, ...THUMB_KEYS)
        const lotNumRaw = pick(lot, ...LOT_NUMBER_KEYS)
        const lotNum = lotNumRaw.replace(/[^\dA-Za-z]/g, '')
        const damageRaw = pick(lot, ...DAMAGE_KEYS)
        const damageClassificationRaw = pick(lot, 'damageClassification', 'classificacaodano')
        const kmRaw = pickN(lot, ...KM_KEYS)
        const colorRaw = pick(lot, ...COLOR_KEYS)
        const yardRaw = pick(lot, ...YARD_KEYS)
        const dateRaw = DATE_KEYS.map((k) => lot[k]).find((v) => v != null)
        const auctionDate = parseAuctionDate(dateRaw)

        const damageParts = [damageRaw.trim(), damageClassificationRaw.trim()]
          .filter((part) => part.length > 0)
          .filter((part, idx, arr) => arr.findIndex((candidate) => normalizeToken(candidate) === normalizeToken(part)) === idx)
        const damageDisplay = damageParts.join(' - ')
        const largeDamageText = [damageDisplay, damageRaw, damageClassificationRaw, titleRaw]
          .filter(Boolean)
          .join(' | ')
        if (isLargeDamageCopart(largeDamageText)) {
          skippedLargeDamageByTarget += 1
          skippedLargeDamageTotal += 1
          continue
        }
        const auctionStatusRaw = extractCopartAuctionStatusRaw(lot)
        const auctionStatus = normalizeCopartAuctionStatus(auctionStatusRaw) ?? 'upcoming'
        const saleStatusRaw = extractCopartSaleStatusRaw(lot)
        const saleStatus = normalizeCopartSaleStatus(saleStatusRaw) ?? 'unknown'

        const lotUrl = lotNum ? `https://www.copart.com.br/lot/${lotNum}` : searchUrl
        const dedupeKey = lotNum || lotUrl
        if (seenVehicleKeys.has(dedupeKey)) continue
        seenVehicleKeys.add(dedupeKey)

        const thumbAbsolute = absoluteCopartUrl(thumbRaw)
        const thumb = normalizeCopartImageUrl(thumbAbsolute)
        const imageUrls = thumb ? (thumb !== thumbAbsolute && thumbAbsolute ? [thumb, thumbAbsolute] : [thumb]) : []
        const km = kmRaw && kmRaw > 0 ? Math.round(kmRaw).toLocaleString('pt-BR') : null
        const fipeRounded = fipe !== null ? Math.round(fipe) : null
        const fipeRaw = fipeRounded !== null ? `R$ ${fipeRounded.toLocaleString('pt-BR')}` : null

        results.push({
          source: 'copart',
          brand: (makeRaw || 'UNKNOWN').trim() || 'UNKNOWN',
          model: modelRaw,
          year,
          damage: damageDisplay || null,
          price: currentBid !== null ? Math.round(currentBid) : null,
          priceRaw: currentBid !== null ? `R$ ${Math.round(currentBid).toLocaleString('pt-BR')}` : null,
          imageUrls,
          description: [damageRaw, colorRaw, titleRaw].filter(Boolean).join(' · ').slice(0, 200),
          url: lotUrl,
          auctionDate,
          lot: lotNum || null,
          auctionStatus,
          auctionStatusRaw,
          saleStatus,
          saleStatusRaw,
          soldPrice: saleStatus === 'sold' ? (currentBid !== null ? Math.round(currentBid) : null) : null,
          soldPriceRaw: saleStatus === 'sold' && currentBid !== null ? `R$ ${Math.round(currentBid).toLocaleString('pt-BR')}` : null,
          km,
          color: colorRaw || null,
          yard: yardRaw.trim() || null,
          fipe: fipeRounded,
          fipeRaw,
        })
      }

      if (skippedLargeDamageByTarget > 0) log(`[copart] ${targetLabel}: ${skippedLargeDamageByTarget} lote(s) ignorado(s) por grande monta/sucata.`)
    }
  }
  finally {
    await context.close()
  }

  if (skippedLargeDamageTotal > 0) log(`[copart] ${skippedLargeDamageTotal} lote(s) descartado(s) por grande monta/sucata.`)
  log(`[copart] Total: ${results.length} veículo(s).`)
  if (hasPartialCollection) {
    throw new PartialScraperResultError('[copart] coleta parcial; uma ou mais páginas da API falharam.', results)
  }
  return results
}

export const copartSource: ScraperSource = {
  id: 'copart',
  name: 'Copart',
  run,
}
