import { assertLiveAuctionExtensionAuthorized } from '../../../utils/live-auction-extension-auth'
import { persistLiveAuctionEventBatch } from '../../../utils/live-auction-event-outbox'

export default defineEventHandler(async (event) => {
  useDb()
  const actor = await assertLiveAuctionExtensionAuthorized(event)
  const body = await readBody<unknown>(event)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Payload de eventos inválido.' })
  }
  const events = (body as Record<string, unknown>).events
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    throw createError({ statusCode: 400, message: 'Envie de 1 a 100 eventos.' })
  }
  const result = await persistLiveAuctionEventBatch(events, actor)
  return { ok: result.rejected.length === 0, ...result }
})
