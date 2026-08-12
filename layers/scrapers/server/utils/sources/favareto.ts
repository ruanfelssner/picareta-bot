import { load } from 'cheerio'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperSource } from '../source-types'

const BASE = 'https://www.favaretoleiloes.com.br'
const LEILOES_URL = `${BASE}/leiloes/`
const API_URL = `${BASE}/classes/json_lance.php`

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
}

type LotApiResponse = {
  veiculo: string; ano: string; cor: string; combustivel: string; km: string | number
  minimo: string; numlote: string; tipo: string; bem: string; ordem: string; data: string
  obs: string; path_foto: string; foto0?: string; foto1?: string; foto2?: string
  foto3?: string; foto4?: string; foto5?: string; foto6?: string; foto7?: string; foto8?: string
  qtde: number; stl?: string | number
}

type LotHistoryResponse = {
  top_lance?: string | null; lance_atual?: string | number | null
  of1?: string | null; tem_lance?: string | number | null; stl?: string | number | null
}

type EditalRow = { editalId: number; seq: number; descRaw: string; brandRaw: string; editalBidRaw: string | null }

async function fetchHtml(url: string, log: (m: string) => void): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS })
    if (!res.ok) { log(`[favareto] HTTP ${res.status} em ${url}`); return null }
    return res.text()
  }
  catch (err) {
    log(`[favareto] Erro em ${url}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchLotDetails(editalId: number, seq: number): Promise<LotApiResponse | null> {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${BASE}/lance/${editalId}/${seq}/`,
        'User-Agent': HEADERS['User-Agent'],
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: `ordem=${seq}&leilao=${editalId}`,
    })
    if (!res.ok) return null
    return res.json() as Promise<LotApiResponse>
  }
  catch { return null }
}

