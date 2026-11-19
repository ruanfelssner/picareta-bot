import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import {
  MARKETPLACE_PRICE_LIMIT,
  MARKETPLACE_RADIUS_LIMITS_KM,
  normalizeMarketplaceLocation,
  type MarketplaceSearchOptions,
} from '#shared/utils/marketplace-search-options'
import type { VehicleSource } from '#shared/types/vehicle'
import type { Listing } from './listing'
import { McpToolError, withTimeout } from './runtime'
import { AUCTION_SOURCE_IDS, searchAuctions } from './sources/auctions'
import { getMarketplaceJob, startMarketplaceSearch, type MarketplaceJobView } from './sources/marketplace'
import { isMercadoLivreConfigured, searchMercadoLivre } from './sources/mercadolivre'
import { isWebSearchConfigured, searchWeb } from './sources/web'

/**
 * Servidor MCP somente leitura. Nenhuma ferramenta publica anúncios, envia WhatsApp ou fala com vendedores:
 * as buscas do Marketplace rodam no worker com Z-API desligada (`src/commands/web-search.ts`).
 */

const TOOL_TIMEOUT_MS = 45_000
const PART_SOURCE_TIMEOUT_MS = 15_000

const SERVER_INSTRUCTIONS = `Ferramentas de consulta do Bot-Anúncios (Picareta) para peças e veículos no Brasil. Todas são somente leitura.
- Para foto de peça: identifique a peça, o lado (esquerdo/direito = motorista/passageiro), o carro (marca, modelo, geração, ano) e qualquer código OEM visível; use isso como termo curto em português.
- search_parts consulta Mercado Livre e web na hora e inicia a busca do Facebook Marketplace em segundo plano.
- O Facebook Marketplace é assíncrono: quando "done" for false, chame get_search_job com o job_id depois de 20–30 s, sem iniciar outra busca igual.
- search_auctions consulta veículos de leilão já coletados (não peças).
- Valores em reais (BRL). Sempre mostre ao usuário o link (url) e a plataforma de cada resultado.`

const priceSchema = z.number().min(0).max(MARKETPLACE_PRICE_LIMIT)
const conditionSchema = z.enum(['qualquer', 'novo', 'usado']).default('qualquer')
  .describe('Condição do item. "qualquer" não filtra.')

const marketplaceFilterShape = {
  location: z.string().trim().max(60).optional()
    .describe('Cidade (ex.: "Curitiba", "São Paulo") ou ID numérico de localização do Facebook. Sem valor, usa a região configurada no bot.'),
  radius_km: z.number().int().min(MARKETPLACE_RADIUS_LIMITS_KM.min).max(MARKETPLACE_RADIUS_LIMITS_KM.max).optional()
    .describe('Raio em km a partir da localização.'),
  min_price: priceSchema.optional().describe('Preço mínimo em reais.'),
  max_price: priceSchema.optional().describe('Preço máximo em reais.'),
  condition: conditionSchema,
}

