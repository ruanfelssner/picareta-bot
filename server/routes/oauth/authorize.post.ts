import { defineEventHandler, readBody } from 'h3'
import { submitAuthorizePage } from '../../mcp/http/authorize'

export default defineEventHandler(async (event) => {
  const body: unknown = await readBody(event).catch(() => null)
  const params = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {}
  return submitAuthorizePage(event, params)
})
