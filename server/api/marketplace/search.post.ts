import { executeSearchRun } from '../../../src/search-runner'
import { getMongoDataConfigFromEnv } from '../../../src/integrations/mongo'
import { getZApiConfigFromEnv } from '../../../src/integrations/zapi'
import { parseBoolean, parsePositiveInt } from '../../../src/utils'

interface MarketplaceSearchBody {
  term?: string
}

let marketplaceSearchRunning = false

export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache, no-transform')
  setHeader(event, 'Connection', 'keep-alive')
  setHeader(event, 'X-Accel-Buffering', 'no')

  const response = event.node.res
  const controller = new AbortController()
  let finished = false
  let clientDisconnected = false

  const abortSearch = () => {
    if (!finished) {
      clientDisconnected = true
      controller.abort()
    }
  }

  response.on('close', abortSearch)
  response.flushHeaders()

  const sendEvent = (name: string, data: unknown) => {
    if (response.destroyed || clientDisconnected) return
    response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const body = await readBody<MarketplaceSearchBody>(event).catch((): MarketplaceSearchBody => ({}))
  const term = typeof body.term === 'string' ? body.term.trim() : ''

  if (!term) {
    sendEvent('error', { message: 'Digite um termo para buscar no Marketplace.', code: 'MISSING_TERM' })
    finished = true
    response.off('close', abortSearch)
    response.end()
    return
  }

  if (marketplaceSearchRunning) {
    sendEvent('error', {
      message: 'Já existe uma busca do Marketplace em andamento. Aguarde a conclusão.',
      code: 'SEARCH_BUSY',
    })
    finished = true
    response.off('close', abortSearch)
    response.end()
    return
  }

  marketplaceSearchRunning = true

  try {
    const maxScrolls = Math.max(1, Math.min(20, parsePositiveInt(process.env.MAX_SCROLLS, 4)))
    const headless = parseBoolean(process.env.HEADLESS, false)
    const profilePath = process.env.PROFILE_PATH?.trim() || './data/facebook-profile'
    const outputPath = process.env.OUTPUT_PATH?.trim() || './output/results.json'

    sendEvent('status', {
      message: `Iniciando busca no Marketplace: "${term}"`,
      maxScrolls,
      headless,
      profilePath,
    })

    const run = await executeSearchRun({
      searchTerm: term,
      maxScrolls,
      headless,
      profilePath,
      outputPath,
      mongoConfig: getMongoDataConfigFromEnv(),
      zApiConfig: { ...getZApiConfigFromEnv(), enabled: false },
      shouldCancel: () => controller.signal.aborted || clientDisconnected,
      log: (message) => sendEvent('log', { message }),
    })

    if (!clientDisconnected) {
      for (const item of run.results) {
        sendEvent('result', { item })
      }

      sendEvent('done', {
        total: run.results.length,
        effectiveSearchTerm: run.effectiveSearchTerm,
        conditionMode: run.conditionMode,
        semanticRuleName: run.semanticRuleName,
        collectedCandidates: run.collectedCandidates.length,
      })
    }
  }
  catch (error: unknown) {
    if (!clientDisconnected) {
      sendEvent('error', {
        message: error instanceof Error ? error.message : String(error),
        code: 'MARKETPLACE_SEARCH_ERROR',
      })
    }
  }
  finally {
    marketplaceSearchRunning = false
    finished = true
    response.off('close', abortSearch)
    if (!response.destroyed) response.end()
  }
})
