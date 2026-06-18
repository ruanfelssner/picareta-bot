import { chromium } from 'playwright'
import type { AuctionFilters } from '#shared/types/filters'
import type { RawScrapedVehicle, ScraperOptions, ScraperSource } from '../source-types'
import { buildPlaywrightLaunchOptions } from '../playwright-launch'

const SEARCH_URL = 'https://www.sodresantoro.com.br/veiculos/lotes?lot_category=carros'
const API_URL = 'https://www.sodresantoro.com.br/api/search-lots'
const LOT_BASE = 'https://leilao.sodresantoro.com.br/leilao'
const PAGE_SIZE = 200
const MAX_PAGES = 50

type SodreItem = {
  lot_id: number; auction_id: number; lot_brand: string; lot_model: string
  lot_year_manufacture: number; lot_year_model: number; lot_sinister: string
  bid_actual: string; lot_pictures: string[]; lot_description: string
  lot_km: number; lot_color: string; auction_date_init: string
  [key: string]: unknown
}

type SodreSearchResponse = {
  error?: number
  results?: SodreItem[]
  total?: number
}

function buildPayload(options: { includeLocationCategoryFilter: boolean; from: number }): object {
  const filterClauses: object[] = []
  if (options.includeLocationCategoryFilter) {
    filterClauses.push({ terms: { lot_category: ['carros'] } })
  }
  return {
    indices: ['veiculos', 'judiciais-veiculos'],
    query: {
      bool: {
        filter: [
          { bool: { should: [{ bool: { must: [{ term: { auction_status: 'online' } }] } }, { bool: { must: [{ term: { auction_status: 'aberto' } }], must_not: [{ terms: { lot_status_id: [5, 7] } }] } }, { bool: { must: [{ term: { auction_status: 'encerrado' } }, { terms: { lot_status_id: [6] } }] } }], minimum_should_match: 1 } },
          { bool: { should: [{ bool: { must_not: { term: { lot_status_id: 6 } } } }, { bool: { must: [{ term: { lot_status_id: 6 } }, { term: { segment_id: 1 } }] } }], minimum_should_match: 1 } },
          { bool: { should: [{ bool: { must_not: [{ term: { lot_test: true } }] } }], minimum_should_match: 1 } },
        ],
      },
    },
    post_filter: { bool: { filter: filterClauses } },
    from: options.from,
    size: PAGE_SIZE,
    sort: [{ lot_status_id_order: { order: 'asc' } }, { auction_date_init: { order: 'asc' } }],
  }
}

function parsePrice(bidActual: string): number | null {
  const n = parseFloat(bidActual)
  return isNaN(n) || n <= 0 ? null : Math.round(n)
}

function parseDate(dateStr: string): Date | null {
  const m = dateStr?.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return null
  return new Date(parseInt(m[1]!), parseInt(m[2]!) - 1, parseInt(m[3]!))
}

function capitalize(s: string): string {
  if (!s) return s
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim()
}

function extractYardFromDescription(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw)
  if (!text) return null
  const match = text.match(/(?:Local(?:iza(?:ção|cao)\s+do\s+lote| do lote)?|P[aá]tio)\s*:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)(?=\s+(?:Lance|Leil[aã]o|Situa[cç][aã]o|Status)\b|$)/i)
  return match?.[1]?.trim() || null
}

function extractSodreYard(item: SodreItem): string | null {
  const dynamic = item as Record<string, unknown>
  const candidateKeys = ['lot_location', 'lot_local', 'lot_locality', 'lot_city', 'lot_state', 'yard', 'yard_name', 'auction_place', 'auction_location', 'deposito']
  for (const key of candidateKeys) {
    const value = dynamic[key]
    if (typeof value !== 'string') continue
    const cleaned = normalizeSpace(value)
    if (cleaned) return cleaned
  }
  const city = normalizeSpace(typeof dynamic.lot_city === 'string' ? dynamic.lot_city : '')
  const state = normalizeSpace(typeof dynamic.lot_state === 'string' ? dynamic.lot_state : '')
  if (city && state && !city.toUpperCase().includes(state.toUpperCase())) return `${city} - ${state}`
  return extractYardFromDescription(item.lot_description)
}

