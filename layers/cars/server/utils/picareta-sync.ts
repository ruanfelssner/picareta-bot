/**
 * Gera no Picareta o mesmo link curto rastreável usado nas mensagens dele.
 * A rota fica no mesmo host da ingestão e usa a mesma chave; em falha, `null`.
 */
export async function createPicaretaShortLink(input: {
  targetUrl: string
  opportunityId: string | null
  label: string | null
}): Promise<string | null> {
  const config = useRuntimeConfig()
  const endpoint = String(config.picaretaIngestUrl || process.env.PICARETA_INGEST_URL || '').trim()
  const key = String(config.picaretaIngestKey || process.env.PICARETA_INGEST_KEY || '').trim()
  if (!endpoint || !key) return null

  try {
    const response = await fetch(new URL('/api/v1/internal/short-links', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-picareta-ingest-key': key },
      body: JSON.stringify({ ...input, kind: 'listing' }),
      signal: AbortSignal.timeout(8_000),
    })
    if (!response.ok) throw new Error(`Picareta respondeu HTTP ${response.status}`)
    const body = await response.json() as { url?: unknown }
    return typeof body.url === 'string' && body.url ? body.url : null
  } catch (error) {
    console.error('[picareta-short-link] falha ao gerar link curto', {
      targetUrl: input.targetUrl,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

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
