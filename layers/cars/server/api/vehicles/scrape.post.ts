import type { VehicleSource } from '#shared/types/vehicle'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache')
  setHeader(event, 'Connection', 'keep-alive')

  const res = event.node.res

  const sendEvent = (name: string, data: unknown) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  const body = await readBody<{ sources?: VehicleSource[] }>(event).catch(() => ({} as { sources?: VehicleSource[] }))
  const sourceIds = Array.isArray(body.sources) && body.sources.length > 0 ? body.sources : null

  try {
    const result = await runScrapers(sourceIds, {
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
    res.end()
  }
})
