import { load, type CheerioAPI } from 'cheerio'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperSource, type ScraperOptions } from '../source-types'
import { auctionText, auctionMoney, brazilAuctionDate, publicAuctionRequest, auctionMap } from '../public-auction-http'

const BASE_URL = 'https://www.vardanaleiloes.com.br/vardana'
const DETAIL_URL = 'https://vardana.com.br/veiculo-detalhes-logado'
const VARDANA_YARD = 'Curitiba - PR'

// Tried in order until one returns auction links
const DISCOVERY_URLS = [
  `${BASE_URL}/index`,
  `${BASE_URL}/`,
  'https://www.vardanaleiloes.com.br/',
]

type VardanaAuction = { id: string; url: string }
type OpenWindowCall = { auctionId: string; lotNumber: string; vehicleId: string }
type CheerioSelection = ReturnType<CheerioAPI>

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeNullableText(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw)
  return text ? text : null
}

function normalizeKey(raw: string): string {
  return raw.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

function toAbsoluteUrl(raw: string | null | undefined): string | null {
  const value = normalizeSpace(raw)
  if (!value) return null
  try { return new URL(value, `${BASE_URL}/`).toString() }
  catch { return null }
}

function parseAuctionIdsFromEnv(): string[] {
  const raw = normalizeSpace(process.env.VARDANA_LEILAO_IDS)
  if (!raw) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const item of raw.split(',')) {
    const id = item.trim()
    if (!/^\d+$/.test(id) || seen.has(id)) continue
    seen.add(id)
    ids.push(id)
  }
  return ids
}

function buildAuctionUrl(id: string): string {
  return `${BASE_URL}/veiculos.php?lei=${encodeURIComponent(id)}`
}

export function parseVardanaAuctionLinks(html: string): VardanaAuction[] {
  const $ = load(html)
  const auctions: VardanaAuction[] = []
  const seen = new Set<string>()

  $('a[href*="veiculos.php?lei="]').each((_index, element) => {
    const href = $(element).attr('href')
    if (!href) return
    try {
      const url = new URL(href, `${BASE_URL}/`)
      if (!['www.vardanaleiloes.com.br', 'vardanaleiloes.com.br'].includes(url.hostname)) return
      const id = url.searchParams.get('lei')?.trim() ?? ''
      if (!/^\d+$/.test(id) || seen.has(id)) return
      seen.add(id)
      auctions.push({ id, url: url.toString() })
    }
    catch { /* ignore */ }
  })

  return auctions
}

async function discoverAuctions(options: ScraperOptions): Promise<VardanaAuction[]> {
  const envIds = parseAuctionIdsFromEnv()
  if (envIds.length) return envIds.map(id => ({ id, url: buildAuctionUrl(id) }))
  const failures: string[] = []
  for (const url of DISCOVERY_URLS) {
    try {
      const html = await publicAuctionRequest(url, options)
      const auctions = parseVardanaAuctionLinks(html)
      if (auctions.length) return auctions
      if (/nenhum leilão|não há leilões/i.test(auctionText(html))) return []
      failures.push(`Agenda sem links reconhecidos em ${url}`)
    } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    if (options.signal?.aborted) throw options.signal.reason
  }
  throw new Error(failures.join('; '))
}

function parseAuctionDate(html: string) {
  const $ = load(html)
  const header = $('.b-items__aside-sell-img').first()
  const date = normalizeSpace(header.find('h3').first().text())
  const time = normalizeSpace(header.text()).match(/às\s*(\d{1,2})(?:h|:)(\d{2})?/i)
  return brazilAuctionDate(`${date}${time ? ` às ${time[1]}:${time[2] ?? '00'}` : ''}`)
}

function parseOpenWindowCall(raw: string | null | undefined): OpenWindowCall | null {
  const match = normalizeSpace(raw).match(/openWindow\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i)
  if (!match?.[1] || !match[2] || !match[3]) return null
  return { auctionId: match[1], lotNumber: match[2], vehicleId: match[3] }
}

