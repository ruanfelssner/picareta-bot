import { defineEventHandler, readBody, setResponseHeaders, setResponseStatus } from 'h3'
import { clientIp, getSigningKey, oauthEndpointLimiter } from '../../mcp/auth'
import { OAuthError, registerClient } from '../../mcp/oauth-tokens'

/** Registro dinâmico de cliente (RFC 7591). Sem estado: o client_id é a própria metadata assinada. */
export default defineEventHandler(async (event) => {
  setResponseHeaders(event, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' })
  const signingKey = getSigningKey()
  if (!signingKey) {
    setResponseStatus(event, 404)
    return { error: 'mcp_disabled', error_description: 'Servidor MCP desativado.' }
  }
  if (!oauthEndpointLimiter.hit(`register:${clientIp(event)}`)) {
    setResponseStatus(event, 429)
    return { error: 'slow_down', error_description: 'Muitas requisições; aguarde um minuto.' }
  }

  try {
    const body: unknown = await readBody(event).catch(() => null)
    const client = registerClient(signingKey, body)
    console.info(`[mcp:oauth] cliente registrado: ${client.clientName} → ${client.redirectUris.map(uri => new URL(uri).host).join(', ')}`)
    setResponseStatus(event, 201)
    return {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'search',
    }
  }
  catch (error) {
    if (!(error instanceof OAuthError)) throw error
    setResponseStatus(event, 400)
    return { error: error.error, error_description: error.description }
  }
})
