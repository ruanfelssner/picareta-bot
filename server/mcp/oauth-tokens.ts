import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * OAuth 2.1 mínimo e sem estado para o servidor MCP (ChatGPT só aceita OAuth ou "sem autenticação").
 *
 * Cliente registrado, código de autorização, access token e refresh token são payloads JSON assinados
 * com HMAC-SHA256. A chave deriva de `MCP_ACCESS_KEY`: trocar a chave revoga tudo de uma vez.
 * Não usa banco nem dependências do Nitro — o módulo é coberto por testes em `tests/mcp-oauth.test.ts`.
 */

export const MCP_SCOPE = 'search'
export const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
export const MIN_ACCESS_KEY_LENGTH = 24

const MAX_REDIRECT_URIS = 5
const MAX_REDIRECT_URI_LENGTH = 512
const MAX_TOKEN_LENGTH = 4096
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/
const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-_]{43}$/

type TokenKind = 'client' | 'code' | 'access' | 'refresh'

interface BasePayload {
  k: TokenKind
  /** Expiração em segundos (epoch). */
  exp?: number
}

export interface ClientPayload extends BasePayload {
  k: 'client'
  r: string[]
  n: string
  iat: number
}

interface CodePayload extends BasePayload {
  k: 'code'
  c: string
  r: string
  cc: string
  s: string
  j: string
  exp: number
}

interface AccessPayload extends BasePayload {
  k: 'access'
  c: string
  s: string
  exp: number
}

interface RefreshPayload extends BasePayload {
  k: 'refresh'
  c: string
  s: string
  j: string
  exp: number
}

export interface RegisteredClient {
  clientId: string
  clientName: string
  redirectUris: string[]
}

export interface TokenPair {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  refresh_token: string
  scope: string
}

export class OAuthError extends Error {
  constructor(
    readonly error: 'invalid_request' | 'invalid_client' | 'invalid_grant' | 'unsupported_grant_type' | 'invalid_redirect_uri' | 'invalid_client_metadata',
    readonly description: string,
  ) {
    super(description)
  }
}

function nowSeconds(now: number): number {
  return Math.floor(now / 1000)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Comparação em tempo constante, inclusive para tamanhos diferentes. */
export function safeEqual(first: string, second: string): boolean {
  return timingSafeEqual(sha256(first), sha256(second))
}

export function deriveSigningKey(accessKey: string): Buffer {
  return sha256(`bot-anuncios:mcp-oauth:v1:${accessKey}`)
}

function clientFingerprint(clientId: string): string {
  return sha256(clientId).toString('base64url').slice(0, 22)
}

function sign(key: Buffer, payload: BasePayload): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', key).update(`${payload.k}.${body}`).digest('base64url')
  return `${body}.${signature}`
}

function verify(key: Buffer, token: unknown, kind: TokenKind, now: number): Record<string, unknown> | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 2) return null
  const [body, signature] = parts as [string, string]

  // O tipo entra na assinatura: um refresh token não passa como access token e vice-versa.
  const expected = createHmac('sha256', key).update(`${kind}.${body}`).digest()
  const received = Buffer.from(signature, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  }
  catch {
    return null
  }
  if (!isRecord(payload) || payload.k !== kind) return null
  if (typeof payload.exp === 'number' && payload.exp <= nowSeconds(now)) return null
  return payload
}

/** HTTPS obrigatório; HTTP somente para localhost (MCP Inspector e testes locais). */
export function isAllowedRedirectUri(value: string): boolean {
  if (value.length > MAX_REDIRECT_URI_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  }
  catch {
    return false
  }
  if (url.hash || url.username || url.password) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
}

export function registerClient(key: Buffer, metadata: unknown, now = Date.now()): RegisteredClient {
  if (!isRecord(metadata)) throw new OAuthError('invalid_client_metadata', 'Corpo de registro inválido.')
  const redirectUris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((uri): uri is string => typeof uri === 'string')
    : []
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthError('invalid_redirect_uri', `Informe de 1 a ${MAX_REDIRECT_URIS} redirect_uris.`)
  }
  const invalid = redirectUris.find(uri => !isAllowedRedirectUri(uri))
  if (invalid) throw new OAuthError('invalid_redirect_uri', `redirect_uri não permitida: ${invalid.slice(0, 120)}`)

  const clientName = typeof metadata.client_name === 'string' && metadata.client_name.trim()
    ? metadata.client_name.trim().slice(0, 80)
    : 'Cliente MCP'

  const payload: ClientPayload = { k: 'client', r: [...new Set(redirectUris)], n: clientName, iat: nowSeconds(now) }
  return { clientId: sign(key, payload), clientName, redirectUris: payload.r }
}

export function readClient(key: Buffer, clientId: unknown, now = Date.now()): RegisteredClient | null {
  const payload = verify(key, clientId, 'client', now)
  if (!payload || !Array.isArray(payload.r) || typeof payload.n !== 'string') return null
  const redirectUris = payload.r.filter((uri): uri is string => typeof uri === 'string')
  return { clientId: clientId as string, clientName: payload.n, redirectUris }
}

export interface AuthorizationRequest {
  client: RegisteredClient
  redirectUri: string
  codeChallenge: string
  state: string | null
  scope: string
}

