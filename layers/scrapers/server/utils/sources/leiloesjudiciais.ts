import { load } from 'cheerio'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperSource } from '../source-types'

const BASE_URL = 'https://www.leiloesjudiciais.com.br'
const LIST_URL = `${BASE_URL}/veiculos/carros`
const REQUEST_DELAY_MS = 300
const DEFAULT_MAX_PAGES = 6
const HARD_MAX_PAGES = 40

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

const BRAND_ALIASES: Record<string, string> = {
  VW: 'VOLKSWAGEN', VOLKS: 'VOLKSWAGEN', CHEV: 'CHEVROLET', GM: 'CHEVROLET',
  'M BENZ': 'MERCEDES-BENZ', 'MERCEDES BENZ': 'MERCEDES-BENZ',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseMaxPagesFromEnv(): number {
  const raw = Number.parseInt((process.env.LEILOESJUDICIAIS_MAX_PAGES ?? '').trim(), 10)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PAGES
  return Math.max(1, Math.min(HARD_MAX_PAGES, raw))
}

function toAbsoluteUrl(value: string | null | undefined): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  if (text.startsWith('http://') || text.startsWith('https://')) return text
  if (text.startsWith('//')) return `https:${text}`
  if (text.startsWith('/')) return `${BASE_URL}${text}`
  return `${BASE_URL}/${text}`
}

function normalizeBrandToken(raw: string): string {
  const cleaned = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  return BRAND_ALIASES[cleaned] ?? cleaned
}

function parseBrandModelFromTitle(titleRaw: string): { brand: string; model: string } {
  const normalized = titleRaw.replace(/\s+/g, ' ').replace(/^I\//i, '').replace(/^IMP\//i, '').trim()
  const mainChunk = normalized.split(/\s+-\s+/)[0]?.trim() ?? normalized
  const cleanedMain = mainChunk.replace(/\bM\.?\s*BENZ\b/gi, 'MERCEDES-BENZ').replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim()

  if (!cleanedMain) return { brand: 'UNKNOWN', model: 'SEM MODELO' }

  if (cleanedMain.includes('/')) {
    const [rawBrand, rawModel] = cleanedMain.split('/', 2) as [string, string | undefined]
    return { brand: normalizeBrandToken(rawBrand) || 'UNKNOWN', model: (rawModel?.trim() || cleanedMain).toUpperCase() }
  }

  const tokens = cleanedMain.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { brand: 'UNKNOWN', model: cleanedMain.toUpperCase() || 'SEM MODELO' }

  const first = normalizeBrandToken(tokens[0] ?? '')
  const dual = normalizeBrandToken(`${tokens[0]} ${tokens[1] ?? ''}`)
  if (BRAND_ALIASES[dual] || (first === 'MERCEDES' && normalizeBrandToken(tokens[1] ?? '') === 'BENZ')) {
    return { brand: BRAND_ALIASES[dual] ?? 'MERCEDES-BENZ', model: (tokens.slice(2).join(' ') || cleanedMain).toUpperCase() }
  }
  return { brand: first || 'UNKNOWN', model: (tokens.slice(1).join(' ') || cleanedMain).toUpperCase() }
}

function parseMoney(raw: string): { value: number | null; text: string | null } {
  const value = raw.replace(/\s+/g, ' ').trim()
  const match = value.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i)
  if (!match) return { value: null, text: null }
  const numeric = match[1]!
  const parsed = Number.parseFloat(numeric.replace(/\./g, '').replace(',', '.'))
  return { value: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null, text: `R$ ${numeric}` }
}

function parseYear(raw: string): number | null {
  const match = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:\d{2,4})\b/)
  if (match) return Number.parseInt(match[1]!, 10)
  const years = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)]
  if (years.length === 0) return null
  const parsed = Number.parseInt(years[0]?.[1] ?? '', 10)
  return Number.isFinite(parsed) ? parsed : null
}

