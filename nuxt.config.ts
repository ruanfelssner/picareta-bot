import tailwindcss from '@tailwindcss/vite'

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
    // './layers/marketplace',   // Parte 4 — Facebook Marketplace
  ],

  runtimeConfig: {
    mongoUri: process.env.MONGO_URI ?? '',
    mongoDbName: process.env.MONGO_DATA_DB_NAME ?? process.env.MONGO_DB_NAME ?? 'marketplace',
  },
})
