import { isDbConnected, useDb } from '../../utils/db'
import { extractOemCode, httpsUrl, listing, type Listing, type ListingCondition } from '../listing'
import { fetchJson, HttpStatusError, McpToolError } from '../runtime'

/**
 * Busca de peças na API oficial do Mercado Livre (site MLB).
 *
 * A busca exige access token OAuth. O token dura ~6 h e o refresh token do ML é de uso único:
 * cada renovação devolve um novo, que é gravado em `mcp_integration_tokens` (Mongo de dados) para
 * sobreviver a reinícios. `MERCADOLIVRE_REFRESH_TOKEN` é só o valor inicial (ou de recuperação).
 * Nada disso sai do backend.
 */

const API_BASE = 'https://api.mercadolibre.com'
const REQUEST_TIMEOUT_MS = 12_000
const TOKEN_COLLECTION = 'mcp_integration_tokens'
const TOKEN_DOC_ID = 'mercadolivre'
const TOKEN_RENEW_MARGIN_MS = 5 * 60_000
/** Filtro ITEM_CONDITION do site MLB. */
const CONDITION_FILTER: Record<'novo' | 'usado', string> = { novo: '2230284', usado: '2230581' }
const OEM_ATTRIBUTE_IDS = new Set(['PART_NUMBER', 'OEM', 'OEM_PART_NUMBER', 'MPN', 'ORIGINAL_PART_NUMBER'])

export interface MercadoLivreSearchInput {
  query: string
  condition: 'novo' | 'usado' | null
  minPrice: number | null
  maxPrice: number | null
  maxResults: number
}

interface TokenDoc {
  _id: string
  refreshToken: string
  accessToken: string | null
  accessTokenExpiresAt: Date | null
  updatedAt: Date
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
}

interface MlAttribute { id?: string, value_name?: string | null }
interface MlItem {
  id: string
  title: string
  price: number | null
  currency_id?: string
  condition?: string
  thumbnail?: string
  permalink: string
  attributes?: MlAttribute[]
  address?: { city_name?: string, state_name?: string }
  seller_address?: { city?: { name?: string }, state?: { name?: string } }
  shipping?: { free_shipping?: boolean }
}
interface MlSearchResponse { results: MlItem[], paging?: { total?: number } }

let cachedToken: { value: string, expiresAt: number } | null = null
let pendingRefresh: Promise<string | null> | null = null

function credentials() {
  const clientId = process.env.MERCADOLIVRE_CLIENT_ID?.trim()
  const clientSecret = process.env.MERCADOLIVRE_CLIENT_SECRET?.trim()
  const envRefreshToken = process.env.MERCADOLIVRE_REFRESH_TOKEN?.trim() || null
  return clientId && clientSecret ? { clientId, clientSecret, envRefreshToken } : null
}

export function isMercadoLivreConfigured(): boolean {
  return credentials() !== null
}

function tokenCollection() {
  return useDb().collection<TokenDoc>(TOKEN_COLLECTION)
}

