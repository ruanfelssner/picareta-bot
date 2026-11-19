import { fileURLToPath } from 'node:url'
import tailwindcss from '@tailwindcss/vite'

const mcpHandler = (file: string) => fileURLToPath(new URL(`./server/mcp/http/${file}`, import.meta.url))

export default defineNuxtConfig({
  future: {
    compatibilityVersion: 4,
  },
  compatibilityDate: '2025-01-01',
  css: ['~/assets/css/main.css'],
  vite: {
    plugins: [tailwindcss()],
  },

  extends: [
    './layers/cars',
    './layers/scrapers',
    './layers/auctions',
    // './layers/marketplace',   // Parte 4 — Facebook Marketplace
  ],

  // Metadados OAuth do servidor MCP (/mcp). Registrados aqui porque `server/routes/.well-known` é diretório oculto.
  serverHandlers: [
    { route: '/.well-known/oauth-protected-resource', method: 'get', handler: mcpHandler('protected-resource.ts') },
    { route: '/.well-known/oauth-protected-resource/mcp', method: 'get', handler: mcpHandler('protected-resource.ts') },
    { route: '/.well-known/oauth-authorization-server', method: 'get', handler: mcpHandler('authorization-server.ts') },
  ],

  runtimeConfig: {
    mongoUri: process.env.MONGO_DATA_URI ?? process.env.MONGO_URI ?? '',
    mongoDbName: process.env.MONGO_DATA_DB_NAME ?? process.env.MONGO_DB_NAME ?? 'marketplace',
    liveAuctionExtensionToken: process.env.LIVE_AUCTION_EXTENSION_TOKEN ?? '',
    liveAuctionTextFile: process.env.LIVE_AUCTION_TEXT_FILE ?? '',
    copartExtensionToken: process.env.COPART_EXTENSION_TOKEN ?? '',
    picaretaOpportunityWebhookUrl:
      process.env.PICARETA_OPPORTUNITY_WEBHOOK_URL
      ?? 'https://picareta.felss.dev/api/v1/push/opportunity-matches',
    picaretaIngestUrl:
      process.env.PICARETA_INGEST_URL
      ?? 'https://picareta.felss.dev/api/v1/scraped-vehicles/ingest',
    picaretaIngestKey: process.env.PICARETA_INGEST_KEY ?? '',
  },
})