function mapSodreItemToRawVehicle(item: SodreItem, log?: (msg: string) => void): RawScrapedVehicle {
  const brandRaw = (item.lot_brand ?? '').trim()
  const year = item.lot_year_model ?? item.lot_year_manufacture ?? null
  const price = parsePrice(item.bid_actual)
  const modelRaw = (item.lot_model ?? '').trim()
  const damage = item.lot_sinister?.trim() || null
  const priceRaw = price !== null ? `R$ ${price.toLocaleString('pt-BR')}` : null
  const kmNum = typeof item.lot_km === 'number' ? item.lot_km : parseInt(String(item.lot_km ?? 0), 10)
  const km = kmNum > 0 ? kmNum.toLocaleString('pt-BR') : null
  log?.(`[sodre] ${brandRaw || 'UNKNOWN'} ${modelRaw} — km=${kmNum} cor=${item.lot_color ?? '?'} preço=${price}`)
  const color = capitalize(item.lot_color ?? '') || null
  const yard = extractSodreYard(item)

  return {
    source: 'sodre',
    brand: (brandRaw || 'UNKNOWN').trim() || 'UNKNOWN',
    model: modelRaw,
    year,
    damage,
    price,
    priceRaw,
    imageUrls: (item.lot_pictures ?? []).filter((u) => u?.startsWith('http')).slice(0, 4),
    description: (item.lot_description ?? '').replace(/\r\n/g, ' ').trim().slice(0, 200),
    url: `${LOT_BASE}/${item.auction_id}/lote/${item.lot_id}/`,
    auctionDate: parseDate(item.auction_date_init),
    lot: String(item.lot_id),
    km,
    color,
    yard,
    fipe: null,
  }
}

async function run(
  _filters: AuctionFilters,
  options?: ScraperOptions,
): Promise<RawScrapedVehicle[]> {
  const log = options?.log ?? console.log
  const headless = options?.headless ?? true
  log('[sodre] Iniciando (fetch via browser)...')

  const browser = await chromium.launch(buildPlaywrightLaunchOptions(headless))
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', locale: 'pt-BR' })
  const page = await context.newPage()

  let items: SodreItem[] = []

  try {
    await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    log('[sodre] Sessão estabelecida. Chamando API...')

    const fetchSearch = async (payload: object) =>
      page.evaluate(
        async ({ url, body }: { url: string; body: object }) => {
          const res = await fetch(url, {
            method: 'POST',
            headers: { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(body),
          })
          if (!res.ok) return { error: res.status, results: [] }
          return res.json()
        },
        { url: API_URL, body: payload },
      ) as Promise<SodreSearchResponse>

    const fetchAllPages = async (includeLocationCategoryFilter: boolean): Promise<SodreSearchResponse> => {
      const collected: SodreItem[] = []
      let total: number | null = null

      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber++) {
        if (options?.signal?.aborted) break

        const from = (pageNumber - 1) * PAGE_SIZE
        const result = await fetchSearch(buildPayload({ includeLocationCategoryFilter, from }))
        if (result.error) return result

        const pageItems = result.results ?? []
        if (typeof result.total === 'number' && Number.isFinite(result.total) && result.total >= 0) {
          total = result.total
        }

        collected.push(...pageItems)
        const progress = total === null ? String(collected.length) : `${collected.length}/${total}`
        log(`[sodre] Página ${pageNumber}: ${pageItems.length} lote(s) recebido(s) (${progress}).`)

        if (pageItems.length < PAGE_SIZE || (total !== null && collected.length >= total)) break
        if (pageNumber === MAX_PAGES) {
          log(`[sodre] Limite defensivo de ${MAX_PAGES} páginas atingido.`)
        }
      }

      return { results: collected, total: total ?? collected.length }
    }

    let result = await fetchAllPages(true)
    if (result.error) { log(`[sodre] API retornou erro: HTTP ${result.error}`); return [] }

    items = result.results ?? []
    log(`[sodre] ${items.length} lote(s) recebidos (categoria carros).`)

    if (items.length === 0) {
      log('[sodre] Sem lotes no filtro. Tentando fallback sem filtro fixo...')
      result = await fetchAllPages(false)
      if (result.error) { log(`[sodre] Fallback API erro: HTTP ${result.error}`); return [] }
      items = result.results ?? []
      log(`[sodre] ${items.length} lote(s) recebidos no fallback.`)
    }
  }
  catch (err) {
    log(`[sodre] Erro: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  finally {
    await browser.close()
  }

  const results: RawScrapedVehicle[] = items.map((item) => mapSodreItemToRawVehicle(item, log))
  log(`[sodre] Total: ${results.length} veículo(s).`)
  return results
}

export const sodreSource: ScraperSource = {
  id: 'sodre',
  name: 'Sodre Santoro',
  run,
}
