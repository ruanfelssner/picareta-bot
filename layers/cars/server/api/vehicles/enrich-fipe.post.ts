export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', 'text/event-stream')
  setHeader(event, 'Cache-Control', 'no-cache')
  setHeader(event, 'Connection', 'keep-alive')

  const res = event.node.res

  const sendEvent = (name: string, data: unknown) => {
    res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  try {
    useDb()

    const body = await readBody<{ reset?: boolean }>(event).catch((): { reset?: boolean } => ({}))
    const reset = body?.reset === true

    if (reset) {
      const resetResult = await VehicleModel.updateMany(
        { fipe: null, fipeCheckedAt: { $ne: null } },
        { $set: { fipeCheckedAt: null } },
      )
      if (resetResult.modifiedCount > 0) {
        sendEvent('log', { message: `[fipe] ${resetResult.modifiedCount} tentativa(s) anterior(es) resetada(s).` })
      }
    }

    const pending = await VehicleModel.find({ fipeCheckedAt: null }, { _id: 1 }).lean()
    const ids = pending.map(d => String(d._id))

    if (ids.length === 0) {
      sendEvent('log', { message: '[fipe] Nenhum veículo pendente.' })
      sendEvent('done', { total: 0, enriched: 0, failed: 0 })
      return
    }

    sendEvent('log', { message: `[fipe] ${ids.length} veículo(s) sem FIPE encontrado(s).` })

    const config = getFipeConfigFromEnv()
    if (!config.enabled) {
      sendEvent('log', { message: '[fipe] FIPE desabilitado (FIPE_API_ENABLED=false).' })
      sendEvent('done', { total: ids.length, enriched: 0, failed: ids.length })
      return
    }

    let enriched = 0
    let failed = 0

    await enrichVehiclesWithFipe(ids, (msg) => {
      if (msg.includes('✓')) enriched++
      else if (msg.includes('✗')) failed++
      sendEvent('log', { message: msg })
    })

    sendEvent('done', { total: ids.length, enriched, failed })
  }
  catch (err) {
    sendEvent('error', { message: err instanceof Error ? err.message : String(err) })
  }
  finally {
    res.end()
  }
})
