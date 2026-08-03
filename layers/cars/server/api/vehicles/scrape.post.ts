import { randomUUID } from 'node:crypto'
import type { VehicleSource } from '#shared/types/vehicle'

interface ScrapeRequestBody {
  sources?: VehicleSource[]
  enrichFipe?: boolean
}

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

  const body = await readBody<ScrapeRequestBody>(event).catch((): ScrapeRequestBody => ({}))
  const sourceIds = Array.isArray(body.sources) && body.sources.length > 0 ? body.sources : null
  const enrichFipe = body.enrichFipe !== false

  try {
    const result = await runScrapers(sourceIds, {
      enrichFipe,
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

    if (!controller.signal.aborted && result.insertedVehicleIds.length > 0) {
      await notifyPicaretaOpportunityMatches({
        runId: randomUUID(),
        vehicleIds: result.insertedVehicleIds,
        log: (message) => { sendEvent('log', { message }) },
      })
    }

    sendEvent('done', {
      total: result.total,
      inserted: result.inserted,
      updated: result.updated,
      skipped: result.skipped,
      skippedGeo: result.skippedGeo,
      skippedExpiredNoSale: result.skippedExpiredNoSale,
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
