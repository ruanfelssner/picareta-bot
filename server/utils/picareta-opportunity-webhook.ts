type OpportunityWebhookInput = {
  runId: string
  vehicleIds: string[]
  log?: (message: string) => void
}

type OpportunityWebhookResponse = {
  matchedUsers?: number
  sent?: number
  failed?: number
}

const WEBHOOK_TIMEOUT_MS = 10_000

export async function notifyPicaretaOpportunityMatches(input: OpportunityWebhookInput) {
  const log = input.log ?? (() => {})
  const config = useRuntimeConfig()
  const url = String(config.picaretaOpportunityWebhookUrl || '').trim()
  const secret = String(config.picaretaIngestKey || '').trim()
  const vehicleIds = [...new Set(input.vehicleIds)]

  if (!vehicleIds.length) return null
  if (!url || !secret) {
    log('[picareta] Webhook de oportunidades não configurado; alerta Push ignorado.')
    return null
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-picareta-ingest-key': secret,
      },
      body: JSON.stringify({ runId: input.runId, vehicleIds }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`)
    }

    const result = await response.json() as OpportunityWebhookResponse
    log(
      `[picareta] Lote analisado: ${result.matchedUsers ?? 0} usuário(s) com correspondência; `
      + `${result.sent ?? 0} Push enviado(s); ${result.failed ?? 0} falha(s).`,
    )
    return result
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[picareta] Não foi possível analisar os filtros para Push: ${message}`)
    return null
  }
}
