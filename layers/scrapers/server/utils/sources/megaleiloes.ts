import { load } from 'cheerio'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperSource } from '../source-types'

const BASE_URL = 'https://www.megaleiloes.com.br'
const START_URL = `${BASE_URL}/veiculos/carros?tov=igbr&valor_max=5000000&tipo%5B0%5D=1&tipo%5B1%5D=2&tipo%5B2%5D=3`
const REQUEST_DELAY_MS = 350
const DEFAULT_MAX_PAGES = 6
const HARD_MAX_PAGES = 30

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

const BRAND_ALIASES: Record<string, string> = {
  VW: 'VOLKSWAGEN', VOLKS: 'VOLKSWAGEN', CHEV: 'CHEVROLET', GM: 'CHEVROLET',
  MERCEDES: 'MERCEDES-BENZ', 'M BENZ': 'MERCEDES-BENZ',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseMaxPagesFromEnv(): number {
  const raw = Number.parseInt((process.env.MEGALEILOES_MAX_PAGES ?? '').trim(), 10)
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_PAGES
  return Math.max(1, Math.min(HARD_MAX_PAGES, raw))
}

function toAbsoluteUrl(url: string | null | undefined): string {
  const value = (url ?? '').trim()
  if (!value) return ''
  if (value.startsWith('http://') || value.startsWith('https://')) return value
  if (value.startsWith('//')) return `https:${value}`
  if (value.startsWith('/')) return `${BASE_URL}${value}`
  return `${BASE_URL}/${value}`
}

function normalizeBrandToken(raw: string): string {
  const cleaned = raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()
  return BRAND_ALIASES[cleaned] ?? cleaned
}

function cleanupTitle(raw: string): string {
  return raw.replace(/\s+/g, ' ')
    .replace(/^(?:DIREITOS?\s+SOBRE\s+)?(?:VE[IÍ]CULO|CARRO|CAMINHONETE|UTILIT[ÁA]RIO|MOTO|MOTOCICLETA|ÔNIBUS|CAMINH[AÃ]O)\s+/i, '')
    .replace(/\s+\(LOTE[^)]*\)\s*$/i, '').trim()
}

function parseBrandAndModel(titleRaw: string): { brand: string; model: string } {
  const cleaned = cleanupTitle(titleRaw)
  const base = cleaned.split(/\s+-\s+/)[0]?.trim() ?? cleaned
  const tokens = base.replace(/[.,]/g, ' ').split(/\s+/).map((t) => t.trim()).filter(Boolean)
  if (tokens.length === 0) return { brand: 'UNKNOWN', model: cleaned.toUpperCase() || 'SEM MODELO' }

  const first = normalizeBrandToken(tokens[0] ?? '')
  const second = normalizeBrandToken(tokens[1] ?? '')
  const dual = normalizeBrandToken(`${tokens[0]} ${tokens[1] ?? ''}`)

  if (BRAND_ALIASES[dual]) {
    const modelDual = tokens.slice(2).join(' ').trim()
    return { brand: BRAND_ALIASES[dual]!, model: (modelDual || tokens.slice(1).join(' ') || base).toUpperCase() }
  }
  if (first === 'MERCEDES' && second === 'BENZ') {
    return { brand: 'MERCEDES-BENZ', model: (tokens.slice(2).join(' ').trim() || base).toUpperCase() }
  }
  const model = tokens.slice(1).join(' ').trim()
  return { brand: first || 'UNKNOWN', model: (model || base).toUpperCase() }
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const text = raw.replace(/\s+/g, ' ').trim()
  const match = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i)
  if (!match) return { price: null, priceRaw: null }
  const numericText = match[1]!
  const parsed = Number.parseFloat(numericText.replace(/\./g, '').replace(',', '.'))
  return { price: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null, priceRaw: `R$ ${numericText}` }
}

function parseYear(raw: string): number | null {
  const match = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:\d{2,4})\b/)
  if (match) return Number.parseInt(match[1]!, 10)
  const allYears = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)]
  if (allYears.length === 0) return null
  const first = allYears[0]?.[1]
  const parsed = first ? Number.parseInt(first, 10) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