async function refreshAccessToken(): Promise<string | null> {
  const creds = credentials()
  if (!creds) return null

  const stored = isDbConnected() ? await tokenCollection().findOne({ _id: TOKEN_DOC_ID }) : null
  if (stored?.accessToken && stored.accessTokenExpiresAt && stored.accessTokenExpiresAt.getTime() - TOKEN_RENEW_MARGIN_MS > Date.now()) {
    cachedToken = { value: stored.accessToken, expiresAt: stored.accessTokenExpiresAt.getTime() }
    return stored.accessToken
  }

  // O refresh token gravado é o mais recente; o da env serve de recuperação após reconfiguração manual.
  const candidates = [...new Set([stored?.refreshToken, creds.envRefreshToken].filter((token): token is string => Boolean(token)))]
  if (candidates.length === 0) return null

  for (const refreshToken of candidates) {
    try {
      const response = await fetchJson<TokenResponse>(`${API_BASE}/oauth/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: refreshToken,
        }).toString(),
        timeoutMs: REQUEST_TIMEOUT_MS,
        label: 'Mercado Livre (token)',
      })
      const expiresAt = Date.now() + Math.max(60, response.expires_in) * 1000
      cachedToken = { value: response.access_token, expiresAt }
      if (isDbConnected()) {
        await tokenCollection().updateOne(
          { _id: TOKEN_DOC_ID },
          {
            $set: {
              refreshToken: response.refresh_token ?? refreshToken,
              accessToken: response.access_token,
              accessTokenExpiresAt: new Date(expiresAt),
              updatedAt: new Date(),
            },
          },
          { upsert: true },
        )
      }
      else {
        console.warn('[mcp:mercadolivre] Mongo indisponível: o novo refresh token não foi persistido.')
      }
      console.info('[mcp:mercadolivre] access token renovado')
      return response.access_token
    }
    catch (error) {
      const status = error instanceof HttpStatusError ? error.status : null
      console.warn(`[mcp:mercadolivre] falha ao renovar token${status ? ` (HTTP ${status})` : ''}`)
    }
  }

  throw new McpToolError(
    'Mercado Livre: não foi possível renovar o acesso. Gere um novo refresh token e atualize MERCADOLIVRE_REFRESH_TOKEN (ver docs/26-mcp-chatgpt.md).',
  )
}

async function getAccessToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt - TOKEN_RENEW_MARGIN_MS > Date.now()) return cachedToken.value
  pendingRefresh ??= refreshAccessToken().finally(() => {
    pendingRefresh = null
  })
  return pendingRefresh
}

function conditionOf(value: string | undefined): ListingCondition {
  if (value === 'new') return 'novo'
  if (value === 'used') return 'usado'
  if (value === 'refurbished') return 'recondicionado'
  return null
}

function toListing(item: MlItem): Listing | null {
  const url = httpsUrl(item.permalink)
  if (!url || !item.title) return null
  const oemAttribute = item.attributes?.find(attribute => attribute.id && OEM_ATTRIBUTE_IDS.has(attribute.id) && attribute.value_name)
  const city = item.address?.city_name ?? item.seller_address?.city?.name
  const state = item.address?.state_name ?? item.seller_address?.state?.name
  return listing({
    title: item.title,
    price: typeof item.price === 'number' ? item.price : null,
    priceText: typeof item.price === 'number'
      ? item.price.toLocaleString('pt-BR', { style: 'currency', currency: item.currency_id || 'BRL' })
      : null,
    location: [city, state].filter(Boolean).join(' - ') || null,
    condition: conditionOf(item.condition),
    conditionDetail: item.shipping?.free_shipping ? 'Frete grátis' : null,
    oemCode: oemAttribute?.value_name?.trim() || extractOemCode(item.title),
    // "-I.jpg" é a miniatura; "-O.jpg" é a versão maior servida pelo mesmo CDN.
    imageUrl: httpsUrl(item.thumbnail?.replace(/-I\.(jpg|webp)$/i, '-O.$1')),
    url,
    platform: 'mercadolivre',
    platformName: 'Mercado Livre',
  })
}

export async function searchMercadoLivre(input: MercadoLivreSearchInput) {
  const params = new URLSearchParams({ q: input.query, limit: String(input.maxResults) })
  if (input.condition) params.set('ITEM_CONDITION', CONDITION_FILTER[input.condition])
  if (input.minPrice != null || input.maxPrice != null) {
    params.set('price', `${input.minPrice ?? '*'}-${input.maxPrice ?? '*'}`)
  }

  const token = await getAccessToken()
  const headers: Record<string, string> = { accept: 'application/json' }
  if (token) headers.authorization = `Bearer ${token}`

  let response: MlSearchResponse
  try {
    response = await fetchJson<MlSearchResponse>(`${API_BASE}/sites/MLB/search?${params}`, {
      headers,
      timeoutMs: REQUEST_TIMEOUT_MS,
      label: 'Mercado Livre',
    })
  }
  catch (error) {
    if (!(error instanceof HttpStatusError)) throw error
    console.warn(`[mcp:mercadolivre] busca recusada (HTTP ${error.status}): ${error.body.slice(0, 160)}`)
    if (error.status === 401 || error.status === 403) {
      if (token) cachedToken = null
      throw new McpToolError(token
        ? `Mercado Livre recusou a busca (HTTP ${error.status}). Verifique se o app do ML tem permissão de leitura e se o token é válido.`
        : 'Mercado Livre exige autenticação: configure MERCADOLIVRE_CLIENT_ID, MERCADOLIVRE_CLIENT_SECRET e MERCADOLIVRE_REFRESH_TOKEN no backend (ver docs/26-mcp-chatgpt.md).')
    }
    if (error.status === 429) throw new McpToolError('Mercado Livre: limite de requisições atingido. Tente novamente em alguns minutos.')
    throw new McpToolError(`Mercado Livre indisponível (HTTP ${error.status}).`)
  }

  const results = (response.results ?? [])
    .map(toListing)
    .filter((item): item is Listing => item !== null)
    // Garantia caso o filtro ITEM_CONDITION seja ignorado pela API.
    .filter(item => !input.condition || item.condition === null || item.condition === input.condition)

  return {
    platform: 'mercadolivre',
    totalMatches: response.paging?.total ?? results.length,
    returned: results.length,
    results,
  }
}
