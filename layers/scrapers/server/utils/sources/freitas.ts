import { load } from 'cheerio'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperOptions, type ScraperSource } from '../source-types'
import { auctionText, auctionKey, auctionMoney, brazilAuctionDate, publicAuctionRequest } from '../public-auction-http'

const ORIGIN = 'https://www.freitasleiloeiro.com.br'
const PAGE_SIZE = 12
const MAX_PAGES = 500
const IMAGE_HOSTS = new Set(['www.freitasleiloeiro.com.br', 'freitasleiloeiro.com.br', 'cdn3.freitasleiloeiro.com.br'])
export const FREITAS_LIST_URL = `${ORIGIN}/Leiloes/Pesquisar?Categoria=1&TipoLoteId=1`
type Request = (url: string, options: { signal?: AbortSignal; referer?: string }) => Promise<string>
export interface FreitasLot { auctionId: string; lot: string; url: string; card: string }

export function freitasPageUrl(page: number): string {
  const url = new URL('/Leiloes/PesquisarLotes', ORIGIN)
  url.search = new URLSearchParams({ Nome: '', Categoria: '1', TipoLoteId: '1', FaixaValor: '0', Condicao: '0', PatioId: '0', AnoModeloMin: '0', AnoModeloMax: '0', ArCondicionado: 'false', DirecaoAssistida: 'false', Tag: '', ClienteSclId: '0', PageNumber: String(page), TopRows: String(PAGE_SIZE) }).toString()
  return url.href
}

