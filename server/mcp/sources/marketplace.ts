import {
  normalizeMarketplaceSearchOptions,
  type MarketplaceSearchOptions,
} from '#shared/utils/marketplace-search-options'
import {
  assertWebSearchAvailable,
  countActiveWebSearches,
  createWebSearch,
  getMarketplaceWorkerStatus,
  getWebSearchDelta,
} from '../../utils/marketplace-web-search'
import { dedupeByUrl, extractOemCode, httpsUrl, listing, parseBrlPrice, type Listing } from '../listing'
import { McpToolError, sleep } from '../runtime'

/**
 * Facebook Marketplace via fila existente `marketplace_web_searches`: o Nuxt só enfileira e lê;
 * quem abre o Facebook é o `pnpm worker` no PC com o perfil logado (mesmo fluxo da tela `/marketplace`).
 * O `_id` do documento é o Job ID devolvido ao ChatGPT.
 */

const MAX_ACTIVE_MCP_SEARCHES = 3
const POLL_INTERVAL_MS = 2_000
const JOB_ID_PATTERN = /^[a-f0-9]{24}$/i

export interface MarketplaceSearchInput {
  query: string
  options: MarketplaceSearchOptions | null
  maxResults: number
  waitSeconds: number
}

export interface MarketplaceJobView {
  jobId: string
  platform: 'facebook-marketplace'
  status: string
  done: boolean
  stale: boolean
  query: string
  filters: MarketplaceSearchOptions | null
  resultsAreFinal: boolean
  totalResults: number
  results: Listing[]
  recentProgress: string[]
  error: string | null
  worker: { online: boolean, status: string | null } | null
  nextStep: string | null
  createdAt: string
  updatedAt: string
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function toListing(item: Record<string, unknown>, options: MarketplaceSearchOptions | null): Listing | null {
  const url = httpsUrl(item.url)
  const title = text(item.titleRaw)
  if (!url || !title) return null
  const priceText = text(item.priceRaw)
  return listing({
    title,
    price: parseBrlPrice(priceText),
    priceText,
    location: text(item.locationRaw),
    // O card do Marketplace não informa condição; quando a busca filtrou, todos os itens seguem o filtro.
    condition: options?.condition ?? null,
    oemCode: extractOemCode(title),
    imageUrl: httpsUrl(item.image),
    url,
    platform: 'facebook-marketplace',
    platformName: 'Facebook Marketplace',
  })
}

export async function getMarketplaceJob(jobId: string, maxResults: number): Promise<MarketplaceJobView> {
  assertWebSearchAvailable()
  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new McpToolError('job_id inválido: use o identificador de 24 caracteres devolvido por search_marketplace ou search_parts.')
  }

  const doc = await getWebSearchDelta(jobId, { logs: 0, previews: 0, finals: 0 })
  const options = normalizeMarketplaceSearchOptions(doc.options)
  const done = !doc.active
  // Lista final por termo quando existe; antes disso (ou se a busca falhou) mostra as prévias já aprovadas.
  const hasFinals = doc.finals.length > 0
  const rawItems = hasFinals
    ? doc.finals.flatMap(final => final.items)
    : doc.previews.map(preview => preview.item)
  const results = dedupeByUrl(
    rawItems
      .map(item => toListing(item, options))
      .filter((item): item is Listing => item !== null),
  )

  const worker = done ? null : await getMarketplaceWorkerStatus()
  let nextStep: string | null = null
  if (!done) {
    if (doc.stale) nextStep = 'A busca parou de responder há mais de 5 minutos (worker travado ou desligado). Informe o usuário; não é preciso consultar de novo.'
    else if (worker && !worker.online) nextStep = 'O worker do Marketplace ficou offline; a busca continuará quando o PC do bot voltar. Informe o usuário.'
    else nextStep = 'A busca continua no worker (costuma levar de 1 a 4 minutos). Chame get_search_job com este job_id daqui a 20–30 segundos.'
  }

  return {
    jobId,
    platform: 'facebook-marketplace',
    status: doc.status,
    done,
    stale: doc.stale,
    query: doc.terms.join(', '),
    filters: options,
    resultsAreFinal: done && hasFinals,
    totalResults: results.length,
    results: results.slice(0, maxResults),
    recentProgress: doc.logs.slice(-3).map(log => log.message),
    error: doc.error,
    worker: worker ? { online: worker.online, status: worker.status } : null,
    nextStep,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  }
}

export async function startMarketplaceSearch(input: MarketplaceSearchInput): Promise<MarketplaceJobView> {
  assertWebSearchAvailable()

  const worker = await getMarketplaceWorkerStatus()
  if (!worker.online) {
    throw new McpToolError(
      'O worker do Facebook Marketplace está offline: o PC com o perfil do Facebook precisa estar ligado com `pnpm worker`. Nenhuma busca foi enfileirada.',
    )
  }
  if (await countActiveWebSearches('mcp') >= MAX_ACTIVE_MCP_SEARCHES) {
    throw new McpToolError(
      `Já existem ${MAX_ACTIVE_MCP_SEARCHES} buscas do Marketplace pedidas pelo MCP na fila. Acompanhe-as com get_search_job antes de iniciar outra.`,
    )
  }

  const jobId = await createWebSearch([input.query], { origin: 'mcp', options: input.options })
  console.info(`[mcp:marketplace] job ${jobId} enfileirado`)

  const deadline = Date.now() + input.waitSeconds * 1000
  let view = await getMarketplaceJob(jobId, input.maxResults)
  while (!view.done && Date.now() + POLL_INTERVAL_MS <= deadline) {
    await sleep(POLL_INTERVAL_MS)
    view = await getMarketplaceJob(jobId, input.maxResults)
  }
  return view
}
