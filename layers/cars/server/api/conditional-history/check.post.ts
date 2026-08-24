import { isError } from 'h3'

export default defineEventHandler(async (event) => {
  const body: Record<string, unknown> = await readBody<Record<string, unknown>>(event)
    .catch(() => ({} as Record<string, unknown>))
  const vehicleId = typeof body.vehicleId === 'string' && body.vehicleId.trim()
    ? body.vehicleId.trim()
    : undefined
  const serviceKey = (process.env.SCRAPER_SERVICE_KEY ?? '').trim()
  const internalPort = Number.parseInt(
    process.env.SCRAPER_INTERNAL_PORT ?? String((Number.parseInt(process.env.PORT ?? '3101', 10) || 3101) + 1000),
    10,
  ) || 4101

  if (!serviceKey) {
    throw createError({ statusCode: 503, statusMessage: 'Serviço de scraping não configurado.' })
  }

  try {
    const response = await fetch(`http://127.0.0.1:${internalPort}/internal/scraping/conditional-check`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-scraper-service-key': serviceKey,
      },
      body: JSON.stringify({ force: true, ...(vehicleId ? { vehicleId } : {}) }),
    })
    const payload = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      throw createError({
        statusCode: response.status,
        statusMessage: typeof payload.message === 'string' ? payload.message : 'Não foi possível iniciar a reconsulta.',
      })
    }
    return payload
  } catch (error) {
    if (isError(error)) throw error
    throw createError({
      statusCode: 503,
      statusMessage: `Serviço de scraping indisponível: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
})
