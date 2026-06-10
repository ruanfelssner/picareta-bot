import { load } from 'cheerio'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperSource } from '../source-types'

const BASE_URL = 'https://lucineiautomoveis.com.br'
const SEARCH_URL = `${BASE_URL}/BuscadorVeiculo.aspx`
const LUCINEI_YARD = 'Ribeirão Preto - SP'
const DEFAULT_MAX_PAGES = 20
const HARD_MAX_PAGES = 50
const PAGE_DELAY_MS = 500
const DEFAULT_FETCH_TIMEOUT_MS = 15_000

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

function clampPositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function buildPageUrl(page: number): string {
  return page <= 1 ? SEARCH_URL : `${SEARCH_URL}?pag=${page}`
}

function toAbsoluteUrl(raw: string | null | undefined): string | null {
  const value = normalizeSpace(raw)
  if (!value) return null
  try {
    return new URL(value.replace(/^~\//, '/'), `${BASE_URL}/`).toString()
  }
  catch {
    return null
  }
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const match = raw.match(/R\$\s*([\d.]+(?:,\d{2})?)/i)
  if (!match?.[1]) return { price: null, priceRaw: null }
  const priceRaw = `R$ ${match[1]}`
  const numeric = Number.parseFloat(match[1].replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(numeric) || numeric <= 0) return { price: null, priceRaw }
  return { price: Math.round(numeric), priceRaw }
}

function parseYear(raw: string): number | null {
  const match = raw.match(/\b((?:19|20)\d{2})\s*\/\s*((?:19|20)\d{2})\b/)
  if (match?.[1]) return Number.parseInt(match[1], 10)
  const fallback = raw.match(/\b((?:19|20)\d{2})\b/)
  return fallback?.[1] ? Number.parseInt(fallback[1], 10) : null
}

function parseLot(raw: string): string | undefined {
  return raw.match(/C[oó]d\.?\s*:\s*([0-9]+)/i)?.[1]
}

function parseBrand(raw: string): string {
  const match = raw.match(/Marca\s*:\s*(.+?)(?=\s+Ano\s*:|$)/i)
  return normalizeSpace(match?.[1]).trim() || 'UNKNOWN'
}

function normalizeDamage(raw: string | null | undefined): string | null {
  const value = normalizeSpace(raw)
  if (!value) return null
  return value.replace(/\s*-\s*/g, '-').replace(/\bmonta\b/gi, 'monta').trim()
}

function upgradeImageUrlQuality(url: string): string {
  return url.replace(/-(\d+)b(\.[a-z0-9]+)$/i, '-$1c$2')
}

function pickImageUrl(raw: string | null | undefined): string[] {
  const url = toAbsoluteUrl(raw)
  if (!url) return []
  if (/imagem-n-disponivel/i.test(url)) return []
  return [upgradeImageUrlQuality(url)]
}

async function fetchHtml(url: string, log: (message: string) => void): Promise<string | null> {
  const timeoutMs = clampPositiveInt(
    process.env.LUCINEI_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
    5_000,
    60_000,
  )
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal })
    if (!response.ok) { log(`[lucinei] HTTP ${response.status} em ${url}`); return null }
    return response.text()
  }
  catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? `timeout após ${Math.round(timeoutMs / 1000)}s`
      : (error instanceof Error ? error.message : String(error))
    log(`[lucinei] Erro ao buscar ${url}: ${reason}`)
    return null
  }
  finally {
    clearTimeout(timeout)
  }
}

function parsePaginationPages(html: string): number[] {
  const $ = load(html)
  const pages = new Set<number>()
  $('a[href*="pag="]').each((_index, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      const url = new URL(href, `${BASE_URL}/`)
      const page = Number.parseInt(url.searchParams.get('pag') ?? '', 10)
      if (Number.isFinite(page) && page > 0) pages.add(page)
    }
    catch { /* ignore */ }
  })
  return [...pages].sort((a, b) => a - b)
}

