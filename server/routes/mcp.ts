import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { defineEventHandler, getHeader, readBody, setResponseHeader, setResponseHeaders, setResponseStatus, type H3Event } from 'h3'
import {
  authenticateMcpRequest,
  clientIp,
  getMcpAccessKey,
  mcpRequestLimiter,
  setUnauthorizedHeaders,
} from '../mcp/auth'
import { createMcpServer } from '../mcp/server'

/**
 * Endpoint MCP (Streamable HTTP, modo sem sessão): cada POST cria servidor + transporte novos.
 * O start-combined já encaminha `/mcp` para o Nuxt; o HTTPS vem do domínio do Railway.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
  'Access-Control-Max-Age': '600',
}

let version: string | null = null
function serverVersion(): string {
  if (version) return version
  version = process.env.npm_package_version?.trim() || null
  if (!version) {
    try {
      version = String(JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')).version ?? '')
    }
    catch {
      version = ''
    }
  }
  version ||= 'desconhecida'
  return version
}

function jsonRpcError(event: H3Event, status: number, message: string) {
  setResponseStatus(event, status)
  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  return { jsonrpc: '2.0', error: { code: -32000, message }, id: null }
}

export default defineEventHandler(async (event) => {
  setResponseHeaders(event, CORS_HEADERS)
  if (event.method === 'OPTIONS') {
    setResponseStatus(event, 204)
    return ''
  }

  if (!getMcpAccessKey()) {
    return jsonRpcError(event, 503, 'Servidor MCP desativado: configure MCP_ACCESS_KEY no backend.')
  }

  const auth = authenticateMcpRequest(event)
  if (!auth) {
    setUnauthorizedHeaders(event, getHeader(event, 'authorization') ? 'invalid_token' : null)
    return jsonRpcError(event, 401, 'Autenticação necessária.')
  }

  if (event.method !== 'POST') {
    setResponseHeader(event, 'Allow', 'POST, OPTIONS')
    return jsonRpcError(event, 405, 'Este servidor MCP não mantém sessão nem stream: use POST.')
  }

  if (!mcpRequestLimiter.hit(`${auth}:${clientIp(event)}`)) {
    setResponseHeader(event, 'Retry-After', '60')
    return jsonRpcError(event, 429, 'Muitas requisições ao MCP; aguarde um minuto.')
  }

  const body: unknown = await readBody(event)
  const server = createMcpServer(serverVersion())
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
  const res = event.node.res
  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  await server.connect(transport)
  await transport.handleRequest(event.node.req, res, body)

  // O transporte escreve a resposta direto no Node; só devolvemos o controle ao h3 depois disso.
  if (!res.writableEnded) {
    await new Promise<void>((resolve) => {
      res.once('finish', resolve)
      res.once('close', resolve)
    })
  }
})