interface MarketplaceFilterArgs {
  location?: string
  radius_km?: number
  min_price?: number
  max_price?: number
  condition: 'qualquer' | 'novo' | 'usado'
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const

function assertPriceRange(min: number | undefined, max: number | undefined) {
  if (min != null && max != null && max < min) throw new McpToolError('max_price deve ser maior ou igual a min_price.')
}

function toMarketplaceOptions(args: MarketplaceFilterArgs): MarketplaceSearchOptions | null {
  assertPriceRange(args.min_price, args.max_price)
  let locationId: string | null = null
  if (args.location) {
    locationId = normalizeMarketplaceLocation(args.location)
    if (!locationId) throw new McpToolError('location inválida: informe o nome da cidade ou o ID numérico do Facebook.')
  }
  const options: MarketplaceSearchOptions = {
    locationId,
    radiusKm: args.radius_km ?? null,
    minPrice: args.min_price != null ? Math.round(args.min_price) : null,
    maxPrice: args.max_price != null ? Math.round(args.max_price) : null,
    condition: args.condition === 'qualquer' ? null : args.condition,
  }
  return Object.values(options).some(value => value != null) ? options : null
}

function userFacingMessage(error: unknown): string | null {
  if (error instanceof McpToolError) return error.message
  // Erros criados com createError() pelos utils do servidor já trazem mensagem pensada para o usuário.
  if (typeof error === 'object' && error !== null) {
    const { statusCode, statusMessage } = error as { statusCode?: unknown, statusMessage?: unknown }
    if (typeof statusCode === 'number' && typeof statusMessage === 'string' && statusMessage) return statusMessage
  }
  return null
}

function summarize(data: Record<string, unknown>): string {
  const results = Array.isArray(data.results) ? data.results.length : null
  return results != null ? `results=${results}` : ''
}

async function execute(requestId: string, tool: string, handler: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  const startedAt = Date.now()
  try {
    const data = await withTimeout(handler(), TOOL_TIMEOUT_MS, tool)
    console.info(`[mcp] ${requestId} ${tool} ok ${Date.now() - startedAt}ms ${summarize(data)}`.trim())
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    }
  }
  catch (error) {
    const message = userFacingMessage(error)
    const detail = error instanceof Error ? error.message : String(error)
    console.warn(`[mcp] ${requestId} ${tool} erro ${Date.now() - startedAt}ms: ${detail}`)
    return {
      isError: true,
      content: [{ type: 'text', text: message ?? `Falha interna ao executar ${tool}. Tente novamente; se persistir, consulte os logs do bot (ref. ${requestId}).` }],
    }
  }
}

type PartSourceId = 'marketplace' | 'mercadolivre' | 'web'
interface PartSourceStatus {
  source: PartSourceId
  status: 'ok' | 'em_andamento' | 'erro' | 'nao_configurado'
  returned: number
  message?: string
  jobId?: string
}

