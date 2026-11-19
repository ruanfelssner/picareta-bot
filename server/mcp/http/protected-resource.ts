import { defineEventHandler } from 'h3'
import { protectedResourceMetadata } from './well-known'

// Registrado em nuxt.config.ts (`serverHandlers`) para `/.well-known/oauth-protected-resource` e `/.../mcp`.
export default defineEventHandler(event => protectedResourceMetadata(event))
