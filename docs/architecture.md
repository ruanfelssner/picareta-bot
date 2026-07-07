# Arquitetura — Monolito Modular com Nuxt 4 Layers

## Padrão: Modular Monolith

Este projeto segue o padrão **Modular Monolith** — um único deploy, múltiplos módulos com fronteiras bem definidas.

Cada `layer` é um módulo independente com suas próprias páginas, componentes, composables e rotas de servidor. Os módulos **não se importam diretamente entre si** — comunicam-se através de `shared/` (tipos e utils comuns) e das rotas de API.

Vantagens sobre micro-frontends:
- Sem complexidade de deploy distribuído
- Sem latência de rede entre serviços
- Refatoração mais segura — tudo no mesmo repositório
- Auto-import do Nuxt resolve dependências entre layers automaticamente

### Referências

| Recurso | Descrição |
|---|---|
| [Nuxt 4 Directory Structure](https://nuxt.com/docs/4.x/directory-structure) | Documentação oficial — `app/`, `server/`, `shared/`, `layers/` |
| [Authoring Nuxt Layers](https://nuxt.com/docs/4.x/guide/going-further/layers) | Como estruturar layers, restrições de path, auto-scan |
| [Layers — Get Started](https://nuxt.com/docs/getting-started/layers) | Introdução e casos de uso de layers |
| [Modular Monolith with Nuxt Layers](https://alexop.dev/posts/nuxt-layers-modular-monolith/) | Guia prático: shared layer, feature layers, isolamento entre módulos |
| [Modular Architecture in Nuxt](https://dev.to/jacobandrewsky/modular-architecture-in-nuxt-4jh9) | Padrões de organização por domínio |
| [Nuxt Layers — Dave Stewart](https://davestewart.co.uk/blog/nuxt-layers/) | Análise aprofundada de layers em projetos grandes |
| [Large app structure — nuxt/nuxt #23773](https://github.com/nuxt/nuxt/discussions/23773) | Discussão oficial da comunidade sobre estrutura em escala |

---

## Princípios do Nuxt 4

| Diretório | Onde roda | O que vai aqui |
|---|---|---|
| `app/` | cliente (+ SSR) | páginas, componentes, composables, layouts |
| `server/` | servidor (Nitro) | API routes, middleware, plugins de servidor |
| `shared/` | ambos | tipos, utils e constants usados pelo client E pelo server |
| `layers/` | depende do subdir | features isoladas — replicam a mesma estrutura acima |

Cada layer replica exatamente essa separação internamente.
`shared/` na raiz é o equivalente ao antigo `core` — acessível por todas as layers e pelo server global.

---

## Estrutura Completa

```
bot-anuncios/
│
├── app/                              ← shell global do app
│   ├── assets/
│   ├── components/                   ← componentes verdadeiramente globais
│   ├── composables/                  ← composables globais
│   ├── layouts/
│   │   └── default.vue
│   ├── middleware/
│   ├── pages/
│   │   └── index.vue                 ← redireciona para /cars
│   ├── plugins/
│   ├── utils/
│   ├── app.vue
│   ├── app.config.ts
│   └── error.vue
│
├── shared/                           ← compartilhado entre client e server (todas as layers)
│   ├── types/
│   │   ├── vehicle.ts                ← VehicleRecord, FavoriteRecord, VehicleSource, VehicleStatus
│   │   └── filters.ts                ← AuctionFilters, AuctionComboRule
│   ├── utils/
│   │   └── hash.ts                   ← sha1() para gerar externalId
│   └── constants/
│       └── sources.ts                ← metadados por VehicleSource (nome legível, cor do badge)
│
├── layers/
│   │
│   ├── cars/                         ← feature principal: veículos de leilão
│   │   ├── nuxt.config.ts
│   │   ├── app/
│   │   │   ├── components/
│   │   │   │   ├── VehicleCard.vue
│   │   │   │   ├── FavoriteCard.vue
│   │   │   │   ├── SourceSelector.vue      ← checkbox multi-select de fontes
│   │   │   │   ├── FilterRuleForm.vue      ← form fixo no topo
│   │   │   │   ├── FilterRuleList.vue
│   │   │   │   └── SaleHistoryModal.vue
│   │   │   ├── composables/
│   │   │   │   ├── useVehicles.ts
│   │   │   │   ├── useFavorites.ts
│   │   │   │   └── useFilters.ts
│   │   │   └── pages/
│   │   │       ├── index.vue               ← /  (preview ao vivo)
│   │   │       ├── archive.vue             ← /archive (ocultos/arquivados)
│   │   │       └── saves.vue               ← /saves (favoritos + rastreamento)
│   │   └── server/
│   │       └── api/
│   │           ├── vehicles/
│   │           │   ├── index.get.ts        ← GET  /api/vehicles
│   │           │   ├── scrape.post.ts      ← POST /api/vehicles/scrape (SSE)
│   │           │   └── [id]/
│   │           │       ├── send.post.ts    ← POST /api/vehicles/:id/send
│   │           │       └── favorite.post.ts← POST /api/vehicles/:id/favorite
│   │           ├── favorites/
│   │           │   ├── index.get.ts        ← GET  /api/favorites
│   │           │   └── [id].patch.ts       ← PATCH /api/favorites/:id
│   │           └── filters/
│   │               ├── index.get.ts        ← GET  /api/filters
│   │               └── index.put.ts        ← PUT  /api/filters
│   │
│   ├── marketplace/                  ← Facebook Marketplace (feature isolada)
│   │   ├── nuxt.config.ts
│   │   ├── app/
│   │   │   ├── components/
│   │   │   ├── composables/
│   │   │   └── pages/
│   │   │       └── marketplace/
│   │   │           └── index.vue           ← /marketplace
│   │   └── server/
│   │       ├── api/
│   │       │   └── marketplace/
│   │       │       └── search.post.ts      ← POST /api/marketplace/search (SSE)
│   │       └── utils/
│   │           └── playwright.ts           ← sessão Playwright com perfil persistente
│   │
│   └── scrapers/                     ← motor de scraping (server-only)
│       ├── nuxt.config.ts
│       ├── server/
│       │   ├── utils/                ← auto-importados pelo server de outras layers
│       │   │   ├── scraper-runner.ts ← orquestra fontes, captura erro por source
│       │   │   ├── sources/
│       │   │   │   ├── vs-veiculos.ts
│       │   │   │   ├── sodre.ts
│       │   │   │   ├── copart.ts
│       │   │   │   ├── favareto.ts
│       │   │   │   ├── claudio-kuss.ts
│       │   │   │   ├── megaleiloes.ts
│       │   │   │   ├── superbid.ts
│       │   │   │   ├── leiloesjudiciais.ts
│       │   │   │   ├── vipleiloes.ts
│       │   │   │   ├── mgl.ts
│       │   │   │   └── ph-batidos.ts
│       │   │   └── adapters/
│       │   │       └── [source].ts   ← raw → VehicleRecord por fonte
│       │   └── plugins/
│       │       └── playwright-pool.ts← inicializa pool de browsers se necessário
│       └── shared/
│           └── types/
│               └── scraper.ts        ← interface ScraperSource
│
├── server/                           ← server global (Nitro)
│   ├── middleware/
│   └── plugins/
│       └── mongodb.ts                ← conexão MongoDB (singleton, disponível em todas as routes)
│
├── content/                          ← (opcional) Nuxt Content para notas/docs internos
│
├── public/
│
├── src/
│   └── worker.ts                     ← worker WhatsApp (processo Node separado, não Nuxt)
│
├── docs/
│   ├── schema.md
│   ├── architecture.md               ← este arquivo
│   └── business.md
│
├── AGENT.md
├── CLAUDE.md
├── nuxt.config.ts
├── package.json
└── tsconfig.json
```

---

## Por que scrapers dentro do Nuxt

Os scrapers ficam em `layers/scrapers/server/utils/` — código Nitro server-only.
Vantagens:
- Auto-importados pelas server routes de `layers/cars/server/api/`
- Sem processo separado para gerenciar
- Compartilham a conexão MongoDB do plugin global

Playwright roda normalmente em Nitro com Node.js (não funciona em edge/serverless — este projeto é self-hosted).

---

## Fluxo de dados entre layers

```
shared/types/vehicle.ts
    ↑ importado por
layers/scrapers/server/utils/adapters/  → converte raw → VehicleRecord
    ↓ VehicleRecord[]
layers/cars/server/api/vehicles/scrape.post.ts → persiste + emite SSE
    ↓ stream SSE
layers/cars/app/pages/index.vue → exibe cards em tempo real
```

---

## Schemas Mongoose

Ficam em `server/` do projeto raiz ou em `layers/cars/server/utils/schemas/`.
Não em `app/` — Mongoose não roda no client.

Observação: `app/` não auto-importa diretórios arbitrários como `schemas/`.
Schemas de validação client-side (ex: Zod para forms) ficam em `app/utils/`.

---

## Worker WhatsApp

```
src/worker.ts        ← processo Node independente (pnpm worker)
```

Não migra para Nuxt. Processa a fila `marketplace_commands` no MongoDB e envia via Z-API.
Compartilha o banco mas não o processo com o app Nuxt.

---

## Rotas de API (sem versionamento)

| Método | Rota | Layer |
|---|---|---|
| GET | `/api/vehicles` | cars |
| POST | `/api/vehicles/scrape` | cars (SSE) |
| POST | `/api/vehicles/:id/send` | cars |
| POST | `/api/vehicles/:id/favorite` | cars |
| GET | `/api/vehicles/:id/fipe-suggestions` | cars |
| POST | `/api/vehicles/:id/fipe` | cars |
| GET | `/api/favorites` | cars |
| PATCH | `/api/favorites/:id` | cars |
| GET | `/api/filters` | cars |
| PUT | `/api/filters` | cars |
| POST | `/api/fipe/lookup` | (root server/) |
| POST | `/api/marketplace/search` | marketplace (SSE) |
| GET | `/api/copart-live/stream` | dev server (SSE) |
| GET | `/api/copart-live/events` | dev server |
| POST | `/api/copart-live/events` | root server — recebe eventos da extensão Chrome |