function parseCards(html: string, log: (message: string) => void): RawScrapedVehicle[] {
  const $ = load(html)
  const vehicles: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()

  function looksLikeVehicleContainer(text: string): boolean {
    return /Marca\s*:/i.test(text) && /C[oó]d\.?\s*:/i.test(text) && /R\$\s*[\d.]+/i.test(text)
  }

  function isTitleCandidate(raw: string): boolean {
    const text = normalizeSpace(raw)
    if (!text) return false
    if (/^R\$/i.test(text) || /^VER MAIS$/i.test(text)) return false
    if (/^(?:pequena|m[eé]dia)\s*-?\s*monta$/i.test(text) || /^sucata$/i.test(text)) return false
    if (/^(?:marca|ano|c[oó]d)\s*:/i.test(text)) return false
    return /[a-zà-ú]/i.test(text)
  }

  function extractTitleFromCard(card: ReturnType<typeof $>): string {
    const headingCandidates = card
      .find('h1,h2,h3,h4,h5,h6,.alert-link,.card-title,.card-text')
      .map((_i, el) => normalizeSpace($(el).text()))
      .get()
      .filter(isTitleCandidate)
    if (headingCandidates[0]) return headingCandidates[0]
    const textLine = card.text().split(/\r?\n/).map(normalizeSpace).find(isTitleCandidate)
    return textLine ?? ''
  }

  function findVehicleCard(anchor: ReturnType<typeof $>): ReturnType<typeof $> {
    let current = anchor.parent()
    for (let depth = 0; depth < 8 && current.length > 0; depth += 1) {
      if (looksLikeVehicleContainer(normalizeSpace(current.text()))) return current
      current = current.parent()
    }
    return anchor.closest('.card, [class*="card"], [class*="col-"], li, article').first()
  }

  $('a[href*="Veiculo.aspx?id="]').each((_index, element) => {
    const detailAnchor = $(element)
    const detailUrl = toAbsoluteUrl(detailAnchor.attr('href'))
    if (!detailUrl || seenUrls.has(detailUrl)) return

    const card = findVehicleCard(detailAnchor)
    if (!card.length) return

    const title = extractTitleFromCard(card)
    if (!title) return

    const metaText = normalizeSpace(card.text())
    const brand = parseBrand(metaText)
    const year = parseYear(metaText)
    const lot = parseLot(metaText)
    const damageText = card.find('.btn.disabled, .disabled, .badge, .label')
      .map((_i, el) => normalizeSpace($(el).text()))
      .get()
      .find((text) => /monta|sucata/i.test(text))
    const damage = normalizeDamage(damageText)
      ?? (metaText.match(/\b(?:pequena|m[eé]dia)\s*-?\s*monta\b|\bsucata\b/i)?.[0] ?? null)
    const priceText = normalizeSpace(card.find('h5.text-right, .text-right').first().text()) || metaText
    const { price, priceRaw } = parsePrice(priceText)
    const imageUrls = pickImageUrl(
      detailAnchor.find('img').first().attr('src') ?? card.find('img').first().attr('src'),
    )
    const description = ['Lucinei Automóveis - Ribeirão Preto/SP', damage, lot ? `Cód.: ${lot}` : null]
      .filter((item): item is string => Boolean(item))
      .join(' · ')

    seenUrls.add(detailUrl)
    vehicles.push({
      source: 'lucinei',
      brand,
      model: title,
      year,
      damage,
      price,
      priceRaw,
      imageUrls,
      description,
      url: detailUrl,
      auctionDate: null,
      lot,
      yard: LUCINEI_YARD,
      fipe: null,
    })
  })

  log(`[lucinei] ${vehicles.length} card(s) válido(s) nesta página.`)
  return vehicles
}

async function run(
  _filters: AuctionFilters,
  options?: { log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const maxPages = clampPositiveInt(process.env.LUCINEI_MAX_PAGES, DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES)
  const queuedPages = new Set<number>([1])
  const pagesToVisit = [1]
  const allVehicles: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()

  log(`[lucinei] Iniciando (limite ${maxPages} página(s)).`)

  for (let index = 0; index < pagesToVisit.length; index += 1) {
    const page = pagesToVisit[index] ?? 1
    if (page > maxPages) continue

    const url = buildPageUrl(page)
    log(`[lucinei] Página ${page}: ${url}`)
    const html = await fetchHtml(url, log)
    if (!html) continue

    for (const vehicle of parseCards(html, log)) {
      if (seenUrls.has(vehicle.url)) continue
      seenUrls.add(vehicle.url)
      allVehicles.push(vehicle)
    }

    for (const pageNumber of parsePaginationPages(html)) {
      if (pageNumber > maxPages || queuedPages.has(pageNumber)) continue
      queuedPages.add(pageNumber)
      pagesToVisit.push(pageNumber)
    }

    if (index < pagesToVisit.length - 1) await sleep(PAGE_DELAY_MS)
  }

  log(`[lucinei] Total: ${allVehicles.length} veículo(s).`)
  return allVehicles
}

export const lucineiSource: ScraperSource = {
  id: 'lucinei',
  name: 'Lucinei Automóveis',
  run,
}