function assertPublicResponse(html: string): void {
  if (/Radware Captcha|captcha\.perfdrive|g-recaptcha|cf-chl-|access denied|acesso negado|Erro ao tentar retornar|Ops! P(?:á|&#xE1;)gina n(?:ã|&#xE3;)o encontrada/i.test(html)) throw new Error('[freitas] Consulta bloqueada ou resposta de erro; coleta incompleta.')
}

function lotIdentity(value: string): Omit<FreitasLot, 'card'> | null {
  try {
    const url = new URL(value, ORIGIN)
    const auctionId = url.searchParams.get('leilaoId'), lot = url.searchParams.get('loteNumero')
    if (url.origin !== ORIGIN || url.username || url.password || url.pathname !== '/Leiloes/LoteDetalhes' || !auctionId || !lot || !/^[1-9]\d*$/.test(auctionId) || !/^\d+$/.test(lot) || Number(lot) < 1) return null
    const canonical = new URL('/Leiloes/LoteDetalhes', ORIGIN)
    canonical.search = new URLSearchParams({ leilaoId: String(Number(auctionId)), loteNumero: String(Number(lot)) }).toString()
    return { auctionId: String(Number(auctionId)), lot: String(Number(lot)), url: canonical.href }
  } catch { return null }
}

export function freitasListing(html: string): { lots: FreitasLot[]; empty: boolean } {
  assertPublicResponse(html)
  const $ = load(html), lots = new Map<string, FreitasLot>()
  $('.cardlote').each((_index, element) => {
    const card = $(element)
    const identity = lotIdentity(card.find('a[href*="LoteDetalhes"]').first().attr('href') ?? '')
    if (!identity || !auctionText(card.find('.cardLote-descVeic').text())) throw new Error('[freitas] Card sem identidade ou descrição válida.')
    lots.set(identity.url, { ...identity, card: $.html(element) })
  })
  const empty = $('.alert').toArray().some(element => /^Nenhum lote localizado com os filtros aplicados!$/i.test(auctionText($(element).text())))
  if ((!lots.size && !empty) || (lots.size && empty)) throw new Error('[freitas] Listagem não reconhecida; coleta incompleta.')
  return { lots: [...lots.values()], empty }
}

function image(value: string | undefined, lot: FreitasLot): string | null {
  if (!value) return null
  try {
    const url = new URL(value, ORIGIN)
    const identity = url.pathname.match(/\/LEILOES\/(\d+)\/FOTOS\/(\d+)\//i)
    if (!identity || String(Number(identity[1])) !== lot.auctionId || String(Number(identity[2])) !== lot.lot) return null
    return url.protocol === 'https:' && !url.username && !url.password && IMAGE_HOSTS.has(url.hostname) && /\/LEILOES\/\d+\/FOTOS\//i.test(url.pathname) && !/indisponivel/i.test(url.pathname) ? url.href : null
  } catch { return null }
}

function scriptNumber(html: string, name: string): string | null {
  return html.match(new RegExp(`var\\s+${name}\\s*=\\s*parseInt\\(['"](\\d+)['"]\\)`))?.[1] ?? null
}

function statusRecord(json: string): { name: string; auctionStatusId: number } {
  assertPublicResponse(json)
  let value: unknown
  try { value = JSON.parse(json) as unknown } catch { throw new Error('[freitas] Situação do lote não retornou JSON válido.') }
  if (!value || typeof value !== 'object' || !('success' in value) || value.success !== true || !('message' in value) || !value.message || typeof value.message !== 'object') throw new Error('[freitas] Situação do lote indisponível.')
  const message = value.message
  if (!('nome' in message) || typeof message.nome !== 'string' || !message.nome.trim() || !('statusLeilaoId' in message) || typeof message.statusLeilaoId !== 'number') throw new Error('[freitas] Situação do lote sem campos esperados.')
  return { name: auctionText(message.nome), auctionStatusId: message.statusLeilaoId }
}

export function parseFreitasLot(lot: FreitasLot, html: string, photos: string, bid: string, statusJson: string): RawScrapedVehicle {
  for (const response of [html, photos, bid]) assertPublicResponse(response)
  if (scriptNumber(html, 'leilaoId') !== lot.auctionId || scriptNumber(html, 'loteNumero') !== lot.lot) throw new Error('[freitas] Identidade dos detalhes diverge do lote consultado.')
  const $ = load(html), card = load(lot.card), gallery = load(photos), bids = load(bid)
  const descLabel = $('div.fw-bold').filter((_index, element) => auctionKey(auctionText($(element).text())) === 'descricao completa:').first()
  const section = descLabel.parent()
  const title = auctionText(descLabel.next().find('div').first().text()) || auctionText(card('.cardLote-descVeic').text())
  const identityTitle = title.replace(/^I\//i, '')
  const parsedTitle = identityTitle.match(/^([A-Z.]+)[/ ]([^,]+),\s*(\d{2}|\d{4})\s*\/\s*(\d{2}|\d{4})\b/)
  if (!descLabel.length || !parsedTitle) throw new Error('[freitas] Descrição de veículo não reconhecida.')
  const rawBrand = parsedTitle[1]!.trim().toUpperCase()
  const aliases: Record<string, string> = { VW: 'VOLKSWAGEN', GM: 'CHEVROLET', CHEV: 'CHEVROLET', MMC: 'MITSUBISHI', LR: 'LAND ROVER', CAOACHERY: 'CAOA CHERY', 'M.BENZ': 'MERCEDES-BENZ', 'MERCEDES BENZ': 'MERCEDES-BENZ' }
  const brand = aliases[rawBrand] ?? rawBrand, model = parsedTitle[2]!.trim()
  const rawYear = Number(parsedTitle[4]), year = rawYear < 100 ? (rawYear <= 30 ? 2000 : 1900) + rawYear : rawYear
  const status = statusRecord(statusJson), normalizedStatus = auctionKey(status.name)
  // Codes other than the observed open state are not guessed; textual results are explicit.
  const saleStatus = /^(?:nao vendido|nao arrematado|sem licitante|sem lances)$/.test(normalizedStatus) ? 'not_sold'
    : /^(?:vendido|arrematado)$/.test(normalizedStatus) ? 'sold'
      : /^(?:condicional|venda condicional|vendido condicional)$/.test(normalizedStatus) ? 'conditional' : 'unknown'
  const finished = saleStatus !== 'unknown' || /^(?:encerrado|retirado|cancelado)$/.test(normalizedStatus)
  const hiddenBid = bids('#hdMaiorLance').attr('value')
  if (hiddenBid == null || !/^\d+(?:,\d{1,2})?$/.test(hiddenBid)) throw new Error('[freitas] Maior lance não reconhecido.')
  const currentValue = Number(hiddenBid.replace(',', '.'))
  const current = Number.isFinite(currentValue) && currentValue > 0 ? currentValue : null
  const initialLabel = $('small').filter((_index, element) => auctionKey(auctionText($(element).text())) === 'lance inicial').first()
  const initial = auctionMoney(initialLabel.prev().text())
  const price = current ?? (!finished ? initial : null)
  const moneyText = (value: number | null) => value == null ? null : `R$ ${value.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
  const menuValue = (label: string) => auctionText($('.box-menu-detalhes small').filter((_index, element) => auctionKey(auctionText($(element).text())) === label).first().next().text())
  const time = brazilAuctionDate(`${menuValue('data do leilao')} ${menuValue('horario')}`)
  const descriptions = [title, auctionText(section.text())].filter(Boolean)
  const detailText = descriptions.join('\n')
  const condition = auctionText(card('.cardLote-details').text()) || null
  const damageText = `${title} ${condition ?? ''}`
  const damageMatch = damageText.match(/\b(?:pequena|m[eé]dia|grande)\s+monta\b|\bsem\s+monta\b/i)
  const damage = damageMatch?.[0] ?? (/\bPEQ\s+MONT(?:A)?\b/i.test(damageText) ? 'PEQUENA MONTA' : null)
  const exposure = section.find('li').toArray().map(element => auctionText($(element).text())).find(value => /^Visitação\/Retirada:/i.test(value))?.replace(/^Visitação\/Retirada:\s*/i, '') ?? null
  const location = exposure?.split(/\s[-–]\s|,\s*/).at(-1)?.trim().match(/^([\p{L} .'-]+)\s*\/\s*([A-Z]{2})\s*$/u)
  const imageUrls = [...new Set(gallery('a[href], img[src]').toArray().map(element => image(gallery(element).attr('href') ?? gallery(element).attr('src'), lot)).filter((value): value is string => value != null))]
  if (!imageUrls.length) throw new Error('[freitas] Galeria sem fotos reconhecidas; coleta incompleta.')
  const fields: Record<string, string> = {}
  section.find('tr').each((_index, element) => { fields[auctionKey(auctionText($(element).find('th').text()).replace(/:\s*$/, ''))] = auctionText($(element).find('td').text()) })
  const segments = title.split(',').map(value => value.trim())
  const fuel = segments.find(value => /^(?:GASOL|ALC|DIESEL|FLEX|ELETR|HIBR)/i.test(value)) ?? null
  const color = segments.find(value => /^(?:PRET[AO]|BRANC[AO]|PRATA|CINZA|AZUL|VERMELH[AO]|VERDE|BEGE|AMAREL[AO]|MARROM)(?:\s|$)/i.test(value)) ?? null
  return {
    source: 'freitas', brand, model, year, description: detailText, url: lot.url, lot: lot.lot, auctionId: lot.auctionId,
    damage: damage ?? fields.monta ?? null, condition,
    price, priceRaw: moneyText(price), imageUrls,
    fipe: auctionMoney(fields.fipe ?? fields['valor fipe']), fipeRaw: fields.fipe ?? fields['valor fipe'] ?? null,
    auctionDate: time.date, auctionTimeKnown: time.timeKnown, auctionEndsAt: null, auctionUrl: null,
    auctionStatus: finished ? 'finished' : time.date ? 'upcoming' : 'unknown', auctionStatusRaw: status.name, auctionStatusCheckedAt: new Date(),
    saleStatus, saleStatusRaw: status.name, saleStatusCheckedAt: new Date(), soldPrice: saleStatus === 'sold' ? current : null, soldPriceRaw: saleStatus === 'sold' ? moneyText(current) : null,
    yard: exposure, city: location?.[1]?.trim() ?? null, state: location?.[2] ?? null,
    consignor: fields.comitente || null, km: fields.km || fields.quilometragem || null, color, fuel,
  }
}

/** One collector shared by Nuxt, CLI and cloud; no database or WhatsApp side effects. */
export async function runFreitasScraper(options: ScraperOptions = {}, request: Request = publicAuctionRequest): Promise<RawScrapedVehicle[]> {
  const log = options.log ?? console.info, vehicles: RawScrapedVehicle[] = [], lots = new Map<string, FreitasLot>()
  const failures: string[] = []
  let complete = false
  log('[scraper:freitas] iniciando')
  const get = (url: string) => { options.signal?.throwIfAborted(); return request(url, { signal: options.signal, referer: FREITAS_LIST_URL }) }
  try {
    // Keep fetching until the portal's explicit empty marker, even after a short page.
    let ended = false
    for (let page = 1; page <= MAX_PAGES; page++) {
      const parsed = freitasListing(await get(freitasPageUrl(page)))
      if (parsed.empty) { ended = true; break }
      let added = 0
      for (const lot of parsed.lots) { if (!lots.has(lot.url)) added++; lots.set(lot.url, lot) }
      if (!added) throw new Error('[freitas] Paginação repetiu lotes sem avançar; coleta incompleta.')
      log(`[freitas] Página ${page}: ${lots.size} lote(s) descoberto(s).`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (!ended) throw new Error('[freitas] Paginação excedeu o limite de segurança; coleta incompleta.')
    const entries = [...lots.values()]
    for (let index = 0; index < entries.length; index += 3) {
      options.signal?.throwIfAborted()
      const batch = await Promise.allSettled(entries.slice(index, index + 3).map(async lot => {
        const html = await get(lot.url)
        const query = new URLSearchParams({ leilaoId: lot.auctionId, loteNumero: lot.lot }).toString()
        // Sequential requests per lot cap remote concurrency to three.
        const photos = await get(`${ORIGIN}/Leiloes/ListarFotosLote?${query}`)
        const proposal = html.match(/var\s+modelo\s*=\s*['"](True|False)['"]/i)?.[1]
        if (!proposal || proposal.toLowerCase() !== 'false') throw new Error('[freitas] Modelo de propostas não suportado; lote não pode ser tratado como lance.')
        const bid = await get(`${ORIGIN}/Leiloes/RetornarMaiorLanceLote?${query}&modeloRecebePropostas=False`)
        const status = await get(`${ORIGIN}/Leiloes/RetornarLoteStatus?${query}`)
        return parseFreitasLot(lot, html, photos, bid, status)
      }))
      let accessFailure: string | null = null
      for (const result of batch) {
        options.signal?.throwIfAborted()
        if (result.status === 'fulfilled') { await options.onVehicle?.(result.value); vehicles.push(result.value) }
        else {
          const message = result.reason instanceof Error ? result.reason.message : String(result.reason)
          failures.push(message)
          if (/\bHTTP (?:401|403|429)\b|bloquead/i.test(message)) accessFailure = message
        }
      }
      if (accessFailure) throw new Error(`[freitas] Acesso interrompido: ${accessFailure}`)
      log(`[freitas] Detalhes ${Math.min(index + 3, entries.length)}/${entries.length}; ${vehicles.length} veículo(s); ${failures.length} falha(s).`)
      if (index + 3 < entries.length) await new Promise(resolve => setTimeout(resolve, 250))
    }
    options.signal?.throwIfAborted()
    if (failures.length) throw new Error(`[freitas] ${failures.length} lote(s) com falha. ${[...new Set(failures)].slice(0, 3).join('; ')}`)
    complete = true
    return vehicles
  } catch (error) {
    if (vehicles.length) throw new PartialScraperResultError(error instanceof Error ? error.message : String(error), vehicles)
    throw error
  } finally { log(`[scraper:freitas] finalizado (${complete ? 'completo' : 'incompleto'}): ${vehicles.length} veículo(s).`) }
}

export const freitasSource: ScraperSource = { id: 'freitas', name: 'Freitas Leiloeiro', run: (_filters, options) => runFreitasScraper(options) }
