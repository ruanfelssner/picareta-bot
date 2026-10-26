import { load } from 'cheerio'
import { setTimeout as delay } from 'node:timers/promises'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperOptions, type ScraperSource } from '../source-types'
import { auctionKey, auctionMoney, auctionText, brazilAuctionDate, publicAuctionRequest } from '../public-auction-http'

export const PALACIO_ORIGIN = 'https://www.palaciodosleiloes.com.br'
export const PALACIO_LIST_URL = `${PALACIO_ORIGIN}/site/index.php?categoria_pesquisa=1`
export const PALACIO_TIMEOUT_MS = 15 * 60_000
const ENDPOINT = `${PALACIO_ORIGIN}/site/camada_ajax/`
const PAGE_SIZE = 8
const MAX_PAGES = 200
type Request = typeof publicAuctionRequest
export interface PalacioLot { id: string; auctionId: string; lot: string | null; url: string; card: string }

export function palacioListForm(page: number): Record<string, string> {
  return { opcao: 'listar_lote', categoria_pesquisa: '1', subcategoria_pesquisa: '1,3,209', tipo_exibicao: 'grid', paginacao: String(page * PAGE_SIZE), total_paginas: String(page + 1), somente_pesquisa: '1' }
}

function assertPublic(html: string): void {
  if (/Acesso bloqueado|acesso negado|access denied|g-recaptcha|cf-chl-|Security Checkpoint|<title>\s*(?:Erro|Login)/i.test(html)) throw new Error('[palacio] Consulta pública bloqueada; coleta incompleta.')
}

export function palacioListing(html: string): { lots: PalacioLot[]; total: number } {
  assertPublic(html)
  const $ = load(html), rawTotal = $('#total_lotes').attr('value')
  if (!rawTotal || !/^\d+$/.test(rawTotal) || !$('.resultados-lotes').length) throw new Error('[palacio] Listagem não reconhecida.')
  const lots = new Map<string, PalacioLot>()
  $('.resultado-lote-card--veiculo').each((_index, element) => {
    const card = $(element), ids = card.find('[onclick]').first().attr('onclick')?.match(/^exibir_lote\(([1-9]\d*),\s*([1-9]\d*)\)$/)
    const identifiers = card.find('.resultado-veiculo-identificadores')
    const lot = auctionText(identifiers.find('span').last().text()).match(/^Lote\s+(\d+)$/i)?.[1] ?? null
    if (!ids || (identifiers.length && !lot) || !auctionText(card.find('.resultado-veiculo-modelo').text())) throw new Error('[palacio] Lote sem identidade ou descrição.')
    const id = ids[1]!, auctionId = ids[2]!, url = `${PALACIO_ORIGIN}/site/lotem.php?cl=${id}`
    lots.set(id, { id, auctionId, lot, url, card: $.html(element) })
  })
  return { lots: [...lots.values()], total: Number(rawTotal) }
}

function detailFields(html: string) {
  const $ = load(html), fields = new Map<string, string[]>()
  $('tr').each((_index, element) => {
    const cells = $(element).children('td')
    if (cells.length !== 2) return
    const key = auctionKey(auctionText(cells.eq(0).text())), value = auctionText(cells.eq(1).text())
    fields.set(key, [...fields.get(key) ?? [], value])
  })
  return { $, fields, value: (key: string) => fields.get(key)?.[0] || null }
}

