import type { H3Event } from 'h3'
import { getHeader, getRequestIP, getRequestURL, setResponseHeader } from 'h3'
import {
  deriveSigningKey,
  MIN_ACCESS_KEY_LENGTH,
  safeEqual,
  UsedCodeRegistry,
  verifyAccessToken,
} from './oauth-tokens'

/**
 * Autenticação do `/mcp`:
 * - `Authorization: Bearer <MCP_ACCESS_KEY>` para clientes que aceitam header fixo (Claude, Cursor, Inspector, API);
 * - access token OAuth emitido por `/oauth/token` (fluxo usado pelo ChatGPT).
 * Sem `MCP_ACCESS_KEY` (ou com menos de 24 caracteres) o MCP e o OAuth ficam desativados.
 */

let cachedKey: { raw: string, signing: Buffer } | null = null
let warnedShortKey = false

export const usedAuthorizationCodes = new UsedCodeRegistry()

export function getMcpAccessKey(): string | null {
  const key = process.env.MCP_ACCESS_KEY?.trim() ?? ''
  if (!key) return null
  if (key.length < MIN_ACCESS_KEY_LENGTH) {
    if (!warnedShortKey) {
      warnedShortKey = true
      console.warn(`[mcp] MCP_ACCESS_KEY ignorada: use pelo menos ${MIN_ACCESS_KEY_LENGTH} caracteres (ex.: openssl rand -hex 32).`)
    }
    return null
  }
  return key
}

export function getSigningKey(): Buffer | null {
  const key = getMcpAccessKey()
  if (!key) return null
  if (cachedKey?.raw !== key) cachedKey = { raw: key, signing: deriveSigningKey(key) }
  return cachedKey.signing
}

/** Origem pública (atrás do proxy do Railway e do start-combined); HTTPS fora de localhost. */
export function getPublicOrigin(event: H3Event): string {
  const url = getRequestURL(event, { xForwardedHost: true, xForwardedProto: true })
  const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)
  return `${isLocal ? url.protocol : 'https:'}//${url.host}`
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`
}

export type McpAuthKind = 'static' | 'oauth'

export function authenticateMcpRequest(event: H3Event): McpAuthKind | null {
  const accessKey = getMcpAccessKey()
  const signingKey = getSigningKey()
  if (!accessKey || !signingKey) return null
  const header = getHeader(event, 'authorization') ?? ''
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!match?.[1]) return null
  const token = match[1]
  if (safeEqual(token, accessKey)) return 'static'
  return verifyAccessToken(signingKey, token) ? 'oauth' : null
}

export function setUnauthorizedHeaders(event: H3Event, error: 'invalid_token' | null = null) {
  const origin = getPublicOrigin(event)
  const parts = [`resource_metadata="${resourceMetadataUrl(origin)}"`, 'scope="search"']
  if (error) parts.unshift(`error="${error}"`)
  setResponseHeader(event, 'WWW-Authenticate', `Bearer ${parts.join(', ')}`)
}

export function clientIp(event: H3Event): string {
  return getRequestIP(event, { xForwardedFor: true }) ?? 'desconhecido'
}

/** Janela fixa em memória (instância única no Railway). */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number, resetAt: number }>()

  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** Registra uma tentativa; retorna false quando o limite da janela foi excedido. */
  hit(key: string, now = Date.now()): boolean {
    if (this.hits.size > 5_000) {
      for (const [id, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(id)
    }
    const entry = this.hits.get(key)
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs })
      return true
    }
    entry.count += 1
    return entry.count <= this.limit
  }

  isBlocked(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key)
    return Boolean(entry && entry.resetAt > now && entry.count >= this.limit)
  }

  reset(key: string) {
    this.hits.delete(key)
  }
}

/** 60 chamadas/min por cliente autenticado. */
export const mcpRequestLimiter = new FixedWindowLimiter(60, 60_000)
/** 5 senhas erradas a cada 15 min por IP na tela de autorização. */
export const authorizeFailureLimiter = new FixedWindowLimiter(5, 15 * 60_000)
/** Registro dinâmico de clientes e troca de tokens: 30/min por IP. */
export const oauthEndpointLimiter = new FixedWindowLimiter(30, 60_000)