function parseDatePtBr(raw: string): Date | null {
  const match = raw.match(/(\d{2})\/(\d{2})\/(\d{4})/)
  if (!match) return null
  const d = Number.parseInt(match[1]!, 10), m = Number.parseInt(match[2]!, 10), y = Number.parseInt(match[3]!, 10)
  const parsed = new Date(y, m - 1, d)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function parseTotalPages(html: string): number {
  const $ = load(html)
  const summary = $('.summary').first().text().replace(/\s+/g, ' ').trim()
  const summaryMatch = summary.match(/P[áa]gina\s*(\d+)\s*de\s*(\d+)/i)
  if (summaryMatch) {
    const total = Number.parseInt(summaryMatch[2]!, 10)
    if (Number.isFinite(total) && total > 0) return total
  }
  let maxFromHref = 1
  $('a[href*="pagina="]').each((_i, el) => {
    const href = $(el).attr('href') ?? ''
    const match = href.match(/[?&]pagina=(\d+)/i)
    if (!match) return
    const page = Number.parseInt(match[1]!, 10)
    if (Number.isFinite(page) && page > maxFromHref) maxFromHref = page
  })
  if (maxFromHref > 1) return maxFromHref
  const allPages = [...html.matchAll(/[?&]pagina=(\d+)/gi)].map((m) => Number.parseInt(m[1]!, 10)).filter((n) => Number.isFinite(n) && n > 0)
  return allPages.length === 0 ? 1 : Math.max(...allPages)
}

function buildPageUrl(page: number): string {
  if (page <= 1) return START_URL
  const url = new URL(START_URL)
  url.searchParams.set('pagina', String(page))
  return url.toString()
}

function parseCards(html: string, log: (msg: string) => void): RawScrapedVehicle[] {
  const $ = load(html)
  const out: RawScrapedVehicle[] = []
  const seen = new Set<string>()

  $('.card .card-title').each((_i, el) => {
    const titleEl = $(el)
    const card = titleEl.closest('.card')
    if (!card || card.length === 0) return

    const titleRaw = titleEl.text().replace(/\s+/g, ' ').trim()
    if (!titleRaw) return

    const href = titleEl.attr('href') ?? card.find('a.card-image').first().attr('href') ?? ''
    const url = toAbsoluteUrl(href)
    if (!url || seen.has(url)) return
    seen.add(url)

    const { brand, model } = parseBrandAndModel(titleRaw)
    const year = parseYear(titleRaw)
    const priceInfo = parsePrice(card.find('.card-price').first().text())
    const lot = card.find('.card-number').first().text().replace(/\s+/g, ' ').trim() || undefined
    const yard = card.find('.card-locality').first().text().replace(/\s+/g, ' ').trim() || null
    const dateText = card.find('.card-second-instance-date, .card-first-instance-date').first().text().replace(/\s+/g, ' ').trim()

    const imageRaw = card.find('a.card-image').first().attr('data-bg')
      ?? card.find('a.card-image').first().attr('style')
      ?? card.find('img').first().attr('src') ?? ''
    const imageStyleMatch = imageRaw.match(/url\(([^)]+)\)/i)
    const imageUrl = toAbsoluteUrl((imageStyleMatch?.[1] ?? imageRaw).replace(/^['"]|['"]$/g, ''))

    out.push({
      source: 'megaleiloes',
      brand,
      model,
      year,
      damage: null,
      price: priceInfo.price,
      priceRaw: priceInfo.priceRaw,
      imageUrls: imageUrl ? [imageUrl] : [],
      description: [titleRaw, dateText].filter(Boolean).join(' · ').slice(0, 240),
      url,
      auctionDate: parseDatePtBr(dateText),
      lot,
      yard,
      fipe: null,
    })
  })

  log(`[megaleiloes] ${out.length} lote(s) extraído(s) nesta página.`)
  return out
}

async function fetchHtml(url: string, log: (msg: string) => void): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: HEADERS })
    if (!response.ok) { log(`[megaleiloes] HTTP ${response.status} em ${url}`); return null }
    return await response.text()
  }
  catch (error) {
    log(`[megaleiloes] Erro em ${url}: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function run(
  _filters: AuctionFilters,
  options?: { log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const maxPages = parseMaxPagesFromEnv()
  const all: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()

  log('[megaleiloes] Iniciando...')
  const firstHtml = await fetchHtml(buildPageUrl(1), log)
  if (!firstHtml) { log('[megaleiloes] Falha ao carregar página inicial.'); return [] }

  const discoveredPages = parseTotalPages(firstHtml)
  const totalPages = Math.max(1, Math.min(discoveredPages, maxPages))
  log(`[megaleiloes] Página(s): total=${discoveredPages} | limite=${maxPages} | varrendo=${totalPages}.`)

  for (const vehicle of parseCards(firstHtml, log)) {
    if (seenUrls.has(vehicle.url)) continue
    seenUrls.add(vehicle.url); all.push(vehicle)
  }

  for (let page = 2; page <= totalPages; page += 1) {
    const pageUrl = buildPageUrl(page)
    log(`[megaleiloes] Página ${page}/${totalPages}: ${pageUrl}`)
    const html = await fetchHtml(pageUrl, log)
    if (!html) continue
    for (const vehicle of parseCards(html, log)) {
      if (seenUrls.has(vehicle.url)) continue
      seenUrls.add(vehicle.url); all.push(vehicle)
    }
    await sleep(REQUEST_DELAY_MS)
  }

  log(`[megaleiloes] Total: ${all.length} veículo(s).`)
  return all
}

export const megaleiloesSource: ScraperSource = {
  id: 'megaleiloes',
  name: 'Mega Leilões',
  run,
}
