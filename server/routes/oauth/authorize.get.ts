import { defineEventHandler, getQuery } from 'h3'
import { showAuthorizePage } from '../../mcp/http/authorize'

export default defineEventHandler(event => showAuthorizePage(event, getQuery(event)))
