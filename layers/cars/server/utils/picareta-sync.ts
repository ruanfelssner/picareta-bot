export async function syncVehicleToPicareta(vehicle: unknown): Promise<void> {
  const config = useRuntimeConfig()
  const endpoint = String(config.picaretaIngestUrl || '').trim()
  const key = String(config.picaretaIngestKey || '').trim()
  if (!endpoint || !key) return

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-picareta-ingest-key': key,
    },
    body: JSON.stringify(vehicle),
    signal: AbortSignal.timeout(8_000),
  })
  if (!response.ok) {
    throw new Error(`Picareta respondeu HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`)
  }
}