async function fetchLotHistory(editalId: number, seq: number, lotDate: string): Promise<LotHistoryResponse | null> {
  try {
    const params = new URLSearchParams({ seq: String(seq), data: String(editalId), dataleilao: String(lotDate ?? '') })
    const res = await fetch(`${BASE}/classes/json_historico.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': `${BASE}/lance/${editalId}/${seq}/`,
        'User-Agent': HEADERS['User-Agent'],
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
    })
    if (!res.ok) return null
    return res.json() as Promise<LotHistoryResponse>
  }
  catch { return null }
}

function parseEditalId(url: string): number | null {
  const m = url.match(/\/edital\/(\d+)/)
  return m ? parseInt(m[1]!, 10) : null
}

function parseYear(text: string): number | null {
  const m = text.match(/\b(20\d{2})\/(?:20\d{2})\b/)
  return m ? parseInt(m[1]!, 10) : null
}

function parsePrice(rawValue: string | number | null | undefined): number | null {
  if (rawValue == null) return null
  let raw = String(rawValue).trim().replace(/ /g, ' ').replace(/R\$\s*/gi, '').trim()
  if (!raw) return null
  if (raw.includes(',') && raw.includes('.')) {
    raw = raw.replace(/\./g, '').replace(',', '.')
  }
  else if (raw.includes(',')) {
    raw = raw.replace(',', '.')
  }
  else {
    const dots = (raw.match(/\./g) ?? []).length
    if (dots > 1) { raw = raw.replace(/\./g, '') }
    else if (dots === 1) {
      const [left, right] = raw.split('.')
      if ((right?.length ?? 0) === 3) raw = `${left}${right}`
    }
  }
  raw = raw.replace(/[^\d.-]/g, '')
  if (!raw) return null
  const numeric = Number.parseFloat(raw)
  return Number.isFinite(numeric) && numeric > 0 ? Math.round(numeric) : null
}

function pickLotPrice(
  lot: LotApiResponse,
  history: LotHistoryResponse | null,
  editalBidRaw: string | null,
): { price: number | null; priceRaw: string | null } {
  const fromHistory = parsePrice(history?.top_lance) ?? parsePrice(history?.lance_atual) ?? parsePrice(history?.of1)
  if (fromHistory != null) return { price: fromHistory, priceRaw: `R$ ${fromHistory.toLocaleString('pt-BR')}` }
  const fromEdital = parsePrice(editalBidRaw)
  if (fromEdital != null) return { price: fromEdital, priceRaw: `R$ ${fromEdital.toLocaleString('pt-BR')}` }
  const fromMinimo = parsePrice(lot.minimo)
  if (fromMinimo != null) return { price: fromMinimo, priceRaw: `R$ ${fromMinimo.toLocaleString('pt-BR')}` }
  return { price: null, priceRaw: null }
}

function buildImageUrls(lot: LotApiResponse): string[] {
  const urls: string[] = []
  const count = Math.min(lot.qtde ?? 0, 4)
  const keys: Array<keyof LotApiResponse> = ['foto0', 'foto1', 'foto2', 'foto3', 'foto4', 'foto5', 'foto6', 'foto7', 'foto8']
  for (let i = 0; i < count; i++) {
    const fname = lot[keys[i]!] as string | undefined
    if (!fname?.trim()) continue
    try {
      const path = String(lot.path_foto ?? '').trim()
      const base = path ? new URL(path.endsWith('/') ? path : `${path}/`, BASE).toString() : `${BASE}/`
      const photo = fname.trim()
      urls.push(new URL(/^https?:\/\//i.test(photo) ? photo : photo.replace(/^\/+/, ''), base).toString())
    } catch {
      // Uma foto malformada não deve descartar o lote inteiro.
    }
  }
  return urls
}

function parseAuctionDate(data: string): Date | null {
  const m = data.match(/(\d{2})\/(\d{2})\/(\d{2,4})/)
  if (!m) return null
  const y = m[3]!.length === 2 ? 2000 + parseInt(m[3]!, 10) : parseInt(m[3]!, 10)
  return new Date(y, parseInt(m[2]!, 10) - 1, parseInt(m[1]!, 10))
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

const FAVARETO_BRAND_ALIASES: Record<string, string> = {
  GM: 'CHEVROLET',
  LR: 'LAND ROVER',
}

function normalizeFavaretoBrand(raw: string | null | undefined): string {
  const brand = normalizeSpace(raw).toUpperCase()
  return FAVARETO_BRAND_ALIASES[brand] ?? brand
}

export function parseFavaretoVehicleIdentity(
  raw: string | null | undefined,
  fallbackBrandRaw?: string | null,
): { brand: string; model: string } {
  const vehicle = normalizeSpace(raw)
    .replace(/^(?:I|IMPORTADO)(?:\s*\/\s*|\s+)/i, '')
    .replace(/\s*\/\s*/g, '/')

  const [brandPart = '', ...modelParts] = vehicle.split('/')
  const hasBrandSeparator = modelParts.length > 0
  const fallbackBrand = normalizeFavaretoBrand(fallbackBrandRaw)
  const brand = normalizeFavaretoBrand(brandPart) || fallbackBrand || 'UNKNOWN'
  const model = hasBrandSeparator
    ? normalizeSpace(modelParts.join('/'))
    : normalizeSpace(vehicle.split(/\s+/).slice(1).join(' '))

  return { brand, model: model || 'SEM MODELO' }
}

function normalizeYardToken(raw: string): string {
  return normalizeSpace(raw).replace(/\s*\/\s*/g, '/').replace(/\s*-\s*/g, ' - ').trim()
}

function extractFavaretoYardFromText(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw)
  if (!text) return null
  const transferMatch = text.match(/Transferid[oa]\s+em\s*:?\s*([A-Za-zÀ-ÿ0-9 .()/-]+?)(?=\s*(?:\||·|Lote|Data|Leil[aã]o|$))/i)
    ?? text.match(/P[aá]tio\s*:?\s*([A-Za-zÀ-ÿ0-9 .()/-]+?)(?=\s*(?:\||·|Lote|Data|Leil[aã]o|$))/i)
  if (transferMatch?.[1]) return normalizeYardToken(transferMatch[1])
  const cityUfMatch = text.match(/\b([A-Za-zÀ-ÿ ]{2,})\s*[-/]\s*([A-Z]{2})\b/)
  if (cityUfMatch) return normalizeYardToken(`${cityUfMatch[1]} - ${cityUfMatch[2]}`)
  return null
}

function extractFavaretoYard(lot: LotApiResponse, row: EditalRow): string | null {
  return extractFavaretoYardFromText(lot.obs)
    ?? extractFavaretoYardFromText(lot.veiculo)
    ?? extractFavaretoYardFromText(lot.bem)
    ?? extractFavaretoYardFromText(row.descRaw)
    ?? 'Curitiba - PR'
}

function parseEditalRows(html: string, editalId: number): EditalRow[] {
  const $ = load(html)
  const rows: EditalRow[] = []

  $('table tr').each((_i, tr) => {
    const cells = $(tr).find('td')
    if (cells.length < 2) return
    const onclick = $(tr).find('a[onclick]').attr('onclick') ?? ''
    const seqM = onclick.match(/tela_lance\(\s*\d+\s*,\s*(\d+)\s*\)/)
    if (!seqM) return
    const seq = parseInt(seqM[1]!, 10)
    const descRaw = cells.eq(1).text().trim()
    if (!descRaw) return
    const { brand: brandRaw } = parseFavaretoVehicleIdentity(descRaw)
    const bidRaw = normalizeSpace(cells.eq(6).text() ?? '')
    const editalBidRaw = bidRaw && !/\*{2,}/.test(bidRaw) ? bidRaw : null
    rows.push({ editalId, seq, descRaw, brandRaw, editalBidRaw })
  })

  return rows
}

async function run(
  _filters: AuctionFilters,
  options?: { log?: (msg: string) => void },
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  log('[favareto] Buscando lista de leilões...')

  const leiloesHtml = await fetchHtml(LEILOES_URL, log)
  if (!leiloesHtml) { log('[favareto] Falha ao carregar página de leilões.'); return [] }

  const $ = load(leiloesHtml)
  const editalUrls: string[] = []
  $('a').each((_i, el) => {
    const href = $(el).attr('href') ?? ''
    if (/edital\/\d+/i.test(href) && !href.startsWith('javascript')) {
      const abs = href.startsWith('http') ? href : `${BASE}/${href.replace(/^\//, '')}`
      if (!editalUrls.includes(abs)) editalUrls.push(abs)
    }
  })

  if (editalUrls.length === 0) { log('[favareto] Nenhum edital encontrado.'); return [] }
  log(`[favareto] ${editalUrls.length} edital(is): ${editalUrls.join(', ')}`)

  const allResults: RawScrapedVehicle[] = []
  const seenKeys = new Set<string>()

  for (const editalUrl of editalUrls.slice(0, 3)) {
    const editalId = parseEditalId(editalUrl)
    if (!editalId) continue

    const editalHtml = await fetchHtml(editalUrl, log)
    if (!editalHtml) continue

    const rows = parseEditalRows(editalHtml, editalId)
    log(`[favareto] edital ${editalId}: ${rows.length} lote(s) total.`)

    for (const row of rows) {
      const lot = await fetchLotDetails(row.editalId, row.seq)
      if (!lot) continue
      const history = await fetchLotHistory(row.editalId, row.seq, lot.data)

      const year = parseYear(lot.ano)
      const { price, priceRaw } = pickLotPrice(lot, history, row.editalBidRaw)

      const identity = parseFavaretoVehicleIdentity(lot.veiculo, row.brandRaw)

      const imageUrls = buildImageUrls(lot)
      const kmRaw = lot.km ? String(lot.km).replace(/\D/g, '') : null
      const km = kmRaw ? Number(kmRaw).toLocaleString('pt-BR') : null
      const yard = extractFavaretoYard(lot, row)
      const lotUrl = `${BASE}/lance/${row.editalId}/${row.seq}/`
      const key = `${identity.brand}|${lot.bem}|${row.editalId}`
      if (seenKeys.has(key)) continue
      seenKeys.add(key)

      allResults.push({
        source: 'favareto',
        brand: identity.brand,
        model: identity.model,
        year,
        damage: null,
        price,
        priceRaw,
        imageUrls,
        description: (lot.obs || '').slice(0, 200),
        url: lotUrl,
        auctionDate: parseAuctionDate(lot.data),
        lot: lot.numlote || String(row.seq),
        km,
        color: lot.cor || null,
        fuel: lot.combustivel || null,
        yard,
        fipe: null,
      })

      await new Promise((r) => setTimeout(r, 200))
    }
  }

  log(`[favareto] Total: ${allResults.length} veículo(s).`)
  return allResults
}

export const favaretoSource: ScraperSource = {
  id: 'favareto',
  name: 'Favareto Leilões',
  run,
}
