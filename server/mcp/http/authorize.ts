import type { H3Event } from 'h3'
import { sendRedirect } from 'h3'
import { authorizeFailureLimiter, clientIp, getMcpAccessKey, getPublicOrigin, getSigningKey } from '../auth'
import { renderConsentPage, renderOAuthErrorPage } from '../oauth-page'
import {
  issueAuthorizationCode,
  OAuthError,
  parseAuthorizationRequest,
  safeEqual,
  type AuthorizationRequest,
} from '../oauth-tokens'

/** Fluxo de `/oauth/authorize`: GET mostra a tela; POST confere a chave e redireciona com o código. */

const FORWARDED_FIELDS = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'state', 'scope', 'resource'] as const
const LOCKED_MESSAGE = 'Muitas tentativas com chave incorreta. Aguarde 15 minutos e tente novamente.'

function hiddenFields(params: Record<string, unknown>): Record<string, string> {
  const fields: Record<string, string> = {}
  for (const name of FORWARDED_FIELDS) {
    const value = params[name]
    if (typeof value === 'string' && value.length <= 4096) fields[name] = value
  }
  return fields
}

function redirectOrigin(request: AuthorizationRequest): string {
  return new URL(request.redirectUri).origin
}

function parse(event: H3Event, params: Record<string, unknown>): AuthorizationRequest | string {
  const signingKey = getSigningKey()
  if (!signingKey) return renderOAuthErrorPage(event, 'Servidor MCP desativado: MCP_ACCESS_KEY não configurada.', 404)
  try {
    return parseAuthorizationRequest(signingKey, params)
  }
  catch (error) {
    if (error instanceof OAuthError) return renderOAuthErrorPage(event, error.description)
    throw error
  }
}

function page(event: H3Event, request: AuthorizationRequest, params: Record<string, unknown>, status: number, error: string | null, locked: boolean) {
  return renderConsentPage(event, {
    clientName: request.client.clientName,
    redirectHost: new URL(request.redirectUri).host,
    hiddenFields: hiddenFields(params),
    error,
    locked,
  }, status, redirectOrigin(request))
}

export function showAuthorizePage(event: H3Event, params: Record<string, unknown>) {
  const request = parse(event, params)
  if (typeof request === 'string') return request
  const locked = authorizeFailureLimiter.isBlocked(clientIp(event))
  return page(event, request, params, 200, locked ? LOCKED_MESSAGE : null, locked)
}

export async function submitAuthorizePage(event: H3Event, params: Record<string, unknown>) {
  const request = parse(event, params)
  if (typeof request === 'string') return request

  const target = new URL(request.redirectUri)
  if (request.state) target.searchParams.set('state', request.state)

  if (params.decision === 'deny') {
    target.searchParams.set('error', 'access_denied')
    return sendRedirect(event, target.toString(), 302)
  }

  const ip = clientIp(event)
  if (authorizeFailureLimiter.isBlocked(ip)) {
    return page(event, request, params, 429, LOCKED_MESSAGE, true)
  }

  const accessKey = getMcpAccessKey()
  const password = typeof params.password === 'string' ? params.password.trim() : ''
  if (!accessKey || !password || !safeEqual(password, accessKey)) {
    authorizeFailureLimiter.hit(ip)
    const locked = authorizeFailureLimiter.isBlocked(ip)
    console.warn(`[mcp:oauth] chave incorreta na autorização (ip=${ip}${locked ? ', bloqueado por 15 min' : ''})`)
    return page(event, request, params, locked ? 429 : 401, locked ? LOCKED_MESSAGE : 'Chave de acesso incorreta.', locked)
  }

  authorizeFailureLimiter.reset(ip)
  const code = issueAuthorizationCode(getSigningKey()!, request)
  target.searchParams.set('code', code)
  target.searchParams.set('iss', getPublicOrigin(event))
  console.info(`[mcp:oauth] acesso autorizado para ${request.client.clientName} (${target.host})`)
  return sendRedirect(event, target.toString(), 302)
}
