export async function syncVehicleToPicareta(vehicle: unknown): Promise<boolean> {
  const config = useRuntimeConfig()
  // O serviço combinado pode receber as variáveis depois do build. O fallback
  // direto garante que a sincronização use o ambiente real do processo.
  const endpoint = String(config.picaretaIngestUrl || process.env.PICARETA_INGEST_URL || '').trim()
  const key = String(config.picaretaIngestKey || process.env.PICARETA_INGEST_KEY || '').trim()
  if (!endpoint || !key) {
    const missing = [
      !endpoint ? 'PICARETA_INGEST_URL' : null,
      !key ? 'PICARETA_INGEST_KEY' : null,
    ].filter((value): value is string => value != null)
    throw new Error(`${missing.join(' e ')} não configurado no Bot.`)
  }

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