function parseOpenWindowCallFromBox($: CheerioAPI, box: CheerioSelection): OpenWindowCall | null {
  let fallback: OpenWindowCall | null = null
  let selected: OpenWindowCall | null = null
  box.find('a[onclick*="openWindow"]').each((_index, element) => {
    const parsed = parseOpenWindowCall($(element).attr('onclick'))
    if (!parsed) return
    fallback ??= parsed
    if (parsed.lotNumber !== '0') { selected = parsed; return false as unknown as void }
  })
  return selected ?? fallback
}

function buildDetailUrl(call: OpenWindowCall): string {
  const url = new URL(DETAIL_URL)
  url.searchParams.set('lei', call.auctionId)
  url.searchParams.set('_id', call.lotNumber)
  url.searchParams.set('cov', call.vehicleId)
  return url.toString()
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const match = raw.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/)
  if (!match?.[1]) return { price: null, priceRaw: null }
  const numeric = Number.parseFloat(match[1].replace(/\./g, '').replace(',', '.'))
  if (!Number.isFinite(numeric) || numeric <= 0) return { price: null, priceRaw: `R$ ${match[1]}` }
  return { price: Math.round(numeric), priceRaw: `R$ ${match[1]}` }
}

function parseYear(raw: string | null | undefined): number | null {
  const text = normalizeSpace(raw)
  if (!text) return null
  const full = text.match(/\b((?:19|20)\d{2})\s*\/\s*((?:19|20)\d{2})\b/)
  if (full?.[2]) return Number.parseInt(full[2], 10)
  const short = text.match(/\b(\d{2})\s*\/\s*(\d{2})\b/)
  if (short?.[2]) {
    const v = Number.parseInt(short[2], 10)
    return v >= 80 ? 1900 + v : 2000 + v
  }
  const fallback = text.match(/\b((?:19|20)\d{2})\b/)
  return fallback?.[1] ? Number.parseInt(fallback[1], 10) : null
}

