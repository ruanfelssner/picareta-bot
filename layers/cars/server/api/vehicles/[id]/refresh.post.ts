import type { VehicleRecord } from '#shared/types/vehicle'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const logs: string[] = []
  const controller = new AbortController()
  let finished = false
  const abortRefresh = () => {
    if (!finished && !controller.signal.aborted) controller.abort()
  }

  event.node.res.on('close', abortRefresh)

  try {
    const vehicle: VehicleRecord = await refreshVehicleFromSource(id, {
      log: message => logs.push(message),
      signal: controller.signal,
    })

    return { vehicle, logs }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const statusCode = message.includes('não encontrado') ? 404 : 502
    throw createError({ statusCode, message })
  }
  finally {
    finished = true
    event.node.res.off('close', abortRefresh)
  }
})
