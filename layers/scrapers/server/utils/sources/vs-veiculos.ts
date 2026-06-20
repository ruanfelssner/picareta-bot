import { load } from 'cheerio'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperSource } from '../source-types'

const BASE = 'https://www.vsveiculos.com'
const VS_DEFAULT_CITY = 'Pinhais'
const VS_DEFAULT_STATE = 'PR'
const VS_DEFAULT_YARD = `${VS_DEFAULT_CITY} - ${VS_DEFAULT_STATE}`

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

function formatSlugLabel(value: string): string {
  return value
    .replace(/-/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, char => char.toUpperCase())
}

function parseCardUrl(href: string): { brand: string; model: string; damage: string; city: string } {
  const parts = href.replace(/^\/carros\//, '').split('/')
  return {
    damage: formatSlugLabel(parts[0] ?? ''),
    city: formatSlugLabel(parts[1] ?? '') || VS_DEFAULT_CITY,
    brand: (parts[2] ?? '').replace(/-/g, ' '),
    model: (parts[3] ?? '').replace(/-/g, ' '),
  }
}

function parseVehicleIdFromHref(href: string): string | null {
  const match = href.match(/\/id-(\d+)(?:[/?#]|$)/)
  return match?.[1] ?? null
}

function buildCanonicalVehicleUrl(vehicleId: string): string {
  return `${BASE}/carros/id-${vehicleId}`
}

function buildPageUrl(page = 1): string {
  const parts = ['tipoveiculo.carros']
  if (page > 1) parts.push(`pagina.${page}`)
  return `${BASE}/search/${parts.join('/')}`
}

function parsePriceFromText(text: string): { price: number | null; priceRaw: string | null } {
  const match = text.match(/R\$\s*([\d.]+(?:,\d+)?)/)
  if (!match) return { price: null, priceRaw: null }
  const priceRaw = `R$ ${match[1]!}`
  const price = parseInt(match[1]!.replace(/\./g, '').replace(',', ''), 10)
  return { price: isNaN(price) ? null : price, priceRaw }
}

function parseYearFromText(text: string): number | null {
  const match = text.match(/(20\d{2})\/(20\d{2})/)
  if (match) return parseInt(match[1]!, 10)
  const m2 = text.match(/\b(20\d{2})\b/)
  return m2 ? parseInt(m2[1]!, 10) : null
}

async function fetchPage(url: string, log: (m: string) => void): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) { log(`[vs] HTTP ${res.status} em ${url}`); return null }
    return res.text()
  }
  catch (err) {
    log(`[vs] Erro ao buscar ${url}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function parseTotalPages(html: string): number {
  const match = html.match(/Exibindo\s+\d+\s*-\s*(\d+)\s+de\s+(\d+)/i)
  if (!match) return 1
  return Math.ceil(parseInt(match[2]!, 10) / parseInt(match[1]!, 10))
}

function parseCards(html: string, log: (m: string) => void, availableAt: Date): RawScrapedVehicle[] {
  const $ = load(html)
  const results: RawScrapedVehicle[] = []
  const seen = new Set<string>()

  $('a[href*="/carros/"][href*="/id-"]').each((_i, el) => {
    const card = $(el)
    const href = card.attr('href') ?? ''
    if (!href || seen.has(href)) return
    seen.add(href)

    const vehicleId = parseVehicleIdFromHref(href)
    if (!vehicleId) return
    const cardUrl = buildCanonicalVehicleUrl(vehicleId)
    const rawText = card.text().replace(/\s+/g, ' ').trim()
    if (!rawText) return

    const { brand, model, damage, city } = parseCardUrl(href)
    const { price, priceRaw } = parsePriceFromText(rawText)
    const year = parseYearFromText(rawText)

    const imgSrc = card.find('img').first().attr('src') ?? ''
    const imgLazy = card.find('img').first().attr('data-src') ?? ''
    const imageUrl = (imgSrc.startsWith('http') ? imgSrc : imgLazy.startsWith('http') ? imgLazy : '').replace(/^\/\//, 'https://')

    const description = rawText.replace(/mais detalhes/gi, '').replace(/\s{2,}/g, ' ').trim().slice(0, 250)

    results.push({
      source: 'vs-veiculos',
      brand: brand.toUpperCase() || 'UNKNOWN',
      model: model.toUpperCase() || rawText.slice(0, 40),
      year,
      damage: damage || null,
      price,
      priceRaw,
      imageUrls: imageUrl ? [imageUrl] : [],
      description,
      url: cardUrl,
      auctionDate: availableAt,
      lot: vehicleId,
      yard: `${city} - ${VS_DEFAULT_STATE}`,
      city,
      state: VS_DEFAULT_STATE,
      fipe: null,
    })
  })

  log(`[vs] ${results.length} card(s) válido(s) nesta página.`)
  return results
}

async function run(
  _filters: AuctionFilters,
  options?: { log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const allResults: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()
  const availableAt = new Date()

  const firstUrl = buildPageUrl(1)
  log(`[vs] Buscando: ${firstUrl}`)

  const firstHtml = await fetchPage(firstUrl, log)
  if (!firstHtml) { log('[vs] Falha ao carregar página 1.'); return [] }

  const totalPages = Math.min(parseTotalPages(firstHtml), 5)
  log(`[vs] ${totalPages} página(s) encontrada(s).`)

  for (const v of parseCards(firstHtml, log, availableAt)) {
    if (!seenUrls.has(v.url)) { seenUrls.add(v.url); allResults.push(v) }
  }

  for (let page = 2; page <= totalPages; page++) {
    const pageUrl = buildPageUrl(page)
    log(`[vs] Página ${page}/${totalPages}: ${pageUrl}`)
    const html = await fetchPage(pageUrl, log)
    if (!html) break
    for (const v of parseCards(html, log, availableAt)) {
      if (!seenUrls.has(v.url)) { seenUrls.add(v.url); allResults.push(v) }
    }
    await new Promise((r) => setTimeout(r, 800))
  }

  log(`[vs] Total: ${allResults.length} veículo(s).`)
  return allResults
}

export const vsVeiculosSource: ScraperSource = {
  id: 'vs-veiculos',
  name: 'VS Veículos',
  run,
}
