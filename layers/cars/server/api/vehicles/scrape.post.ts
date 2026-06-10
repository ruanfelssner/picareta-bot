// POST /api/vehicles/scrape — SSE stream de veículos scrapeados
// Requer layers/scrapers ativo no nuxt.config.ts (Parte 3)
// Quando ativo, runScrapers() é auto-importado de layers/scrapers/server/utils/scraper-runner.ts

export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache')
  setHeader(event, 'Connection', 'keep-alive')

  const sendEvent = (name: string, data: unknown) => {
    event.node.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  sendEvent('error', {
    message: 'Scrapers não configurados. Ative layers/scrapers no nuxt.config.ts (Parte 3).',
    code: 'SCRAPERS_NOT_CONFIGURED',
  })

  event.node.res.end()
})
