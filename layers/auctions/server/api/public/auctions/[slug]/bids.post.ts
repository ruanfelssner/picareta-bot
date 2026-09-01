import { getHeader, getRequestIP } from 'h3'
import { submitBid } from '../../../../utils/auction-service'

const attempts = new Map<string, number[]>()
const WINDOW_MS = 60_000
const MAX_ATTEMPTS = 5

function assertRateLimit(key: string) {
  const now = Date.now()
  const recent = (attempts.get(key) ?? []).filter(timestamp => now - timestamp < WINDOW_MS)
  if (recent.length >= MAX_ATTEMPTS) throw createError({ statusCode: 429, message: 'Muitas tentativas. Aguarde um minuto.' })
  recent.push(now)
  attempts.set(key, recent)
}

export default defineEventHandler(async (event) => {
  useDb()
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, message: 'Slug inválido.' })
  const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown'
  assertRateLimit(`${ip}:${slug}`)
  const body = await readBody<Record<string, unknown>>(event)
  if (typeof body?.name !== 'string') throw createError({ statusCode: 400, message: 'Nome é obrigatório.' })
  return await submitBid(slug, { name: body.name, sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined, event })
})
