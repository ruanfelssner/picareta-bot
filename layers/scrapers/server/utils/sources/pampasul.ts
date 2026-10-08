import { load } from 'cheerio'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperOptions, type ScraperSource } from '../source-types'
import { auctionText, auctionKey, auctionMoney, brazilAuctionDate, publicAuctionRequest, auctionMap } from '../public-auction-http'

const ORIGIN = 'https://leiloespampasul.com'
const LIST_URL = `${ORIGIN}/lotes/?cate%5B%5D=3`
const LIVE_URL = `${ORIGIN}/app/Ajax/Leiloes/atualizar_leiloes.php`

function record(value: unknown): Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sourceUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value, ORIGIN)
    return url.origin === ORIGIN ? url.toString() : null
  } catch { return null }
}

export function pampaSulListing(html: string): { lots: Array<{ id: string; url: string }>; pages: string[]; empty: boolean } {
  const $ = load(html)
  const lots = new Map<string, { id: string; url: string }>()
  $('a.cards__main[href]').each((_index, element) => {
    const url = sourceUrl($(element).attr('href'))
    const id = url && new URL(url).pathname.match(/^\/lote\/[^/]+\/(\d+)\/?$/)?.[1]
    if (url && id) lots.set(id, { id, url })
  })
  const pages = new Set<string>()
  $('a[href*="pag="]').each((_index, element) => {
    const url = sourceUrl($(element).attr('href'))
    if (!url) return
    const parsed = new URL(url)
    const page = parsed.searchParams.get('pag')
    if (parsed.pathname !== '/lotes/' || !page || !/^\d+$/.test(page)) return
    // Preserve the requested cars category on every numbered page.
    const canonical = new URL(LIST_URL)
    canonical.searchParams.set('pag', page)
    pages.add(canonical.toString())
  })
  return { lots: [...lots.values()], pages: [...pages], empty: /nenhum (?:lote|resultado)|não foram encontrados/i.test(auctionText($('main, #lotes').text())) }
}

