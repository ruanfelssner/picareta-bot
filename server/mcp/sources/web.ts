import { dedupeByUrl, extractOemCode, httpsUrl, listing, parseBrlPrice, stripHtml, type Listing } from '../listing'
import { fetchJson, HttpStatusError, McpToolError } from '../runtime'

/**
 * Pesquisa na web aberta por peças (lojas de autopeças, marketplaces, catálogos).
 *
 * Provedor: Brave Search API. A Custom Search JSON API do Google está fechada para novos clientes
 * (jan/2026) e será desligada em 01/01/2027, e o Google não oferece outra API de busca web aberta
 * self-service. A chave fica só no backend (`BRAVE_SEARCH_API_KEY`).
 */

const API_URL = 'https://api.search.brave.com/res/v1/web/search'
const REQUEST_TIMEOUT_MS = 12_000

/** Lojas conhecidas sobem na ordenação quando `focus = lojas`; nenhuma é excluída. */
const KNOWN_STORE_HOSTS = [
  'mercadolivre.com.br',
  'connectparts.com.br',
  'jocar.com.br',
  'amazon.com.br',
  'shopee.com.br',
  'magazineluiza.com.br',
  'americanas.com.br',
  'olx.com.br',
]

export interface WebSearchInput {
  query: string
  focus: 'lojas' | 'geral'
  maxResults: number
}

interface BraveResult {
  title?: string
  url?: string
  description?: string
  extra_snippets?: string[]
  thumbnail?: { src?: string, original?: string }
  meta_url?: { hostname?: string }
  profile?: { name?: string }
}
interface BraveResponse { web?: { results?: BraveResult[] } }

export function isWebSearchConfigured(): boolean {
  return Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim())
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  }
  catch {
    return ''
  }
}

function isKnownStore(host: string): boolean {
  return KNOWN_STORE_HOSTS.some(store => host === store || host.endsWith(`.${store}`))
}

function toListing(result: BraveResult): (Listing & { store: string }) | null {
  const url = httpsUrl(result.url)
  const title = stripHtml(result.title)
  if (!url || !title) return null
  const description = stripHtml(result.description)
  const snippets = (result.extra_snippets ?? []).map(stripHtml)
  const fullText = [description, ...snippets].join(' ')
  const priceText = /R\$\s*[\d.]+(?:,\d{1,2})?/.exec(fullText)?.[0] ?? null
  const condition = /\bseminov|\busad[oa]/i.test(`${title} ${description}`)
    ? 'usado'
    : /\bnov[oa]\b/i.test(`${title} ${description}`) ? 'novo' : null
  const store = result.profile?.name || result.meta_url?.hostname || hostOf(url)

  return {
    ...listing({
      title,
      price: parseBrlPrice(priceText),
      priceText,
      location: null,
      condition,
      conditionDetail: description ? description.slice(0, 240) : null,
      oemCode: extractOemCode(title, fullText),
      imageUrl: httpsUrl(result.thumbnail?.original ?? result.thumbnail?.src),
      url,
      platform: 'web',
      platformName: store,
    }),
    store: hostOf(url),
  }
}

export async function searchWeb(input: WebSearchInput) {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY?.trim()
  if (!apiKey) {
    throw new McpToolError('Busca web não configurada: defina BRAVE_SEARCH_API_KEY no backend (ver docs/26-mcp-chatgpt.md).')
  }

  const query = input.focus === 'lojas' && !/\b(comprar|pre[cç]o|loja)\b/i.test(input.query)
    ? `${input.query} comprar`
    : input.query
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(20, input.maxResults * 2)),
    country: 'BR',
    search_lang: 'pt-br',
    ui_lang: 'pt-BR',
    safesearch: 'moderate',
    extra_snippets: 'true',
  })

  let response: BraveResponse
  try {
    response = await fetchJson<BraveResponse>(`${API_URL}?${params}`, {
      headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: 'Busca web',
    })
  }
  catch (error) {
    if (!(error instanceof HttpStatusError)) throw error
    console.warn(`[mcp:web] Brave HTTP ${error.status}: ${error.body.slice(0, 160)}`)
    if (error.status === 401 || error.status === 403) throw new McpToolError('Busca web: chave BRAVE_SEARCH_API_KEY inválida ou sem plano ativo.')
    if (error.status === 429) throw new McpToolError('Busca web: limite do plano atingido. Tente mais tarde.')
    throw new McpToolError(`Busca web indisponível (HTTP ${error.status}).`)
  }

  let results = dedupeByUrl(
    (response.web?.results ?? [])
      .map(toListing)
      .filter((item): item is Listing & { store: string } => item !== null),
  )
  if (input.focus === 'lojas') {
    // Ordenação estável: lojas conhecidas e resultados com preço primeiro.
    const rank = (item: Listing & { store: string }) => (isKnownStore(item.store) ? 0 : 2) + (item.price != null ? 0 : 1)
    results = results
      .map((item, index) => ({ item, index }))
      .sort((first, second) => rank(first.item) - rank(second.item) || first.index - second.index)
      .map(({ item }) => item)
  }

  return {
    platform: 'web',
    provider: 'Brave Search',
    returned: Math.min(results.length, input.maxResults),
    results: results.slice(0, input.maxResults),
    note: 'Preço extraído do resumo da página quando aparece; confirme no site da loja.',
  }
}