export function parsePalacioLot(lot: PalacioLot, html: string): RawScrapedVehicle {
  assertPublic(html)
  const { $, fields, value } = detailFields(html), card = load(lot.card)
  const officialLot = fields.get('lote')?.find(text => /^\d+$/.test(text)) ?? null
  if ($('#cod_lote_pre_lance').attr('value') !== lot.id || $('#cod_leilao').attr('value') !== lot.auctionId || !value('leilao e data')?.startsWith(`${lot.auctionId} -`) || (lot.lot && officialLot !== lot.lot)) throw new Error('[palacio] Identidade do detalhe diverge da listagem.')
  const inPreparation = /Lote em construção/i.test(html)
  const titleElement = $('td.h4[colspan="2"]').first()
  if (!titleElement.length) throw new Error('[palacio] Cadastro do bem não reconhecido.')
  const title = auctionText(titleElement.text()) || auctionText(card('.resultado-veiculo-modelo button').attr('title'))
  const identityTitle = title.replace(/^I[/ ]/i, '')
  const identity = identityTitle.match(/^([^/]+)\/(.+)$/) ?? identityTitle.match(/^(\S+)\s+(.+)$/)
  if (!title) throw new Error('[palacio] Descrição do veículo não reconhecida.')
  const aliases: Record<string, string> = { VW: 'VOLKSWAGEN', GM: 'CHEVROLET', CHEV: 'CHEVROLET', 'M.BENZ': 'MERCEDES-BENZ', MMC: 'MITSUBISHI' }
  const rawBrand = identity?.[1]?.trim().toUpperCase() ?? 'DESCONHECIDA', brand = aliases[rawBrand] ?? rawBrand, model = identity?.[2]?.trim() || title
  const year = Number(value('ano')?.match(/(?:\d{4}\s*\/\s*)?(\d{4})$/)?.[1]) || null
  const rawDate = value('leilao e data')?.match(/^\d+\s*-\s*(\d{2}\/\d{2}\/)(\d{2}|\d{4})$/)
  const date = rawDate ? brazilAuctionDate(`${rawDate[1]}${rawDate[2]!.length === 2 ? '20' : ''}${rawDate[2]}`) : { date: null, timeKnown: false }
  // Previsão é aproximada por lote; não é o horário oficial de início do pregão.
  const label = auctionKey(auctionText($('.bg-cinza').filter((_index, element) => /^(?:lance atual|lance inicial|valor inicial)$/i.test(auctionText($(element).text()))).first().text()))
  if (!label) throw new Error('[palacio] Rótulo do preço não reconhecido.')
  const priceRaw = auctionText($('.h1.font-weight-bold').first().text()) || null
  const price = auctionMoney(priceRaw)
  const imageUrls = [...new Set($('#carouselExampleSlidesOnly .carousel-item img[src]').toArray().map(element => {
    try {
      const url = new URL($(element).attr('src') ?? '', `${PALACIO_ORIGIN}/site/`)
      return url.origin === PALACIO_ORIGIN && !url.username && !url.password && /^\/site\/imagens_lote\/[\w/-]+\.(?:webp|jpe?g|png)$/i.test(url.pathname) ? url.href : null
    } catch { return null }
  }).filter((url): url is string => url !== null))]
  const placeholder = card('img[src="images/preparacao.webp"]').length > 0
  if (!imageUrls.length && !placeholder) throw new Error('[palacio] Galeria não reconhecida.')
  const condition = value('situacao veiculo'), damage = condition?.match(/\b(?:pequena|m[eé]dia|grande)\s+monta\b|\bsucata\b/i)?.[0] ?? null
  // A segunda linha "Lote" contém o endereço do bem; não usar "Local do leilão".
  const yard = fields.get('lote')?.find(text => !/^\d+$/.test(text) && !/^[-–\s]*$/.test(text)) || null
  const location = yard?.match(/\b([\p{L} .'-]+)\s*[-/]\s*([A-Z]{2})\s*$/u)
  const states = /^(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/
  const state = location && states.test(location[2]!) ? location[2]! : null
  // O endereço não delimita o início da cidade; validar o nome publicado no card.
  const cardCity = auctionText(card('.resultado-veiculo-dados span').eq(2).text())
  const city = state && cardCity && yard?.toLowerCase().includes(`${cardCity.toLowerCase()}-${state.toLowerCase()}`) ? cardCity : null
  const detail = auctionText($('.text-justify.border').first().text())
  const commission = $('#val_comissao').attr('value'), expense = $('#val_despesa').attr('value'), extra = $('#val_despesa_arrem').attr('value')
  const fees = [commission && /^\d+(?:\.\d+)?$/.test(commission) ? `Comissão do lote: ${commission}%.` : '', expense && /^\d+(?:\.\d+)?$/.test(expense) ? `Despesas do lote: R$ ${Number(expense).toFixed(2).replace('.', ',')}.` : '', extra && /^\d+(?:\.\d+)?$/.test(extra) ? `Despesas adicionais do lote: R$ ${Number(extra).toFixed(2).replace('.', ',')}.` : ''].filter(Boolean)
  return {
    source: 'palacio', brand, model, year, url: lot.url, auctionId: lot.auctionId, lot: officialLot,
    description: [title, condition, detail, ...fees].filter(Boolean).join('\n'), condition, damage,
    price, priceRaw: price === null ? null : `R$ ${priceRaw}`, imageUrls,
    auctionDate: date.date, auctionTimeKnown: false, auctionEndsAt: null, auctionUrl: null,
    auctionStatus: inPreparation ? 'future' : date.date ? 'upcoming' : 'unknown', auctionStatusRaw: inPreparation ? 'Lote em construção' : null,
    saleStatus: 'unknown', saleStatusRaw: null, soldPrice: null, soldPriceRaw: null,
    yard, city, state, consignor: auctionText(card('.resultado-veiculo-comitente span').text()) || null,
    km: value('km'), fuel: value('combustivel'), color: value('cor'), fipe: null, fipeRaw: null,
  }
}

/** Somente consultas públicas; não executa login, aceite, visita, favorito ou lance. */
export async function runPalacioScraper(options: ScraperOptions = {}, request: Request = publicAuctionRequest): Promise<RawScrapedVehicle[]> {
  const log = options.log ?? console.info, vehicles: RawScrapedVehicle[] = [], seen = new Set<string>()
  const failures: string[] = []
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error('[palacio] Tempo total de coleta excedido.')), PALACIO_TIMEOUT_MS)
  const get = async (url: string, form: Record<string, string>, referer = PALACIO_LIST_URL) => {
    for (let attempt = 0; ; attempt++) {
      controller.signal.throwIfAborted()
      if (request === publicAuctionRequest) await delay(attempt ? 1000 : 250, undefined, { signal: controller.signal })
      try {
        const html = await request(url, { form, referer, signal: controller.signal, encoding: 'windows-1252' })
        controller.signal.throwIfAborted()
        assertPublic(html)
        return html
      } catch (error) {
        controller.signal.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        if (attempt || !/\bHTTP 5\d\d\b|timeout|Tempo de consulta excedido/i.test(message)) throw error
        log(`[palacio] Nova tentativa após falha temporária: ${message}`)
      }
    }
  }
  let complete = false, expected: number | undefined
  log('[scraper:palacio] iniciando')
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const listing = palacioListing(await get(`${ENDPOINT}coluna_esquerda_m_home.php`, palacioListForm(page)))
      if (expected !== undefined && expected !== listing.total) throw new Error('[palacio] Estoque mudou durante a paginação; repetir coleta.')
      expected = listing.total
      if (!listing.lots.length) {
        if (page * PAGE_SIZE < listing.total || seen.size !== listing.total) throw new Error('[palacio] Paginação terminou antes de todos os lotes.')
        if (failures.length) throw new Error(`[palacio] ${failures.length} detalhe(s) com falha; coleta incompleta. ${failures.slice(0, 3).join('; ')}`)
        complete = true
        return vehicles
      }
      let added = 0
      for (const lot of listing.lots) {
        if (seen.has(lot.id)) continue
        added++
        seen.add(lot.id)
        let vehicle: RawScrapedVehicle
        try {
          const form = { cod_lote: lot.id, cod_leilao: lot.auctionId }
          // Respeita a verificação pública do próprio portal; não aceita contratos.
          const access = (await get(`${ENDPOINT}lotem.php`, { ...form, opcao: 'verificar_contrato' }, lot.url)).trim()
          if (access !== '1') throw new Error('[palacio] Lote indisponível ou exige acesso/contrato; coleta incompleta.')
          vehicle = parsePalacioLot(lot, await get(`${ENDPOINT}lotem.php`, { ...form, opcao: 'exibir_lote_m', num_lote: '0' }, lot.url))
        } catch (error) {
          controller.signal.throwIfAborted()
          const message = error instanceof Error ? error.message : String(error)
          if (/bloquead|acesso\/contrato|\bHTTP (?:401|403|429)\b/i.test(message)) throw error
          const failure = `${lot.url}: ${message}`
          failures.push(failure)
          log(`[palacio] Falha de detalhe: ${failure}`)
          continue
        }
        controller.signal.throwIfAborted()
        await options.onVehicle?.(vehicle)
        vehicles.push(vehicle)
      }
      if (!added) throw new Error('[palacio] Paginação repetida sem avanço.')
      log(`[palacio] Página ${page + 1}: ${seen.size}/${listing.total} lotes; ${vehicles.length} extraídos; ${failures.length} falha(s).`)
    }
    throw new Error('[palacio] Limite de páginas atingido; coleta incompleta.')
  } catch (error) {
    if (vehicles.length) throw new PartialScraperResultError(error instanceof Error ? error.message : String(error), vehicles)
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    log(`[scraper:palacio] finalizado (${complete ? 'completo' : 'incompleto'}): ${vehicles.length} veículo(s).`)
  }
}

export const palacioSource: ScraperSource = { id: 'palacio', name: 'Palácio dos Leilões', run: (_filters, options) => runPalacioScraper(options) }
