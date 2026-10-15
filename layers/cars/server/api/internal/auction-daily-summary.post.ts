import { createHash, timingSafeEqual } from 'node:crypto'
import { getZApiConfig, validateZApiConfig } from '../../utils/zapi'

/** Resumo do Picareta: somente texto para o destino já configurado, sem criar favoritos. */
export default defineEventHandler(async (event) => {
  const expected = (process.env['SCRAPER_SERVICE_KEY'] ?? '').trim()
  const received = getRequestHeader(event, 'x-scraper-service-key') ?? ''
  if (!expected || !timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(received).digest())) {
    throw createError({ statusCode: 401, message: 'Chave do serviço inválida' })
  }
  const body = await readBody<unknown>(event)
  if (!body || typeof body !== 'object' || !('message' in body) || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 12_000) {
    throw createError({ statusCode: 400, message: 'Resumo diário inválido' })
  }
  const config = getZApiConfig()
  if (validateZApiConfig(config) || /^(?:false|0)$/i.test(process.env['ZAPI_ENABLED'] ?? '')) {
    throw createError({ statusCode: 503, message: 'WhatsApp não configurado ou desabilitado' })
  }
  let response: Response
  try {
    response = await fetch(`${config.baseUrl}/instances/${encodeURIComponent(config.instanceId)}/token/${encodeURIComponent(config.token)}/send-text`, {
      method: 'POST',
      headers: { 'Client-Token': config.clientToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: config.phone, message: body.message, delayMessage: config.delayMessage }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch {
    throw createError({ statusCode: 502, message: 'Não foi possível confirmar o aceite do resumo no WhatsApp' })
  }
  if (!response.ok) throw createError({ statusCode: 502, message: 'O provedor recusou o resumo diário' })
  await response.body?.cancel()
  return { accepted: true }
})