function parseDatePtBr(raw: string | null | undefined): Date | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!match) return null
  const d = Number.parseInt(match[1]!, 10), m = Number.parseInt(match[2]!, 10), y = Number.parseInt(match[3]!, 10)
  const parsed = new Date(y, m - 1, d)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function normalizeLabel(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function parseTotalPages(html: string): number {
  const pageNumbers = [...html.matchAll(/\/veiculos\/carros\?pagina=(\d+)/gi)]
    .map((m) => Number.parseInt(m[1]!, 10)).filter((v) => Number.isFinite(v) && v > 0)
  if (pageNumbers.length > 0) return Math.max(...pageNumbers)
  const pagerMatch = html.match(/>(\d+)\s*de\s*(\d+)</i)
  if (pagerMatch) {
    const total = Number.parseInt(pagerMatch[2]!, 10)
    if (Number.isFinite(total) && total > 0) return total
  }
  return 1
}

function parseCards(html: string, log: (msg: string) => void): RawScrapedVehicle[] {
  const $ = load(html)
  const out: RawScrapedVehicle[] = []
  const seen = new Set<string>()

  $('a.card-lote-leilao').each((_i, el) => {
    const anchor = $(el)
    const wrapper = anchor.closest('.base-card')
    if (!wrapper || wrapper.length === 0) return

    const href = anchor.attr('href') ?? ''
    const url = toAbsoluteUrl(href)
    if (!url || seen.has(url)) return
    seen.add(url)

    const title = wrapper.find('.card-header span').first().text().replace(/\s+/g, ' ').trim()
    if (!title) return

    const lot = wrapper.find('.numero-lote').first().text().replace(/\s+/g, ' ').replace(/^#/, '').trim() || undefined
    const yard = wrapper.find('.cidade-estado span').first().text().replace(/\s+/g, ' ').trim() || null
    const imageUrl = toAbsoluteUrl(wrapper.find('img.imagem__lote').first().attr('src') ?? '')

    let appraisalValue: number | null = null
    let appraisalText: string | null = null
    let minBidValue: number | null = null
    let minBidText: string | null = null
    let initialBidValue: number | null = null
    let initialBidText: string | null = null
    let currentBidValue: number | null = null
    let currentBidText: string | null = null

    wrapper.find('.label-valor').each((_rowIndex, rowNode) => {
      const row = $(rowNode)
      const spans = row.find('span')
      if (spans.length < 2) return
      const label = normalizeLabel(spans.eq(0).text())
      const parsed = parseMoney(spans.eq(1).text())
      if (!parsed.text) return
      if (label.includes('lance atual')) { currentBidValue = parsed.value; currentBidText = parsed.text }
      else if (label.includes('lance minimo')) { minBidValue = parsed.value; minBidText = parsed.text }
      else if (label.includes('lance inicial') || label.includes('primeiro leilao') || label.includes('segundo leilao')) { initialBidValue = parsed.value; initialBidText = parsed.text }
      else if (label.includes('avaliacao')) { appraisalValue = parsed.value; appraisalText = parsed.text }
    })

    const finalPrice = currentBidValue != null && currentBidValue > 0 ? currentBidValue
      : minBidValue != null && minBidValue > 0 ? minBidValue
        : initialBidValue != null && initialBidValue > 0 ? initialBidValue : null
    const finalPriceText = currentBidValue != null && currentBidValue > 0 ? currentBidText
      : minBidText ?? initialBidText ?? null

    const { brand, model } = parseBrandModelFromTitle(title)
    const dateCandidate = wrapper.text().match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] ?? null
    const damage = title.match(/\b(sucata|batid[oa]|sinistrad[oa])\b/i)?.[0] ?? null

    out.push({
      source: 'leiloesjudiciais',
      brand: brand || 'UNKNOWN',
      model: model || 'SEM MODELO',
      year: parseYear(title),
      damage,
      price: finalPrice,
      priceRaw: finalPriceText,
      imageUrls: imageUrl ? [imageUrl] : [],
      description: [title, yard, appraisalText ? `Avaliação: ${appraisalText}` : null].filter(Boolean).join(' · ').slice(0, 260),
      url,
      auctionDate: parseDatePtBr(dateCandidate),
      lot,
      yard,
      fipe: null,
    })
  })

  log(`[leiloesjudiciais] ${out.length} lote(s) extraído(s) nesta página.`)
  return out
}

async function fetchHtml(url: string, log: (msg: string) => void): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: HEADERS })
    if (!response.ok) { log(`[leiloesjudiciais] HTTP ${response.status} em ${url}`); return null }
    return await response.text()
  }
  catch (error) {
    log(`[leiloesjudiciais] Erro em ${url}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

function buildPageUrl(page: number): string {
  if (page <= 1) return LIST_URL
  const url = new URL(LIST_URL)
  url.searchParams.set('pagina', String(page))
  return url.toString()
}

async function run(
  _filters: AuctionFilters,
  options?: { log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const maxPages = parseMaxPagesFromEnv()
  const all: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()

  log('[leiloesjudiciais] Iniciando...')
  const firstHtml = await fetchHtml(buildPageUrl(1), log)
  if (!firstHtml) { log('[leiloesjudiciais] Falha ao carregar página inicial.'); return [] }

  const discoveredPages = parseTotalPages(firstHtml)
  const totalPages = Math.max(1, Math.min(discoveredPages, maxPages))
  log(`[leiloesjudiciais] Página(s): total=${discoveredPages} | limite=${maxPages} | varrendo=${totalPages}.`)

  for (const vehicle of parseCards(firstHtml, log)) {
    if (seenUrls.has(vehicle.url)) continue
    seenUrls.add(vehicle.url); all.push(vehicle)
  }

  for (let page = 2; page <= totalPages; page += 1) {
    const pageUrl = buildPageUrl(page)
    log(`[leiloesjudiciais] Página ${page}/${totalPages}: ${pageUrl}`)
    const html = await fetchHtml(pageUrl, log)
    if (!html) continue
    for (const vehicle of parseCards(html, log)) {
      if (seenUrls.has(vehicle.url)) continue
      seenUrls.add(vehicle.url); all.push(vehicle)
    }
    await sleep(REQUEST_DELAY_MS)
  }

  log(`[leiloesjudiciais] Total: ${all.length} veículo(s).`)
  return all
}

export const leiloesJudiciaisSource: ScraperSource = {
  id: 'leiloesjudiciais',
  name: 'Leilões Judiciais',
  run,
}
