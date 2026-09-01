export async function syncVehicleToPicareta(vehicle: unknown): Promise<boolean> {
  const config = useRuntimeConfig()
  const endpoint = String(config.picaretaIngestUrl || '').trim()
  const key = String(config.picaretaIngestKey || '').trim()
  if (!endpoint || !key) return false

  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-picareta-ingest-key': key,
        },
        body: JSON.stringify(vehicle),
        signal: AbortSignal.timeout(8_000),
      })
      if (response.ok) return true

      throw new Error(`Picareta respondeu HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`)
    } catch (error) {
      lastError = error
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 500))
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Falha ao sincronizar veículo com o Picareta.')
}