export function parsePampaSulLot(html: string, url: string, liveData: unknown): RawScrapedVehicle {
  const $ = load(html)
  const live = record(liveData)
  const id = new URL(url).pathname.match(/\/(\d+)\/?$/)?.[1]
  if (!id || String(live.box_id ?? '') !== id) throw new Error('Identidade do lote não corresponde à consulta pública.')
  const fields: Record<string, string> = {}
  $('.ls-info-item').each((_index, element) => {
    const label = auctionKey(auctionText($(element).find('.ls-info-label').text()))
    fields[label] = auctionText($(element).find('.ls-info-value').text())
  })
  const brand = fields.marca
  const model = fields.modelo
  if (!brand || !model) throw new Error(`Características do lote ${id} não reconhecidas.`)
  const yearText = fields['ano modelo']
  const year = yearText && /^(?:19|20)\d{2}$/.test(yearText) ? Number(yearText) : null
  const bid = record(live.lance)
  const current = auctionMoney(bid.atual)
  const status = Number(live.situacao)
  const saleStatus = status === 2 ? 'sold' : status === 3 ? 'not_sold' : status === 10 ? 'conditional' : 'unknown'
  const statusRaw = status === 2 ? 'Arrematado' : status === 3 ? 'Não arrematado' : status === 10 ? 'Leilão condicional' : status === 1 ? 'Aberto para lances' : status === 0 ? 'Em breve' : status === 20 ? 'Venda direta' : null
  // The next minimum bid is neither the current bid nor the initial bid.
  const price = current ?? (saleStatus === 'unknown' ? auctionMoney(bid.ini) ?? auctionMoney(fields['lance inicial']) : null)
  const dates = record(live.data)
  const end = brazilAuctionDate(`${auctionText(dates.fim)} às ${auctionText(dates.hora_fim)}`)
  const endFallback = brazilAuctionDate(fields['termino do leilao'] ?? '')
  const auctionEndsAt = end.date ?? endFallback.date
  const auctionLink = sourceUrl($('.ls-lote-rodape__btn[href]').first().attr('href'))
  const auctionId = auctionLink && new URL(auctionLink).pathname.match(/^\/lotes\/[^/]+\/(\d+)\/?$/)?.[1]
  const images = $('.ls-lote-gallery .ls-gallery-thumb-item[data-main]').toArray()
    .map(element => sourceUrl($(element).attr('data-main'))).filter((image): image is string => image != null)
  if (!images.length) {
    const main = sourceUrl($('.ls-lote-gallery .ls-gallery-main-img').first().attr('src'))
    if (main) images.push(main)
  }
  const exposure = auctionText($('.box__11').text())
  const locationMatch = exposure.match(/Endereço:\s*(.+?)\s*-\s*([A-Z]{2})\s*,?\s*\d{5}-?\d{3}/i)
  const state = locationMatch?.[2]?.toUpperCase() ?? null
  const city = locationMatch?.[1]?.split(',').at(-1)?.trim() ?? null
  const seller = auctionText($('.ls-lote-header__meta-item--accent').first().text()) || null
  const lot = auctionText($('.ls-lote-header__numline').text()).match(/Lote\s*(\d+)/i)?.[1]
    ?? auctionText($('.ls-lote-header').text()).match(/Lote\s*(\d+)/i)?.[1] ?? null
  const fipe = auctionMoney(fields.fipe)
  const condition = fields['condicao do veiculo'] || null
  const checkedAt = new Date()
  return {
    source: 'pampasul', brand, model, year, damage: fields.monta || null, condition,
    price, priceRaw: price != null ? `R$ ${price.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : null,
    fipe, fipeRaw: fipe != null ? fields.fipe ?? null : null,
    imageUrls: [...new Set(images)].slice(0, 40), url,
    description: [auctionText(live.nome), fields['versao'], condition, auctionEndsAt ? `Encerramento: ${auctionEndsAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}` : null].filter(Boolean).join(' · '),
    // The published time is a closing time, not a confirmed live auction start.
    auctionDate: auctionEndsAt, auctionTimeKnown: false, auctionEndsAt,
    auctionId: auctionId ?? null, auctionUrl: auctionId ? auctionLink : null,
    lot, consignor: seller, city, state, yard: city && state ? `${city} - ${state}` : null,
    km: fields.km || null, color: fields.cor || null, fuel: fields.combustivel || null,
    auctionStatus: saleStatus === 'unknown' ? 'upcoming' : 'finished', auctionStatusRaw: statusRaw, auctionStatusCheckedAt: checkedAt,
    saleStatus, saleStatusRaw: statusRaw, saleStatusCheckedAt: checkedAt,
    soldPrice: saleStatus === 'sold' ? current : null,
    soldPriceRaw: saleStatus === 'sold' && current != null ? auctionText(bid.atual) : null,
  }
}

export async function runPampaSulScraper(options: ScraperOptions = {}): Promise<RawScrapedVehicle[]> {
  const log = options.log ?? console.log
  const vehicles: RawScrapedVehicle[] = []
  const lots = new Map<string, { id: string; url: string }>()
  const pages = [LIST_URL]
  const visited = new Set<string>()
  const failures: string[] = []
  log('[scraper:pampasul] iniciando')
  try {
    while (pages.length) {
      const page = pages.shift()!
      if (visited.has(page)) continue
      visited.add(page)
      if (visited.size > 100) { failures.push('Paginação excedeu o limite de segurança.'); break }
      try {
        const parsed = pampaSulListing(await publicAuctionRequest(page, options))
        if (!parsed.lots.length && !parsed.empty) throw new Error('Listagem de veículos não reconhecida.')
        parsed.lots.forEach(lot => lots.set(lot.id, lot))
        parsed.pages.forEach(next => { if (!visited.has(next) && !pages.includes(next)) pages.push(next) })
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
      if (options.signal?.aborted) break
    }
    log(`[pampasul] ${lots.size} lote(s) em ${visited.size} página(s).`)
    const entries = [...lots.values()]
    for (let index = 0; index < entries.length && !options.signal?.aborted; index += 40) {
      const batch = entries.slice(index, index + 40)
      try {
        const data = record(JSON.parse(await publicAuctionRequest(LIVE_URL, {
          signal: options.signal, referer: LIST_URL, form: { leiloes: '', lotes: batch.map(lot => lot.id).join('-') + '-', lote: '', pg: '' },
        })) as unknown)
        const items = record(data.item)
        await auctionMap(batch, async lot => {
          if (options.signal?.aborted) return
          try {
            const html = await publicAuctionRequest(lot.url, options)
            if (options.signal?.aborted) return
            const vehicle = parsePampaSulLot(html, lot.url, items[lot.id])
            vehicles.push(vehicle)
            await options.onVehicle?.(vehicle)
          } catch (error) { failures.push(`Lote ${lot.id}: ${error instanceof Error ? error.message : String(error)}`) }
        })
      } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
    }
    if (failures.length || options.signal?.aborted) throw new PartialScraperResultError(failures.join('; ') || 'Coleta cancelada.', vehicles)
    return vehicles
  } finally { log(`[scraper:pampasul] finalizado: ${vehicles.length} veículo(s).`) }
}

export const pampaSulSource: ScraperSource = {
  id: 'pampasul', name: 'Pampa Sul Leilões', run: (_filters, options) => runPampaSulScraper(options),
}
