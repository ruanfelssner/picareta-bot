import { load } from 'cheerio'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperSource } from '../source-types'

const BASE_URL = 'https://www.phbatidos.com.br'
const SITEMAP_URL = `${BASE_URL}/sitemap.xml`
const PH_YARD = 'Curitiba - PR'
const DETAIL_BATCH_SIZE = 4
const DETAIL_BATCH_DELAY_MS = 600

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

interface JsonLdCar {
  '@type'?: string
  sku?: string | number
  name?: string
  offers?: { price?: number | string; priceCurrency?: string }
  mileageFromOdometer?: { value?: number | string }
  vehicleModelDate?: string | number
  color?: string
  fuelType?: string
  vehicleTransmission?: string
  numberOfDoors?: string | number
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getTodayAuctionDate(): Date {
  const date = new Date()
  date.setHours(23, 59, 59, 999)
  return date
}

async function fetchText(url: string, log: (msg: string) => void): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) { log(`[ph-batidos] HTTP ${res.status} → ${url}`); return null }
    return res.text()
  }
  catch (err) {
    log(`[ph-batidos] Erro em ${url}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function parseSizeCategory(href: string): string | null {
  if (href.includes('/pequena-monta/')) return 'Pequena Monta'
  if (href.includes('/media-monta/')) return 'Média Monta'
  if (href.includes('/grande-monta/')) return 'Grande Monta'
  return null
}

function parseBrandFromHref(href: string): string {
  // /carros/[size]/curitiba/[brand]/[model]/...
  const match = href.match(/\/carros\/[^/]+\/[^/]+\/([^/]+)\//)
  return match?.[1]?.replace(/-/g, ' ').toUpperCase().trim() ?? ''
}

function parseVehicleId(href: string): string | null {
  return href.match(/\/id-(\d+)/)?.[1] ?? null
}

function parseVehicleUrls(xml: string): string[] {
  const urls: string[] = []
  const regex = /<loc>(https?:\/\/[^<]+\/carros\/[^<]+)<\/loc>/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(xml)) !== null) {
    if (match[1]) urls.push(match[1])
  }
  return urls
}

function extractJsonLd(html: string): JsonLdCar | null {
  const $ = load(html)
  let found: JsonLdCar | null = null
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (found) return
    try {
      const json = JSON.parse($(el).html() ?? '')
      const item = Array.isArray(json) ? json.find((x: JsonLdCar) => x['@type'] === 'Car') : json
      if (item?.['@type'] === 'Car') found = item as JsonLdCar
    }
    catch { /* skip malformed */ }
  })
  return found
}

function parseDetailPage(html: string, url: string): RawScrapedVehicle | null {
  const vehicleId = parseVehicleId(url)
  if (!vehicleId) return null

  const $ = load(html)
  const ld = extractJsonLd(html)

  // Price: JSON-LD first, then h2.vehicle__sell__value
  let price: number | null = null
  let priceRaw: string | null = null
  if (ld?.offers?.price != null) {
    const n = Number(ld.offers.price)
    if (Number.isFinite(n) && n > 0) {
      price = n
      priceRaw = `R$ ${n.toLocaleString('pt-BR')}`
    }
  }
  if (price == null) {
    const priceText = $('h2.vehicle__sell__value, .vehicle__sell__value').first().text().trim()
    const match = priceText.match(/R\$\s?([\d.]+(?:,\d{2})?)/)
    if (match?.[1]) {
      const raw = match[1]
      const n = Number.parseInt(raw.replace(/\./g, '').replace(',', ''), 10)
      if (Number.isFinite(n) && n > 0) { price = n; priceRaw = `R$ ${raw}` }
    }
  }

  // Year: JSON-LD vehicleModelDate, then h2 pattern "2014/2015"
  let year: number | null = null
  if (ld?.vehicleModelDate) {
    const y = Number.parseInt(String(ld.vehicleModelDate), 10)
    if (y > 1900) year = y
  }
  if (year == null) {
    const yearText = $('strong.vehicle__technical__information__value').toArray()
      .map(el => $(el).text().trim())
      .find(t => /^\d{4}\/\d{4}$/.test(t))
    if (yearText) year = Number.parseInt(yearText.split('/')[1] ?? yearText, 10)
  }

  // km: JSON-LD mileageFromOdometer.value
  let km: string | null = null
  if (ld?.mileageFromOdometer?.value != null) {
    const v = Number(ld.mileageFromOdometer.value)
    if (Number.isFinite(v)) km = v.toLocaleString('pt-BR')
  }
  if (km == null) {
    const kmEl = $('strong.vehicle__technical__information__value').toArray()
      .map(el => $(el).text().trim())
      .find(t => /^[\d.]+$/.test(t) && Number.parseInt(t.replace(/\./g, ''), 10) > 0)
    if (kmEl) km = kmEl
  }

  const color = ld?.color ?? null
  const fuel = ld?.fuelType ?? null

  // Brand from URL, title from h1
  const brand = parseBrandFromHref(url)
  const titleRaw = $('h1.vehicle__title, .vehicle__title').first().text().trim()

  // Model = title minus brand prefix
  let model = titleRaw
  if (brand && titleRaw.toUpperCase().startsWith(brand)) {
    model = titleRaw.slice(brand.length).replace(/^[\s-]+/, '').trim()
  }

  const damage = parseSizeCategory(url)

  // Images
  const imageUrls: string[] = []
  const seenImgs = new Set<string>()
  $('img[src*="s3.ecompletocarros.dev"]').each((_i, el) => {
    const src = $(el).attr('src')
    if (!src || seenImgs.has(src) || !src.includes('/veiculos/')) return
    seenImgs.add(src)
    imageUrls.push(src.startsWith('http') ? src : `${BASE_URL}${src}`)
  })

  const descParts: string[] = ['PH Batidos - Curitiba/PR']
  if (damage) descParts.push(damage)
  if (color) descParts.push(`Cor: ${color}`)
  if (fuel) descParts.push(`Combustível: ${fuel}`)

  return {
    source: 'ph-batidos',
    brand: brand || (titleRaw.split(' ')[0] ?? 'UNKNOWN'),
    model: model || titleRaw,
    year,
    damage,
    price,
    priceRaw,
    imageUrls,
    description: descParts.join(' · '),
    url,
    auctionDate: getTodayAuctionDate(),
    lot: vehicleId,
    color,
    fuel,
    km,
    yard: PH_YARD,
    fipe: null,
  }
}

async function run(
  _filters: AuctionFilters,
  options?: { log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log

  log('[ph-batidos] Buscando URLs via sitemap...')
  const sitemapXml = await fetchText(SITEMAP_URL, log)
  if (!sitemapXml) {
    log('[ph-batidos] Sitemap não encontrado, abortando.')
    return []
  }

  const urls = parseVehicleUrls(sitemapXml)
  log(`[ph-batidos] ${urls.length} veículo(s) no sitemap.`)

  if (urls.length === 0) return []

  const results: RawScrapedVehicle[] = []
  let missingPriceSkipped = 0

  for (let i = 0; i < urls.length; i += DETAIL_BATCH_SIZE) {
    const batch = urls.slice(i, i + DETAIL_BATCH_SIZE)

    const batchResults = await Promise.all(batch.map(async (url): Promise<RawScrapedVehicle | null> => {
      const html = await fetchText(url, log)
      if (!html) return null
      return parseDetailPage(html, url)
    }))

    for (const v of batchResults) {
      if (!v) continue
      if (v.price == null) {
        missingPriceSkipped++
        continue
      }
      results.push(v)
    }

    if (i + DETAIL_BATCH_SIZE < urls.length) await sleep(DETAIL_BATCH_DELAY_MS)
  }

  if (missingPriceSkipped > 0) {
    log(`[ph-batidos] ${missingPriceSkipped} veículo(s) sem preço descartado(s).`)
  }
  log(`[ph-batidos] Total: ${results.length} veículo(s).`)
  return results
}

export const phBatidosSource: ScraperSource = {
  id: 'ph-batidos',
  name: 'PH Batidos',
  run,
}
