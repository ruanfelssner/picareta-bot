import { load } from 'cheerio'
import { setTimeout as delay } from 'node:timers/promises'
import { PartialScraperResultError, type RawScrapedVehicle, type ScraperOptions, type ScraperSource } from '../source-types'
import { auctionMoney, auctionText, publicAuctionRequest } from '../public-auction-http'

export const LEILO_ORIGIN = 'https://leilo.com.br'
export const LEILO_SERIES_URL = `${LEILO_ORIGIN}/leilao/evento/leilao-de-veiculos-sul-sudeste/`
export const LEILO_TIMEOUT_MS = 15 * 60_000
const SERIES = 'leilao-de-veiculos-sul-sudeste'
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i
const ACTIVE_EVENTS = new Set(['EmLoteamento', 'Pronto', 'AoVivo'])
const MAX_EVENTS = 20
const MAX_PAGES = 100
type RecordValue = Record<string, unknown>
type Request = typeof publicAuctionRequest
export interface LeiloEvent { id: string; name: string; status: string }

function record(value: unknown): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('[leilo] Estrutura pública não reconhecida.')
  return value as RecordValue
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('[leilo] Contagem/paginação inválida.')
  return value
}

/** Desserializa somente os literais do SSR; nunca executa o JavaScript do portal. */
export function leiloState(html: string): RecordValue {
  const script = load(html)('script').toArray().map(element => load(element).text()).find(text => text.startsWith('window.__INITIAL_STATE__='))
  if (!script) throw new Error('[leilo] Consulta bloqueada ou página pública sem dados reconhecidos.')
  const raw = script.match(/^window\.__INITIAL_STATE__=(.*?);document\.currentScript\.remove\(\)\s*$/s)?.[1]
  if (!raw) throw new Error('[leilo] Estado público inválido.')
  // O serializador publica undefined e new Date("ISO"). Strings ficam intactas.
  const json = raw.replace(/new Date\(("(?:\\.|[^"\\])*")\)|"(?:\\.|[^"\\])*"|\bundefined\b/g, (token, date: string | undefined) => date ?? (token === 'undefined' ? 'null' : token))
  try { return record(JSON.parse(json) as unknown) } catch { throw new Error('[leilo] Estado público não retornou literais válidos.') }
}

function resolution(state: RecordValue): RecordValue {
  const entries = Object.values(record(record(state.eventoSeo).resolucoes))
    .map(entry => record(record(entry).resolucao))
    .filter(entry => entry.resolvido === true && record(entry.evento).slug === SERIES)
  if (!entries.length || new Set(entries.map(entry => record(entry.evento).eventUid)).size !== 1) throw new Error('[leilo] Série Sul e Sudeste não reconhecida.')
  return entries[0]!
}

export function leiloEvents(state: RecordValue): LeiloEvent[] {
  const resolved = resolution(state)
  if (!Array.isArray(resolved.edicoes)) throw new Error('[leilo] Edições da série indisponíveis.')
  const events = new Map<string, LeiloEvent>()
  for (const value of [resolved.evento, ...resolved.edicoes]) {
    const event = record(value)
    if (event.slug !== SERIES) throw new Error('[leilo] Edição fora da série solicitada.')
    if (!ACTIVE_EVENTS.has(String(event.situacao))) {
      if (['Executado', 'Cancelado', 'Criado'].includes(String(event.situacao))) continue
      throw new Error('[leilo] Situação da edição não reconhecida.')
    }
    const id = String(event.eventUid), name = auctionText(event.nome)
    if (!UUID.test(id) || !name) throw new Error('[leilo] Edição sem identidade oficial.')
    events.set(id, { id, name, status: String(event.situacao) })
  }
  if (events.size > MAX_EVENTS) throw new Error('[leilo] Limite de edições excedido; coleta incompleta.')
  return [...events.values()]
}

export function leiloPageUrl(eventId: string, page = 1): string {
  if (!UUID.test(eventId) || !Number.isInteger(page) || page < 1) throw new Error('[leilo] Identidade/página inválida.')
  const url = new URL(LEILO_SERIES_URL)
  url.searchParams.set('evento', eventId)
  if (page > 1) url.searchParams.set('pagina', String(page))
  return url.href
}

export function leiloListing(state: RecordValue, event: LeiloEvent, page: number) {
  const resolved = record(resolution(state).evento), elastic = record(state.elastic)
  if (resolved.eventUid !== event.id || resolved.nome !== event.name || !ACTIVE_EVENTS.has(String(resolved.situacao))) throw new Error('[leilo] Edição alterada durante a consulta.')
  const total = integer(elastic.totalRegistros), pages = integer(elastic.totalPaginasAtual), size = integer(elastic.tamanhoPaginaBusca)
  if (!size || integer(elastic.paginaAtualBusca) !== page || pages !== Math.max(1, Math.ceil(total / size)) || page > pages) throw new Error('[leilo] Paginação divergente ou repetida.')
  if (!Array.isArray(elastic.lotesPaginaAtual) || !Array.isArray(elastic.lotes) || !Array.isArray(elastic.filtrosBusca)) throw new Error('[leilo] Listagem não reconhecida.')
  const filter = elastic.filtrosBusca.map(record).find(item => item.campo === 'leilao.nome')
  if (!Array.isArray(filter?.itensSelecionadosMultiplaEscolha) || filter.itensSelecionadosMultiplaEscolha.length !== 1 || filter.itensSelecionadosMultiplaEscolha[0] !== event.name || elastic.ampliacaoBusca != null) throw new Error('[leilo] Filtro da edição não confirmado.')
  const ids = elastic.lotesPaginaAtual
  if (ids.length > size || (total === 0) !== (ids.length === 0) || ids.some(id => typeof id !== 'string' || !UUID.test(id))) throw new Error('[leilo] Página vazia inesperada ou identidade inválida.')
  const lots = ids.map(id => {
    const matches = elastic.lotes as unknown[]
    const lot = matches.map(record).find(item => item.id === id)
    if (!lot || record(lot.leilao).id !== event.id || lot.tipoDocumento !== 'lote') throw new Error('[leilo] Lote não pertence à edição consultada.')
    return lot
  })
  return { lots, total, pages }
}

function photos(lot: RecordValue): string[] {
  if (!Array.isArray(lot.fotosUrls)) throw new Error('[leilo] Galeria não reconhecida.')
  const urls = lot.fotosUrls.map(value => {
    if (typeof value !== 'string') throw new Error('[leilo] Foto inválida.')
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'leilo.cdndp.com.br' || !/^\/v1\/arquivo\/.+\.(?:jpe?g|png|webp)$/i.test(url.pathname)) throw new Error('[leilo] Host/caminho da galeria não reconhecido.')
    return url.href
  })
  if (new Set(urls).size !== integer(lot.quantidadeFotos)) throw new Error('[leilo] Galeria incompleta.')
  return [...new Set(urls)]
}

export function parseLeiloLot(card: RecordValue, state: RecordValue): RawScrapedVehicle {
  const elastic = record(state.elastic), lot = record(elastic.lotePaginaAtualData)
  const auction = record(lot.leilao), vehicle = record(lot.veiculo), location = record(lot.localizacao), values = record(lot.valor)
  if (elastic.lotePaginaAtualId !== card.id || lot.id !== card.id || auction.id !== record(card.leilao).id || lot.numero !== card.numero || lot.tipoDocumento !== 'lote') throw new Error('[leilo] Identidade do detalhe diverge da listagem.')
  if (!UUID.test(String(lot.id)) || !UUID.test(String(auction.id)) || !ACTIVE_EVENTS.has(String(auction.situacao))) throw new Error('[leilo] Identidade/situação do evento alterada.')
  const title = auctionText(lot.nome), rawBrand = auctionText(vehicle.infocarMarca).toUpperCase()
  const aliases: Record<string, string> = { VW: 'VOLKSWAGEN', GM: 'CHEVROLET', 'M.BENZ': 'MERCEDES-BENZ', MMC: 'MITSUBISHI' }
  const brand = aliases[rawBrand] ?? rawBrand, model = auctionText(vehicle.infocarModelo)
  if (!title || !brand || !model || integer(lot.numero) < 1) throw new Error('[leilo] Cadastro do veículo incompleto.')
  const year = typeof vehicle.anoModelo === 'number' && Number.isInteger(vehicle.anoModelo) && vehicle.anoModelo >= 1900 && vehicle.anoModelo <= 2100 ? vehicle.anoModelo : null
  const rawDate = String(auction.data)
  const date = new Date(rawDate)
  if (!/(?:Z|[+-]\d\d:\d\d)$/.test(rawDate) || Number.isNaN(date.getTime())) throw new Error('[leilo] Horário oficial não reconhecido.')
  const status = auctionText(lot.situacao)
  // Apenas estados explícitos; a cláusula “vendido no estado” não é um resultado.
  const saleStatus = status === 'Pago' || status === 'AgPagamento' ? 'sold' : status === 'Condicional' ? 'conditional' : status === 'NaoArrematado' ? 'not_sold' : 'unknown'
  const finished = saleStatus !== 'unknown' || ['Retirado', 'LoteCancelado', 'CanceladoNoLeilao'].includes(status)
  const bid = auctionMoney(record(values.lance).valor), initial = auctionMoney(values.minimo)
  const price = bid ?? (!finished && status === 'LiberadoLeilao' ? initial : null)
  const money = (amount: number | null) => amount == null ? null : `R$ ${amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
  const detail = auctionText(lot.descricao), condition = auctionText(vehicle.retomada) || null
  // Monta é lida somente no cadastro do bem, nunca nas regras gerais do evento.
  const damage = `${title} ${condition ?? ''} ${detail}`.match(/\b(?:pequena|m[eé]dia|grande|sem)\s+monta\b|\bsucata\b/i)?.[0] ?? (lot.tipo === 'Sucatas' ? 'Sucata' : null)
  const fees = ['despachante', 'remocao', 'depositoDeBens', 'vistoria', 'outros'].flatMap(key => {
    const value = auctionMoney(values[key])
    const labels: Record<string, string> = { despachante: 'Despachante', remocao: 'Remoção', depositoDeBens: 'Depósito de bens', vistoria: 'Vistoria', outros: 'Outras despesas' }
    return value == null ? [] : [`${labels[key]} do lote: ${money(value)}.`]
  })
  const commission = values.comissaoPorcentagem, extraCommission = values.comissaoExtraPorcentagem
  if (typeof commission === 'number' && Number.isFinite(commission) && commission >= 0) fees.unshift(`Comissão do lote: ${commission}%.`)
  if (typeof extraCommission === 'number' && Number.isFinite(extraCommission) && extraCommission > 0) fees.push(`Comissão extra do lote: ${extraCommission}%.`)
  const market = auctionMoney(vehicle.valorMercado)
  const stateCode = auctionText(location.estado).toUpperCase()
  const stateValid = /^(?:AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)$/.test(stateCode)
  return {
    source: 'leilo', brand, model, year, url: `${LEILO_ORIGIN}/lote/${lot.id}/`, auctionId: String(auction.id), lot: String(lot.numero),
    description: [title, condition, detail, market == null ? null : `Valor Mercado publicado: ${money(market)}.`, ...fees].filter(Boolean).join('\n'),
    condition, damage, price, priceRaw: price == null ? null : `${bid == null ? 'Lance inicial' : 'Lance atual'}: ${money(price)}`,
    soldPrice: saleStatus === 'sold' ? bid : null, soldPriceRaw: saleStatus === 'sold' ? money(bid) : null,
    saleStatus, saleStatusRaw: status || null, auctionStatus: finished ? 'finished' : auction.situacao === 'AoVivo' ? 'unknown' : 'upcoming', auctionStatusRaw: String(auction.situacao),
    auctionDate: date, auctionTimeKnown: true, auctionEndsAt: null, auctionUrl: null,
    yard: auctionText(location.nome) || null, city: stateValid ? auctionText(location.cidade) || null : null, state: stateValid ? stateCode : null,
    consignor: auctionText(record(lot.comitente).nome) || null, imageUrls: photos(lot),
    km: typeof vehicle.km === 'number' && vehicle.km >= 0 && vehicle.kmSituacao === 'Preenchido' ? String(vehicle.km) : null,
    color: auctionText(vehicle.cor) || null, fuel: auctionText(vehicle.combustivel) || null, fipe: null, fipeRaw: null,
  }
}

/** GET de HTML público, sem executar scripts, registrar visitas ou chamar lances. */
export async function runLeiloScraper(options: ScraperOptions = {}, request: Request = publicAuctionRequest): Promise<RawScrapedVehicle[]> {
  const log = options.log ?? console.info, vehicles: RawScrapedVehicle[] = [], seen = new Set<string>()
  const controller = new AbortController(), abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timer = setTimeout(() => controller.abort(new Error('[leilo] Tempo total de coleta excedido.')), LEILO_TIMEOUT_MS)
  const get = async (url: string) => {
    controller.signal.throwIfAborted()
    if (request === publicAuctionRequest) await delay(250, undefined, { signal: controller.signal })
    const html = await request(url, { referer: LEILO_SERIES_URL, signal: controller.signal })
    controller.signal.throwIfAborted()
    return leiloState(html)
  }
  log('[scraper:leilo] iniciando — série Sul e Sudeste')
  let discovered = 0
  try {
    const events = leiloEvents(await get(LEILO_SERIES_URL))
    log(`[leilo] ${events.length} edição(ões) ativa(s) na série Sul e Sudeste.`)
    for (const event of events) {
      let expected: number | undefined, expectedPages: number | undefined
      const eventIds = new Set<string>()
      for (let page = 1; ; page++) {
        if (page > MAX_PAGES) throw new Error('[leilo] Limite de páginas excedido; coleta incompleta.')
        const listing = leiloListing(await get(leiloPageUrl(event.id, page)), event, page)
        if (expected != null && (expected !== listing.total || expectedPages !== listing.pages)) throw new Error('[leilo] Estoque/paginação alterados durante a coleta.')
        expected = listing.total; expectedPages = listing.pages
        if (listing.pages > MAX_PAGES) throw new Error('[leilo] Limite de páginas excedido; coleta incompleta.')
        let fresh = 0
        for (const card of listing.lots) {
          const id = String(card.id)
          if (eventIds.has(id)) continue
          eventIds.add(id); discovered++; fresh++
          if (seen.has(id)) throw new Error('[leilo] Identidade repetida entre edições.')
          const car = parseLeiloLot(card, await get(`${LEILO_ORIGIN}/lote/${id}/`))
          vehicles.push(car); seen.add(id)
          await options.onVehicle?.(car)
          controller.signal.throwIfAborted()
        }
        log(`[leilo] ${event.name}: página ${page}/${listing.pages}, ${eventIds.size}/${expected} descobertos, ${vehicles.length} extraídos.`)
        if (page === listing.pages) {
          if (eventIds.size !== expected) throw new Error('[leilo] Total de lotes diverge do catálogo; coleta incompleta.')
          break
        }
        if (!fresh) throw new Error('[leilo] Página repetida sem novos lotes.')
      }
    }
    return vehicles
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[leilo] Falha: ${message}`)
    if (vehicles.length) throw new PartialScraperResultError(message, vehicles)
    throw error
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    log(`[scraper:leilo] finalizado — ${discovered} descobertos, ${vehicles.length} extraídos`)
  }
}

export const leiloSource: ScraperSource = { id: 'leilo', name: 'Leilo Sul e Sudeste', run: (_filters, options) => runLeiloScraper(options) }
