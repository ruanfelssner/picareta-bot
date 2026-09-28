import { createHash, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'

export type LiveAuctionExtensionActor = {
  kind: 'user' | 'service'
  userId: string | null
  phone: string | null
  name: string
  role: 'admin' | 'user'
  deviceId: string | null
}

type CachedActor = {
  actor: LiveAuctionExtensionActor
  expiresAt: number
}

const SESSION_CACHE_MS = 60_000
const sessionCache = new Map<string, CachedActor>()

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function safeEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first)
  const secondBytes = Buffer.from(second)
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes)
}

function bearerToken(event: H3Event): string | null {
  return optionalString(getHeader(event, 'authorization')?.replace(/^Bearer\s+/i, ''))
}

function legacyServiceActor(event: H3Event): LiveAuctionExtensionActor | null {
  const config = useRuntimeConfig()
  const configuredToken = optionalString(config.liveAuctionExtensionToken)
    ?? optionalString(process.env.LIVE_AUCTION_EXTENSION_TOKEN)
    ?? optionalString(config.copartExtensionToken)
    ?? optionalString(process.env.COPART_EXTENSION_TOKEN)
  const providedToken = optionalString(getHeader(event, 'x-live-auction-extension-token'))
    ?? optionalString(getHeader(event, 'x-copart-extension-token'))
  if (!configuredToken || !providedToken || !safeEqual(configuredToken, providedToken)) return null
  return {
    kind: 'service',
    userId: null,
    phone: null,
    name: 'Serviço interno',
    role: 'admin',
    deviceId: optionalString(getHeader(event, 'x-live-auction-worker-id')),
  }
}

function picaretaSessionEndpoint(): URL {
  const config = useRuntimeConfig()
  const ingestUrl = optionalString(config.picaretaIngestUrl) ?? optionalString(process.env.PICARETA_INGEST_URL)
  if (!ingestUrl) {
    throw createError({ statusCode: 503, message: 'Integração com o Picareta não configurada.' })
  }
  return new URL('/api/v1/auth/extension/session', ingestUrl)
}

async function validateUserToken(token: string): Promise<LiveAuctionExtensionActor | null> {
  const cacheKey = createHash('sha256').update(token).digest('hex')
  const cached = sessionCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.actor

  const response = await fetch(picaretaSessionEndpoint(), {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null)
  if (!response?.ok) return null

  const body = await response.json().catch(() => null) as {
    user?: { id?: unknown; phone?: unknown; name?: unknown; role?: unknown; deviceId?: unknown }
  } | null
  const user = body?.user
  if (typeof user?.id !== 'string' || typeof user.phone !== 'string' || typeof user.name !== 'string'
    || (user.role !== 'admin' && user.role !== 'user') || typeof user.deviceId !== 'string') return null

  const actor: LiveAuctionExtensionActor = {
    kind: 'user',
    userId: user.id,
    phone: user.phone,
    name: user.name,
    role: user.role,
    deviceId: user.deviceId,
  }
  sessionCache.set(cacheKey, { actor, expiresAt: Date.now() + SESSION_CACHE_MS })
  if (sessionCache.size > 500) {
    for (const [key, item] of sessionCache) {
      if (item.expiresAt <= Date.now()) sessionCache.delete(key)
    }
  }
  return actor
}

export async function assertLiveAuctionExtensionAuthorized(
  event: H3Event,
  options: { admin?: boolean } = {},
): Promise<LiveAuctionExtensionActor> {
  const token = bearerToken(event)
  const actor = token ? await validateUserToken(token) : legacyServiceActor(event)
  if (!actor) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      message: 'Entre com sua conta do Picareta na extensão.',
    })
  }
  if (options.admin && actor.role !== 'admin') {
    throw createError({ statusCode: 403, message: 'Esta operação exige uma conta administradora do Picareta.' })
  }
  return actor
}
