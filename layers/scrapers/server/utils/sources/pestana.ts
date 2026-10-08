import type { ScraperOptions, ScraperSource, RawScrapedVehicle } from '../source-types.js'
import { PartialScraperResultError } from '../source-types.js'

const BASE_URL = 'https://www.pestanaleiloes.com.br'
const MEDIA_URL = 'https://ged.pestanaleiloes.com.br/ged/'
export const PESTANA_LIST_URL = `${BASE_URL}/procurar-bens?lotePage=1&loteQty=12&tipoBem=421`
const BATCH_SIZE = 24
const MAX_LOTS = 20_000
type RecordData = Record<string, unknown>
type Fetcher = typeof fetch

function record(value: unknown): RecordData {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {}
}
function rows(value: unknown): RecordData[] {
  return Array.isArray(value) ? value.map(record) : []
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim() : null
}
function key(value: unknown): string {
  return (text(value) || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}
function id(value: unknown): string | null {
  const result = typeof value === 'number' || typeof value === 'string' ? String(value) : ''
  return /^\d+$/.test(result) && Number(result) > 0 ? result : null
}
function money(value: unknown): number | null {
  const result = typeof value === 'number' ? value : Number(String(value ?? '').replace(/R\$|\s/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'))
  return Number.isFinite(result) && result > 0 ? result : null
}
function moneyText(value: number | null): string | null {
  return value == null ? null : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

/** O portal informa datas locais brasileiras, sem offset. */
export function pestanaDate(value: unknown): { date: Date | null; timeKnown: boolean } {
  const raw = text(value)
  if (!raw || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(raw)) return { date: null, timeKnown: false }
  const local = raw.includes('T') ? raw : `${raw}T00:00:00`
  const calendar = new Date(`${raw.slice(0, 10)}T12:00:00Z`)
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== raw.slice(0, 10)) return { date: null, timeKnown: false }
  const date = new Date(/(?:Z|[+-]\d{2}:\d{2})$/.test(local) ? local : `${local}-03:00`)
  if (Number.isNaN(date.getTime())) return { date: null, timeKnown: false }
  return { date, timeKnown: raw.includes('T') }
}

export function pestanaHydration(html: string, name: string): unknown {
  const tag = html.match(new RegExp(`<script\\b[^>]*\\bid=["']${name}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i'))
  if (!tag) return null
  try { return JSON.parse(tag[1]!) as unknown }
  catch { throw new Error(`[pestana] Dados inválidos em ${name}.`) }
}

export function pestanaLotIds(value: unknown): number[] {
  const result = record(value)
  if (!Array.isArray(result.lotes)) throw new Error('[pestana] Resposta da busca sem lista de lotes; coleta não concluída.')
  const identifiers = result.lotes.map(id)
  if (identifiers.some(value => !value)) throw new Error('[pestana] Identificador de lote inválido na busca.')
  const unique = [...new Set(identifiers.map(Number))]
  if (unique.length > MAX_LOTS) throw new Error('[pestana] Busca excedeu o limite de segurança; coleta não concluída.')
  return unique
}

function image(value: unknown): string | null {
  const raw = text(value)
  if (!raw || raw === '.') return null
  try {
    const url = new URL(raw, MEDIA_URL)
    return url.protocol === 'https:' && !url.username && !url.password && ['ged.pestanaleiloes.com.br', 'www.pestanaleiloes.com.br'].includes(url.hostname) ? url.href : null
  } catch { return null }
}

export interface PestanaMetadata {
  auctions: RecordData[]
  characteristicTypes: RecordData[]
  partners: RecordData[]
  roomUrls?: Map<string, string>
}

export function parsePestanaLot(value: unknown, metadata: PestanaMetadata, now = new Date()): RawScrapedVehicle | null {
  const lot = record(value)
  const lotId = id(lot.id)
  const auctionId = id(lot.leilao)
  if (!Array.isArray(lot.bens)) throw new Error('[pestana] Detalhes do lote sem lista de bens; coleta incompleta.')
  const assets = rows(lot.bens).filter(asset => id(record(asset.tipoBem).id) === '421')
  if (!lotId || !auctionId) throw new Error('[pestana] Lote sem identidade oficial.')
  if (!assets.length || lot.visivel === false) return null
  const asset = assets.find(asset => asset.ordem === 1) || assets[0]!
  const characteristics = rows(asset.caracteristicas)
  const characteristic = (...names: string[]) => {
    for (const name of names) {
      const item = characteristics.find(item => {
        const type = metadata.characteristicTypes.find(type => String(type.id) === String(item.tipo))
        return key(item.nome ?? type?.nome) === key(name)
      })
      if (item && text(item.valor)) return text(item.valor)
    }
    return null
  }
  const auction = metadata.auctions.find(auction => id(auction.id) === auctionId) || {}
  if (auction.privado === true || auction.leilaoRestrito === true) return null
  const title = text(lot.descricao) || text(asset.descricao) || `Lote ${text(lot.numero) || lotId}`
  const identityTitle = text(lot.descricao) && !/^lote contendo\b/i.test(title) ? title : text(asset.descricao) || title
  const fallbackTitle = identityTitle.replace(/^(?:[A-Z]{3}[0-9][A-Z0-9][0-9]{2}\s+)?(?:utilit[aá]rio|autom[oó]vel|camioneta|caminh[aã]o(?:\/trator)?|motocicleta|moto)\s+/i, '')
  const fallbackBrand = fallbackTitle.match(/^(Mercedes[ -]Benz|Land Rover|[\wÀ-ÿ-]+)/i)?.[1] || 'UNKNOWN'
  const brandRaw = characteristic('Marca') || fallbackBrand
  const aliases: Record<string, string> = { vw: 'VOLKSWAGEN', gm: 'CHEVROLET', 'mercedes benz': 'MERCEDES-BENZ', 'mercedes-benz': 'MERCEDES-BENZ' }
  const brand = aliases[key(brandRaw)] || brandRaw.toUpperCase()
  const model = characteristic('Modelo') || fallbackTitle.slice(fallbackBrand.length).split(/\b(?:19|20)\d{2}\b/)[0]!.trim() || title
  const years = (characteristic('Mod.', 'Ano') || fallbackTitle).match(/\b(?:19|20)\d{2}\b/g)
  const year = years?.length ? Number(years[years.length - 1]) : null
  const footer = record(lot.footer)
  const time = pestanaDate(auction.exibirData === false || (!auction.data && footer.exibirData === false) ? null : auction.data ?? footer.date)
  const statusNames: Record<number, string> = { 1: 'Disponível', 2: 'Em pregão', 3: 'Vendido', 4: 'Não vendido', 5: 'Condicional', 6: 'Aguardando repasse', 7: 'Cancelado', 8: 'Retirado' }
  const status = text(lot.status) || statusNames[Number(lot.situacaoId)] || null
  const normalizedStatus = key(status)
  const saleStatus = normalizedStatus === 'vendido' ? 'sold' : normalizedStatus === 'condicional' ? 'conditional' : normalizedStatus === 'nao vendido' ? 'not_sold' : 'unknown'
  const finished = saleStatus !== 'unknown' || ['cancelado', 'retirado'].includes(normalizedStatus) || key(auction.status) === 'encerrado'
  const price = money(lot.valor) ?? (lot.exibirLanceMinimo === true ? money(lot.lanceMinimo) : null) ?? (lot.exibirLanceInicial === false ? null : money(lot.lanceInicial) ?? money(lot.valorInicial))
  // Sem lance efetivo não transformar valor inicial em preço de arremate.
  const soldPrice = saleStatus === 'sold' ? money(lot.valor) : null
  const location = record(asset.localizacao)
  const address = record(asset.endereco)
  const city = characteristic('Cidade') || text(asset.cidade) || text(location.cidade) || text(address.cidade)
  const stateRaw = characteristic('UF') || text(asset.estado) || text(location.estado) || text(address.estado)
  const state = stateRaw && /^[a-z]{2}$/i.test(stateRaw) ? stateRaw.toUpperCase() : null
  const partner = record(lot.parceiro)
  const consignor = text(partner.nome) || text(metadata.partners.find(item => id(item.id) === id(partner.id))?.nome)
  const description = [title, ...assets.map(asset => text(asset.descricao)), characteristic('Descrição completa'), ...characteristics.map(item => {
    const name = text(item.nome) || text(metadata.characteristicTypes.find(type => String(type.id) === String(item.tipo))?.nome)
    return name && text(item.valor) ? `${name}: ${text(item.valor)}` : null
  })].filter((value): value is string => Boolean(value))
  const photos = assets.flatMap(asset => [record(asset.imagemPrincipal), ...rows(asset.imagens)])
  const imageUrls = [...new Set(photos.map(photo => image(photo.original) || image(photo.media) || image(photo.pequena)).filter((value): value is string => Boolean(value)))]
  const damage = characteristic('Monta')
  return {
    source: 'pestana', brand, model, year,
    damage: damage && !['nao se aplica', 'nao informado'].includes(key(damage)) ? damage : null,
    condition: characteristic('Condição do bem'),
    price, priceRaw: moneyText(price), imageUrls, description: [...new Set(description)].join('\n'),
    url: `${BASE_URL}/lote/${auctionId}/${lotId}`, auctionId,
    auctionUrl: metadata.roomUrls?.get(auctionId) ?? null,
    auctionDate: time.date, auctionTimeKnown: time.timeKnown, auctionEndsAt: null,
    lot: text(lot.numero), yard: [city, state].filter(Boolean).join(' - ') || null, city, state, consignor,
    km: characteristic('KM'), color: characteristic('Cor'), fuel: characteristic('Combustível'),
    fipe: money(characteristic('FIPE', 'Valor FIPE')), fipeRaw: characteristic('FIPE', 'Valor FIPE'),
    auctionStatus: finished ? 'finished' : time.date ? 'upcoming' : 'unknown',
    auctionStatusRaw: text(auction.status), auctionStatusCheckedAt: now,
    saleStatus, saleStatusRaw: status, saleStatusCheckedAt: now,
    soldPrice, soldPriceRaw: moneyText(soldPrice),
  }
}

export async function runPestanaScraper(options: ScraperOptions = {}, fetcher: Fetcher = fetch): Promise<RawScrapedVehicle[]> {
  const log = options.log || console.info
  const vehicles: RawScrapedVehicle[] = []
  let complete = false
  log('[scraper:pestana] iniciando')
  async function request(path: string, body?: unknown): Promise<string> {
    options.signal?.throwIfAborted()
    const controller = new AbortController()
    const abort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new Error('Tempo de consulta da Pestana excedido.')), 30_000)
    try {
      const response = await fetcher(new URL(path, BASE_URL), {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,text/html', 'Accept-Language': 'pt-BR,pt;q=0.9', Referer: PESTANA_LIST_URL, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
      })
      const html = await response.text()
      if (/Radware Captcha|captcha\.perfdrive|activity and behavior on this site made us think that you are a bot/i.test(html)) throw new Error('[pestana] Acesso bloqueado por CAPTCHA; tente novamente após liberar o acesso à Pestana no ambiente do scraper.')
      if (!response.ok) throw new Error(`[pestana] HTTP ${response.status} em ${path.split('?')[0]}.`)
      return html
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
    }
  }
  async function json(path: string, body?: unknown): Promise<unknown> {
    try { return JSON.parse(await request(path, body)) as unknown }
    catch (error) {
      if (error instanceof SyntaxError) throw new Error(`[pestana] Resposta inválida em ${path}; coleta não concluída.`)
      throw error
    }
  }
  try {
    const html = await request(PESTANA_LIST_URL)
    const auctions = pestanaHydration(html, '__hydrateLeilao') ?? await json('/api/v2/leilao')
    const types = pestanaHydration(html, '__hydrateLoteCaracteristicaTipo')
    const partners = pestanaHydration(html, '__hydrateParceiro')
    if (!Array.isArray(auctions)) throw new Error('[pestana] Lista de leilões inválida.')
    const roomUrls = new Map<string, string>()
    // Guarda somente salas explicitamente publicadas no HTML, nunca deriva de lote/catálogo.
    for (const match of html.matchAll(/href=["']([^"']*\/(\d+)\/aovivo(?:[?#][^"']*)?)["']/gi)) {
      const url = new URL(match[1]!.replace(/&amp;/g, '&'), BASE_URL)
      if (url.protocol === 'https:' && !url.username && !url.password && ['www.pestanaleiloes.com.br', 'pestanaleiloes.com.br'].includes(url.hostname) && /^\/\d+\/aovivo$/.test(url.pathname)) {
        url.hash = ''
        roomUrls.set(match[2]!, url.href)
      }
    }
    const metadata: PestanaMetadata = { auctions: rows(auctions), characteristicTypes: rows(types), partners: rows(partners), roomUrls }
    // O portal retorna todos os IDs; lotePage/loteQty paginam somente a tela.
    const ids = pestanaLotIds(await json('/search-api/lote/filtrar', { tipoBem: [421] }))
    log(`[pestana] ${ids.length} lote(s) na categoria Veículos.`)
    for (let index = 0; index < ids.length; index += BATCH_SIZE) {
      const batch = ids.slice(index, index + BATCH_SIZE)
      const details = await json('/api/v2/lote/por-ids', { ids: batch })
      if (!Array.isArray(details)) throw new Error('[pestana] Resposta de detalhes sem lista de lotes.')
      const found = new Map(rows(details).map(lot => [Number(id(lot.id)), lot]))
      const missing = batch.filter(identifier => !found.has(identifier))
      for (const identifier of batch) {
        options.signal?.throwIfAborted()
        const lot = found.get(identifier)
        if (!lot) continue
        const vehicle = parsePestanaLot(lot, metadata)
        if (!vehicle) continue
        await options.onVehicle?.(vehicle)
        vehicles.push(vehicle)
      }
      log(`[pestana] Detalhes: ${Math.min(index + BATCH_SIZE, ids.length)}/${ids.length}; ${vehicles.length} veículo(s).`)
      if (missing.length) throw new Error(`[pestana] ${missing.length} lote(s) sem detalhes; coleta incompleta.`)
      if (index + BATCH_SIZE < ids.length) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    complete = true
    return vehicles
  } catch (error) {
    if (vehicles.length && !options.signal?.aborted) throw new PartialScraperResultError(error instanceof Error ? error.message : String(error), vehicles)
    throw error
  } finally { log(`[scraper:pestana] finalizado (${complete ? 'completo' : 'incompleto'}): ${vehicles.length} veículo(s).`) }
}

export const pestanaSource: ScraperSource = {
  id: 'pestana', name: 'Pestana Leilões',
  run: (_filters, options) => runPestanaScraper(options),
}
