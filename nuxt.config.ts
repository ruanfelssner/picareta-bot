export default defineNuxtConfig({
  future: {
    compatibilityVersion: 4,
  },
  compatibilityDate: '2025-01-01',

  extends: [
    './layers/cars',
    // './layers/scrapers',      // Parte 3 — motor de scraping
    // './layers/marketplace',   // Parte 4 — Facebook Marketplace
  ],
})
