import type { H3Event } from 'h3'
import { setResponseHeaders, setResponseStatus } from 'h3'
import { getMcpAccessKey, getPublicOrigin } from '../auth'
import { MCP_SCOPE } from '../oauth-tokens'

/** Metadados OAuth (RFC 9728 e RFC 8414) usados pelo ChatGPT para descobrir como autenticar no `/mcp`. */

function prepare(event: H3Event): string | null {
  setResponseHeaders(event, {
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=300',
  })
  if (!getMcpAccessKey()) {
    setResponseStatus(event, 404)
    return null
  }
  return getPublicOrigin(event)
}

export function protectedResourceMetadata(event: H3Event) {
  const origin = prepare(event)
  if (!origin) return { error: 'mcp_disabled' }
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: 'Bot-Anúncios (consultas)',
  }
}

export function authorizationServerMetadata(event: H3Event) {
  const origin = prepare(event)
  if (!origin) return { error: 'mcp_disabled' }
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [MCP_SCOPE],
  }
}