function parseTitleParts(title: string): { brand: string; model: string } {
  const normalized = normalizeSpace(title).toUpperCase()
    .replace(/^M\.?\s*BENZ\//, 'MERCEDES-BENZ/')
    .replace(/\b(\d{3})CDISPRINTER([A-Z]?)\b/g, 'SPRINTER $1 CDI $2')
    .replace(/\b(GLA)(\d{3})([A-Z]+)?\b/g, '$1 $2 $3')
  if (!normalized) return { brand: 'UNKNOWN', model: 'UNKNOWN' }

  const slashIndex = normalized.indexOf('/')
  if (slashIndex > -1) {
    const brandPrefix = normalizeSpace(normalized.slice(0, slashIndex))
    const rest = normalizeSpace(normalized.slice(slashIndex + 1))
    if ((brandPrefix === 'I' || brandPrefix === 'IMP') && rest) {
      const [brand = 'UNKNOWN', ...modelParts] = rest.split(/\s+/)
      return { brand, model: modelParts.join(' ') || rest }
    }
    return { brand: brandPrefix || 'UNKNOWN', model: rest || normalized }
  }

  const [brand = 'UNKNOWN', ...modelParts] = normalized.split(/\s+/)
  return { brand, model: modelParts.join(' ') || normalized }
}

function extractFields($: CheerioAPI, box: CheerioSelection): Record<string, string> {
  const fields: Record<string, string> = {}
  box.find('.b-items__cars-one-info-title').each((_index, element) => {
    const text = normalizeSpace($(element).text())
    const separator = text.indexOf(':')
    if (separator < 0) return
    const key = normalizeKey(text.slice(0, separator))
    const value = normalizeSpace(text.slice(separator + 1))
    if (key && value) fields[key] = value
  })
  return fields
}

function parseLotLabel(box: CheerioSelection, fallback: string): string {
  const match = normalizeSpace(box.find('.label').first().text()).match(/Lote\s+([0-9]+)/i)
  return match?.[1] ?? fallback
}

function parseCardTitle(box: CheerioSelection): string | null {
  const fromBold = normalizeNullableText(box.find('h2 a b').first().text())
  if (fromBold) return fromBold
  const h2Text = normalizeSpace(box.find('h2').first().text()).replace(/^Lote\s+\d+\s*/i, '')
  return normalizeNullableText(h2Text)
}

function parseCardPrice($: CheerioAPI, box: CheerioSelection): { price: number | null; priceRaw: string | null } {
  const fromPriceHeading = normalizeSpace(
    box.find('h4').filter((_i, el) => /color\s*:\s*#?ad1924/i.test($(el).attr('style') ?? '')).first().text(),
  )
  if (fromPriceHeading) return parsePrice(fromPriceHeading)
  return { price: null, priceRaw: null }
}

export function parseVardanaAuctionPage(
  html: string,
  auction: VardanaAuction,
  log: (message: string) => void,
): RawScrapedVehicle[] {
  const $ = load(html)
  const { date: auctionDate, timeKnown } = parseAuctionDate(html)
  const vehicles: RawScrapedVehicle[] = []
  const seenUrls = new Set<string>()

  $('.box_veiculos').each((_index, element) => {
    const box = $(element)
    const call = parseOpenWindowCallFromBox($, box)
    if (!call) return

    const title = parseCardTitle(box)
    if (!title) return

    const lot = parseLotLabel(box, call.lotNumber !== '0' ? call.lotNumber : call.vehicleId)
    const detailUrl = buildDetailUrl({ ...call, lotNumber: lot })
    if (seenUrls.has(detailUrl)) return

    const imageUrl = toAbsoluteUrl(box.find("img[src*='img_leiloes']").first().attr('src'))
    const fields = extractFields($, box)
    const fuel = normalizeNullableText(fields.combustivel)
    const color = normalizeNullableText(fields.cor)
    const plate = normalizeNullableText(fields.placa)
    const obs = normalizeNullableText(fields.obs)
    const year = parseYear(fields.ano)
    const { price, priceRaw } = parseCardPrice($, box)
    const { brand, model } = parseTitleParts(title)

    const descParts = [`Vardana Leilões - Curitiba/PR`, `Leilão ${auction.id}`]
    if (auctionDate) descParts.push(`Data ${auctionDate.toLocaleDateString('pt-BR')}`)
    if (fuel) descParts.push(`Combustível: ${fuel}`)
    if (color) descParts.push(`Cor: ${color}`)
    if (plate) descParts.push(`Placa: ${plate}`)
    if (obs) descParts.push(`Obs: ${obs}`)

    seenUrls.add(detailUrl)
    vehicles.push({
      source: 'vardana',
      brand,
      model,
      year,
      damage: null,
      price,
      priceRaw,
      imageUrls: imageUrl ? [imageUrl] : [],
      description: descParts.join(' · '),
      url: detailUrl,
      auctionDate,
      auctionTimeKnown: timeKnown,
      auctionId: auction.id,
      auctionUrl: null,
      city: 'Curitiba',
      state: 'PR',
      auctionStatus: 'upcoming',
      lot,
      color,
      fuel,
      yard: VARDANA_YARD,
      fipe: null,
    })
  })

  log(`[vardana] Leilão ${auction.id}: ${vehicles.length} veículo(s) na relação.`)
  return vehicles
}

function publicData(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function applyVardanaDetail(vehicle: RawScrapedVehicle, data: unknown, bidHtml: string): RawScrapedVehicle {
  const record = publicData(data)
  const reportedLot = auctionText(record.descricaoLoteTopo).match(/^Lote\s+(\d+)/i)?.[1]
  if (!reportedLot) throw new Error('Detalhes públicos Vardana não reconhecidos.')
  if (Number(reportedLot) !== Number(vehicle.lot)) throw new Error('A Vardana respondeu com outro lote.')
  const $ = load(typeof record.info === 'string' ? record.info : '')
  const fields: Record<string, string> = {}
  $('li').each((_index, element) => {
    const text = auctionText($(element).text())
    const separator = text.indexOf(':')
    if (separator >= 0) fields[normalizeKey(text.slice(0, separator))] = text.slice(separator + 1).trim()
  })
  const expectedImagePath = `/img_leiloes/${vehicle.auctionId}/${new URL(vehicle.url).searchParams.get('cov')}/`
  const images = Array.from({ length: 12 }, (_, index) => toAbsoluteUrl(typeof record[`img${index + 1}`] === 'string' ? record[`img${index + 1}`] as string : null))
    .filter((image): image is string => image != null && new URL(image).pathname.startsWith(`/vardana${expectedImagePath}`))
  const bids = load(bidHtml)
  // #teste é o lance exibido. Nunca usar o valor digitável, próximo lance ou taxas.
  const current = auctionMoney(bids('#teste').first().text())
  const status = auctionText(bids('.informa_status, .aguardando_avaliacao').first().text())
  const key = normalizeKey(status)
  const saleStatus = /nao.*(?:vendido|arrematado)/.test(key) ? 'not_sold' : /condicional/.test(key) ? 'conditional' : /^(?:vendido|arrematado)\b/.test(key) ? 'sold' : 'unknown'
  const result = saleStatus !== 'unknown'
  const price = current ?? vehicle.price
  const observations = auctionText(record.defeito)
  const fipe = auctionMoney(fields.fipe)
  return {
    ...vehicle,
    year: parseYear(fields.ano) ?? vehicle.year,
    imageUrls: images.length ? [...new Set(images)] : vehicle.imageUrls,
    km: fields.quilometragem || null,
    color: fields.cor || vehicle.color,
    fuel: fields.combustivel || vehicle.fuel,
    description: [vehicle.description, observations].filter(Boolean).join(' · '),
    price, priceRaw: price != null ? `R$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : null,
    fipe: fipe ?? vehicle.fipe,
    // Ausência de avaliação não constitui resultado e não deve apagar uma captura ao vivo.
    ...(result ? { saleStatus, saleStatusRaw: status, saleStatusCheckedAt: new Date(), auctionStatus: 'finished', soldPrice: saleStatus === 'sold' ? current : null } : {}),
  }
}

export async function runVardanaScraper(options: ScraperOptions = {}): Promise<RawScrapedVehicle[]> {
  const log = options.log ?? console.log
  const collected: RawScrapedVehicle[] = []
  const failures: string[] = []
  log('[scraper:vardana] iniciando')
  try {
    const auctions = await discoverAuctions(options)
    for (const auction of auctions) {
      try {
        const html = await publicAuctionRequest(auction.url, options)
        const vehicles = parseVardanaAuctionPage(html, auction, log)
        if (!vehicles.length && !/Relação em breve|nenhum lote/i.test(auctionText(html))) throw new Error(`Relação não reconhecida no leilão ${auction.id}.`)
        await auctionMap(vehicles, async vehicle => {
          if (options.signal?.aborted) return
          let enriched = vehicle
          try {
            const url = new URL(vehicle.url)
            const vehicleId = url.searchParams.get('cov')!
            const data = JSON.parse(await publicAuctionRequest('https://vardana.com.br/controller/lote/lote.controller?acao=atualizaInformacoesLote', {
              signal: options.signal, referer: vehicle.url, form: { codigo: vehicleId, leilao: auction.id },
            })) as unknown
            const bids = await publicAuctionRequest('https://vardana.com.br/botoes_lance.php', {
              signal: options.signal, referer: vehicle.url,
              form: { codigo_veiculo: vehicleId, leilao: auction.id, ultimo_lote: vehicle.lot ?? '', ultimo_lance: '', ultimo_apelido: '', ultimo_status: '', ultimo_step: '', digitado: '' },
            })
            enriched = applyVardanaDetail(vehicle, data, bids)
          } catch (error) {
            // A relação pública continua útil mesmo se uma consulta individual falhar.
            failures.push(`Lote ${vehicle.lot}: ${error instanceof Error ? error.message : String(error)}`)
          }
          if (options.signal?.aborted) return
          collected.push(enriched)
          await options.onVehicle?.(enriched)
        })
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
      if (options.signal?.aborted) break
    }
    if (failures.length || options.signal?.aborted) throw new PartialScraperResultError(failures.join('; ') || 'Coleta cancelada.', collected)
    return collected
  } finally { log(`[scraper:vardana] finalizado: ${collected.length} veículo(s).`) }
}

export const vardanaSource: ScraperSource = {
  id: 'vardana', name: 'Vardana Leilões', run: (_filters, options) => runVardanaScraper(options),
}