export function createMcpServer(version: string): McpServer {
  const requestId = randomUUID().slice(0, 8)
  const server = new McpServer(
    { name: 'bot-anuncios', title: 'Bot-Anúncios (Picareta)', version },
    { instructions: SERVER_INSTRUCTIONS },
  )

  server.registerTool('search_marketplace', {
    title: 'Pesquisar no Facebook Marketplace',
    description: 'Pesquisa anúncios no Facebook Marketplace pelo worker do bot (navegador com o perfil logado). Assíncrono: devolve job_id e, se terminar dentro de wait_seconds, os resultados. Se done=false, use get_search_job.',
    inputSchema: {
      query: z.string().trim().min(2).max(80)
        .describe('Termo como um comprador digitaria, ex.: "farol gol g5 esquerdo". "novo"/"usado" no termo também filtram.'),
      ...marketplaceFilterShape,
      max_results: z.number().int().min(1).max(50).default(20).describe('Máximo de resultados devolvidos.'),
      wait_seconds: z.number().int().min(0).max(25).default(20).describe('Quanto esperar pelo resultado antes de devolver o job_id.'),
    },
    annotations: readOnlyAnnotations,
  }, async args => execute(requestId, 'search_marketplace', async () => {
    const view = await startMarketplaceSearch({
      query: args.query,
      options: toMarketplaceOptions(args),
      maxResults: args.max_results,
      waitSeconds: args.wait_seconds,
    })
    return { ...view }
  }))

  server.registerTool('get_search_job', {
    title: 'Consultar busca em andamento',
    description: 'Consulta status e resultados de uma busca assíncrona (Facebook Marketplace) pelo job_id devolvido por search_marketplace ou search_parts.',
    inputSchema: {
      job_id: z.string().trim().regex(/^[a-f0-9]{24}$/i, 'job_id deve ter 24 caracteres hexadecimais.'),
      max_results: z.number().int().min(1).max(50).default(20),
    },
    annotations: { ...readOnlyAnnotations, idempotentHint: true },
  }, async args => execute(requestId, 'get_search_job', async () => ({ ...await getMarketplaceJob(args.job_id, args.max_results) })))

  server.registerTool('search_auctions', {
    title: 'Pesquisar veículos em leilões',
    description: 'Pesquisa veículos nos leilões monitorados (Copart, Sodré Santoro, VIP, Freitas etc.) a partir da última coleta. Retorna lance atual, FIPE, % da FIPE, data, lote e link.',
    inputSchema: {
      query: z.string().trim().min(2).max(80).optional().describe('Marca, modelo ou trecho do título, ex.: "onix", "hilux". Sem valor, lista tudo.'),
      min_price: priceSchema.optional(),
      max_price: priceSchema.optional(),
      min_year: z.number().int().min(1950).max(2100).optional(),
      max_year: z.number().int().min(1950).max(2100).optional(),
      states: z.array(z.string().trim().regex(/^[A-Za-z]{2}$/, 'Use a sigla da UF.')).max(27).optional().describe('UFs, ex.: ["PR", "SC"].'),
      sources: z.array(z.enum([...AUCTION_SOURCE_IDS] as unknown as [VehicleSource, ...VehicleSource[]])).max(AUCTION_SOURCE_IDS.length).optional().describe('Leiloeiros; sem valor, todos os ativos.'),
      period: z.enum(['all', 'upcoming', 'today', 'tomorrow', 'past']).default('all')
        .describe('all = hoje em diante (inclui sem data); upcoming = hoje e amanhã; past = encerrados.'),
      max_fipe_percent: z.number().min(10).max(150).optional().describe('Só lotes com lance até este % da FIPE.'),
      apply_user_filters: z.boolean().default(false).describe('Aplicar as regras de exibição cadastradas em /filters.'),
      sort: z.enum(['recommended', 'auction_date', 'price_asc', 'price_desc', 'year_desc', 'fipe_asc', 'km_asc']).default('recommended'),
      max_results: z.number().int().min(1).max(50).default(20),
    },
    annotations: { ...readOnlyAnnotations, idempotentHint: true, openWorldHint: false },
  }, async args => execute(requestId, 'search_auctions', async () => {
    assertPriceRange(args.min_price, args.max_price)
    if (args.min_year != null && args.max_year != null && args.max_year < args.min_year) {
      throw new McpToolError('max_year deve ser maior ou igual a min_year.')
    }
    return searchAuctions({
      query: args.query ?? null,
      minPrice: args.min_price ?? null,
      maxPrice: args.max_price ?? null,
      minYear: args.min_year ?? null,
      maxYear: args.max_year ?? null,
      states: (args.states ?? []).map(state => state.toUpperCase()),
      sources: args.sources ?? [],
      period: args.period,
      maxFipePercent: args.max_fipe_percent ?? null,
      applyUserFilters: args.apply_user_filters,
      sort: args.sort,
      maxResults: args.max_results,
    })
  }))

  server.registerTool('search_mercadolivre', {
    title: 'Pesquisar peças no Mercado Livre',
    description: 'Pesquisa anúncios no Mercado Livre Brasil pela API oficial. Retorna preço, condição, local do vendedor, código OEM (quando o anúncio informa), imagem e link.',
    inputSchema: {
      query: z.string().trim().min(2).max(120).describe('Peça + veículo, ou código OEM, ex.: "lanterna traseira corolla 2015 direita".'),
      condition: conditionSchema,
      min_price: priceSchema.optional(),
      max_price: priceSchema.optional(),
      max_results: z.number().int().min(1).max(50).default(20),
    },
    annotations: { ...readOnlyAnnotations, idempotentHint: true },
  }, async args => execute(requestId, 'search_mercadolivre', async () => {
    assertPriceRange(args.min_price, args.max_price)
    return searchMercadoLivre({
      query: args.query,
      condition: args.condition === 'qualquer' ? null : args.condition,
      minPrice: args.min_price ?? null,
      maxPrice: args.max_price ?? null,
      maxResults: args.max_results,
    })
  }))

  server.registerTool('search_web', {
    title: 'Pesquisar peças na web',
    description: 'Pesquisa a peça na web aberta (lojas de autopeças, marketplaces e catálogos) via Brave Search. Bom para achar código OEM, preço de peça nova e lojas.',
    inputSchema: {
      query: z.string().trim().min(2).max(150).describe('Peça + veículo ou código OEM.'),
      focus: z.enum(['lojas', 'geral']).default('lojas').describe('"lojas" prioriza páginas de compra; "geral" traz qualquer página (fóruns, catálogos).'),
      max_results: z.number().int().min(1).max(20).default(10),
    },
    annotations: { ...readOnlyAnnotations, idempotentHint: true },
  }, async args => execute(requestId, 'search_web', async () => searchWeb({
    query: args.query,
    focus: args.focus,
    maxResults: args.max_results,
  })))

  server.registerTool('search_parts', {
    title: 'Pesquisar peça em todas as fontes',
    description: 'Pesquisa uma peça automotiva nas fontes disponíveis de uma vez: Mercado Livre e web (resultado imediato) e Facebook Marketplace (inicia job assíncrono; acompanhe com get_search_job). Indica o status de cada fonte.',
    inputSchema: {
      query: z.string().trim().min(2).max(80).describe('Peça + veículo, ex.: "retrovisor hb20 2019 direito".'),
      sources: z.array(z.enum(['marketplace', 'mercadolivre', 'web'])).min(1).max(3).default(['marketplace', 'mercadolivre', 'web']),
      ...marketplaceFilterShape,
      max_results_per_source: z.number().int().min(1).max(20).default(8),
    },
    annotations: readOnlyAnnotations,
  }, async args => execute(requestId, 'search_parts', async () => {
    const marketplaceOptions = toMarketplaceOptions(args)
    const condition = args.condition === 'qualquer' ? null : args.condition
    const limit = args.max_results_per_source
    const wanted = new Set<PartSourceId>(args.sources)

    const tasks: Array<{ source: PartSourceId, run: () => Promise<{ results: Listing[], job?: MarketplaceJobView }> }> = []
    const statuses: PartSourceStatus[] = []

    if (wanted.has('mercadolivre')) {
      if (isMercadoLivreConfigured()) {
        tasks.push({ source: 'mercadolivre', run: () => searchMercadoLivre({ query: args.query, condition, minPrice: args.min_price ?? null, maxPrice: args.max_price ?? null, maxResults: limit }) })
      }
      else {
        statuses.push({ source: 'mercadolivre', status: 'nao_configurado', returned: 0, message: 'Credenciais do Mercado Livre ausentes no backend.' })
      }
    }
    if (wanted.has('web')) {
      if (isWebSearchConfigured()) {
        tasks.push({ source: 'web', run: () => searchWeb({ query: args.query, focus: 'lojas', maxResults: limit }) })
      }
      else {
        statuses.push({ source: 'web', status: 'nao_configurado', returned: 0, message: 'BRAVE_SEARCH_API_KEY ausente no backend.' })
      }
    }
    if (wanted.has('marketplace')) {
      tasks.push({
        source: 'marketplace',
        run: async () => {
          const job = await startMarketplaceSearch({ query: args.query, options: marketplaceOptions, maxResults: limit, waitSeconds: 0 })
          return { results: job.results, job }
        },
      })
    }

    const settled = await Promise.allSettled(tasks.map(task => withTimeout(task.run(), PART_SOURCE_TIMEOUT_MS, task.source)))
    const results: Listing[] = []
    let marketplaceJob: Record<string, unknown> | null = null

    for (const [index, outcome] of settled.entries()) {
      const source = tasks[index]!.source
      if (outcome.status === 'rejected') {
        const message = userFacingMessage(outcome.reason) ?? `Falha interna em ${source}.`
        console.warn(`[mcp] ${requestId} search_parts ${source} erro: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`)
        statuses.push({ source, status: 'erro', returned: 0, message })
        continue
      }
      const { results: sourceResults, job } = outcome.value
      results.push(...sourceResults)
      if (job) {
        marketplaceJob = { jobId: job.jobId, status: job.status, done: job.done, nextStep: job.nextStep }
        statuses.push({ source, status: job.done ? 'ok' : 'em_andamento', returned: sourceResults.length, jobId: job.jobId })
      }
      else {
        statuses.push({ source, status: 'ok', returned: sourceResults.length })
      }
    }

    const anyUsable = statuses.some(status => status.status === 'ok' || status.status === 'em_andamento')
    if (!anyUsable) {
      throw new McpToolError(`Nenhuma fonte disponível: ${statuses.map(status => `${status.source}: ${status.message ?? status.status}`).join(' | ')}`)
    }

    return { query: args.query, sources: statuses, marketplaceJob, results }
  }))

  return server
}
