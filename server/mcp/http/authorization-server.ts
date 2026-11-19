import { defineEventHandler } from 'h3'
import { authorizationServerMetadata } from './well-known'

// Registrado em nuxt.config.ts (`serverHandlers`) para `/.well-known/oauth-authorization-server`.
export default defineEventHandler(event => authorizationServerMetadata(event))
