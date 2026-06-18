import type { VehicleSource } from '#shared/types/vehicle'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache')
  setHeader(event, 'Connection', 'keep-alive')

  const res = event.node.res
  const controller = new AbortController()
  let finished = false

  const abortScrape = () => {
    if (!finished && !controller.signal.aborted) controller.abort()
  }

  res.on('close', abortScrape)

  const sendEvent = (name: string, data: unknown) => {
    if (res.destroyed || controller.signal.aborted) return
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const body = await readBody<{ sources?: VehicleSource[] }>(event).catch(() => ({} as { sources?: VehicleSource[] }))
  const sourceIds = Array.isArray(body.sources) && body.sources.length > 0 ? body.sources : null

  try {
    const result = await runScrapers(sourceIds, {
      signal: controller.signal,
      onVehicle: (vehicle) => {
        sendEvent('vehicle', {
          source: vehicle.source,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year,
          price: vehicle.price,
          url: vehicle.url,
        })
      },
      onSourceStatus: (sourceStatus) => {
        sendEvent('source', sourceStatus)
      },
      log: (msg) => { sendEvent('log', { message: msg }) },
    })

    sendEvent('done', {
      total: result.total,
      inserted: result.inserted,
      skipped: result.skipped,
      errors: result.errors,
    })
  }
  catch (err) {
    sendEvent('error', {
      message: err instanceof Error ? err.message : String(err),
      code: 'SCRAPE_ERROR',
    })
  }
  finally {
    finished = true
    res.off('close', abortScrape)
    if (!res.destroyed) res.end()
  }
})
