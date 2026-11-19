import { defineEventHandler, readBody, setResponseHeaders, setResponseStatus } from 'h3'
import { clientIp, getSigningKey, oauthEndpointLimiter, usedAuthorizationCodes } from '../../mcp/auth'
import { exchangeToken, OAuthError } from '../../mcp/oauth-tokens'

/** Token endpoint (authorization_code com PKCE e refresh_token). Cliente público: sem client_secret. */
export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Access-Control-Allow-Origin': '*' })
  const signingKey = getSigningKey()
  if (!signingKey) {
    setResponseStatus(event, 404)
    return { error: 'mcp_disabled', error_description: 'Servidor MCP desativado.' }
  }
  if (!oauthEndpointLimiter.hit(`token:${clientIp(event)}`)) {
    setResponseStatus(event, 429)
    return { error: 'slow_down', error_description: 'Muitas requisições; aguarde um minuto.' }
  }

  const body: unknown = await readBody(event).catch(() => null)
  const params = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}

  try {
    const tokens = exchangeToken(signingKey, params, usedAuthorizationCodes)
    console.info(`[mcp:oauth] token emitido (${String(params.grant_type)})`)
    return tokens
  }
  catch (error) {
    if (!(error instanceof OAuthError)) throw error
    console.warn(`[mcp:oauth] token recusado: ${error.error} — ${error.description}`)
    setResponseStatus(event, error.error === 'invalid_client' ? 401 : 400)
    return { error: error.error, error_description: error.description }
  }
})