/** Valida os parâmetros de `/oauth/authorize` (GET e POST usam a mesma regra). */
export function parseAuthorizationRequest(key: Buffer, params: Record<string, unknown>, now = Date.now()): AuthorizationRequest {
  const client = readClient(key, params.client_id, now)
  if (!client) throw new OAuthError('invalid_client', 'Cliente OAuth desconhecido. Remova e adicione o conector novamente.')

  const redirectUri = typeof params.redirect_uri === 'string' ? params.redirect_uri : ''
  if (!client.redirectUris.includes(redirectUri)) {
    throw new OAuthError('invalid_redirect_uri', 'redirect_uri não corresponde ao cliente registrado.')
  }
  if (params.response_type !== 'code') throw new OAuthError('invalid_request', 'response_type deve ser "code".')
  if (params.code_challenge_method !== 'S256') throw new OAuthError('invalid_request', 'PKCE com S256 é obrigatório.')

  const codeChallenge = typeof params.code_challenge === 'string' ? params.code_challenge : ''
  if (!PKCE_CHALLENGE_PATTERN.test(codeChallenge)) throw new OAuthError('invalid_request', 'code_challenge inválido.')

  const state = typeof params.state === 'string' && params.state.length <= 1024 ? params.state : null
  return { client, redirectUri, codeChallenge, state, scope: MCP_SCOPE }
}

export function issueAuthorizationCode(key: Buffer, request: AuthorizationRequest, now = Date.now()): string {
  const payload: CodePayload = {
    k: 'code',
    c: clientFingerprint(request.client.clientId),
    r: request.redirectUri,
    cc: request.codeChallenge,
    s: request.scope,
    j: randomBytes(12).toString('base64url'),
    exp: nowSeconds(now) + AUTHORIZATION_CODE_TTL_SECONDS,
  }
  return sign(key, payload)
}

function issueTokenPair(key: Buffer, clientId: string, scope: string, now: number): TokenPair {
  const fingerprint = clientFingerprint(clientId)
  const access: AccessPayload = { k: 'access', c: fingerprint, s: scope, exp: nowSeconds(now) + ACCESS_TOKEN_TTL_SECONDS }
  const refresh: RefreshPayload = {
    k: 'refresh',
    c: fingerprint,
    s: scope,
    j: randomBytes(12).toString('base64url'),
    exp: nowSeconds(now) + REFRESH_TOKEN_TTL_SECONDS,
  }
  return {
    access_token: sign(key, access),
    token_type: 'Bearer',
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    refresh_token: sign(key, refresh),
    scope,
  }
}

/**
 * Registro de códigos já trocados (proteção contra replay). Em memória: o serviço roda em uma
 * única instância e o código vive no máximo 5 minutos.
 */
export class UsedCodeRegistry {
  private readonly used = new Map<string, number>()

  /** Retorna false se o código já foi usado. */
  consume(jti: string, expiresAt: number, now = Date.now()): boolean {
    const nowSec = nowSeconds(now)
    for (const [id, exp] of this.used) {
      if (exp <= nowSec) this.used.delete(id)
    }
    if (this.used.has(jti)) return false
    this.used.set(jti, expiresAt)
    return true
  }
}

export function exchangeToken(
  key: Buffer,
  params: Record<string, unknown>,
  usedCodes: UsedCodeRegistry,
  now = Date.now(),
): TokenPair {
  const grantType = params.grant_type
  const client = readClient(key, params.client_id, now)
  if (!client) throw new OAuthError('invalid_client', 'Cliente OAuth desconhecido.')
  const fingerprint = clientFingerprint(client.clientId)

  if (grantType === 'authorization_code') {
    const code = verify(key, params.code, 'code', now) as CodePayload | null
    if (!code || code.c !== fingerprint) throw new OAuthError('invalid_grant', 'Código de autorização inválido ou expirado.')
    if (params.redirect_uri !== code.r) throw new OAuthError('invalid_grant', 'redirect_uri diferente da autorização.')

    const verifier = typeof params.code_verifier === 'string' ? params.code_verifier : ''
    if (!PKCE_VERIFIER_PATTERN.test(verifier)) throw new OAuthError('invalid_grant', 'code_verifier ausente ou inválido.')
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    if (!safeEqual(challenge, code.cc)) throw new OAuthError('invalid_grant', 'code_verifier não confere (PKCE).')

    if (!usedCodes.consume(code.j, code.exp, now)) throw new OAuthError('invalid_grant', 'Código de autorização já utilizado.')
    return issueTokenPair(key, client.clientId, code.s, now)
  }

  if (grantType === 'refresh_token') {
    const refresh = verify(key, params.refresh_token, 'refresh', now) as RefreshPayload | null
    if (!refresh || refresh.c !== fingerprint) throw new OAuthError('invalid_grant', 'Refresh token inválido ou expirado.')
    return issueTokenPair(key, client.clientId, refresh.s, now)
  }

  throw new OAuthError('unsupported_grant_type', 'Use authorization_code ou refresh_token.')
}

export function verifyAccessToken(key: Buffer, token: string, now = Date.now()): { scope: string } | null {
  const payload = verify(key, token, 'access', now)
  if (!payload || typeof payload.s !== 'string') return null
  return { scope: payload.s }
}
