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
│   ├── app/pages/marketplace/
│   │   └── index.vue                       ← /marketplace
│   ├── server/api/marketplace/
│   │   ├── remote-searches/                 ← fila de buscas executadas pelo pnpm worker
│   │   ├── worker-status.get.ts             ← status (heartbeat) do worker do PC
│   │   └── archive*.ts / archived.get.ts    ← arquivamento de anúncios
│   ├── src/commands/web-search.ts           ← execução da busca web dentro do worker
│   └── src/facebook-marketplace.ts          ← executor Playwright (roda só no worker)
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
│   ├── business.md
│   ├── copart-extension-data-contract.md
│   └── live-auction-extension.md
│
├── .extension/
│   └── copart-live-collector/        ← extensao Chrome atual para captura ao vivo
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

### Processo combinado de producao

O container de producao executa `scripts/start-combined.mjs` como porta publica unica. Ele inicia
o servidor Nuxt e o scraper cloud em portas internas fixas e atua como proxy HTTP:

- `/health` e `/internal/scraping/*` seguem para o scraper cloud;
- todas as outras rotas seguem para o Nuxt, incluindo `/api/vehicles/*` usado pela extensao.

O Picareta lê o histórico operacional das condicionais nas collections compartilhadas
`copart_conditional_attempts` e `copart_conditional_runs`. O botão manual do Picareta encaminha uma
solicitação autenticada ao `/internal/scraping/conditional-check` do serviço cloud, que responde `202`
e continua a coordenação em segundo plano. A fila automática só inclui condicionais com pelo menos
dois dias completos; cada execução registra total, progresso, resultados e erros em
`copart_conditional_runs`. Os jobs ficam em `copart_conditional_jobs` e são reivindicados pela
extensão Chrome somente após a conexão explícita do navegador solicitada no Histórico público. Ela
reutiliza uma única aba, abre a página do lote usando a sessão local autenticada e só avança depois de
devolver ao backend o resultado normalizado. Cada lote consultado permanece detalhado em
`copart_conditional_attempts`; cookies e tokens de sessão não entram nas collections.

O scraper cloud e as rotas Nitro consumidas pela extensão devem usar a mesma conexão de dados,
priorizando `MONGO_DATA_URI`/`MONGO_DATA_DB_NAME` e usando `MONGO_URI`/`MONGO_DB_NAME` apenas como
fallback. Isso impede que a execução seja criada em uma base enquanto a extensão procura jobs em outra.

O `Dockerfile` deve gerar `.output` com `pnpm build` e iniciar `pnpm start:combined`. Por
compatibilidade com configuracoes antigas de deploy, `pnpm start:cloud` aponta para o mesmo
inicializador. O comando `pnpm start:scraper` e reservado ao processo isolado; publica-lo sozinho
faz as chamadas da extensao cairem na autenticacao interna e responderem `Chave do servico invalida`.

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

Ao concluir a execucao sem cancelamento, a rota de scraping envia ao Picareta uma unica chamada para `POST /api/v1/push/opportunity-matches`, contendo o `runId` e somente os `_id` que o MongoDB confirmou como insercoes. O webhook e autenticado por `PICARETA_INGEST_KEY`, tem timeout fixo e sua indisponibilidade nao transforma uma coleta concluida em falha.

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
| POST | `/api/vehicles/ingest` | cars — ingestao da extensao Chrome em `scraped_vehicles` |
| POST | `/api/vehicles/live-events/batch` | cars — recebe o log append-only da extensão e confirma somente após persistir no outbox Mongo |
| POST | `/api/vehicles/recapture` | cars — recaptura manual de uma página individual Copart e atualização do lote existente |
| POST | `/api/vehicles/ingest-text` | server — modo Documento da extensao, acrescenta eventos em arquivo texto |
| GET/POST | `/api/vehicles/ignored-lots` | cars — lista e registra lotes ignorados pela extensao |
| POST | `/api/vehicles/ignored-lots/:id/resolve` | cars — conclui a recuperacao de um lote ignorado |
| POST | `/api/vehicles/live-assistant` | cars — cruza lote ao vivo com scraping e calcula FIPE, taxas e análise |
| POST | `/api/vehicles/live-assistant/fipe-suggestions` | cars — sugestões FIPE sem exigir veículo persistido |
| POST | `/api/vehicles/:id/send` | cars |
| POST | `/api/vehicles/:id/favorite` | cars |
| GET | `/api/vehicles/:id/fipe-suggestions` | cars |
| POST | `/api/vehicles/:id/fipe` | cars |
| GET | `/api/favorites` | cars |
| PATCH | `/api/favorites/:id` | cars |
| GET | `/api/filters` | cars |
| PUT | `/api/filters` | cars |
| POST | `/api/fipe/lookup` | (root server/) |
| POST | `/api/marketplace/remote-searches` | root server — enfileira busca para o worker |
| GET | `/api/marketplace/remote-searches/latest` | root server |
| GET | `/api/marketplace/remote-searches/:id` | root server — delta de logs/prévias/finais |
| POST | `/api/marketplace/remote-searches/:id/cancel` | root server |
| GET | `/api/marketplace/worker-status` | root server |
| GET/POST | `/api/marketplace/archived`, `/archive`, `/unarchive` | root server |
| GET | `/api/copart-live/stream` | dev server (SSE) |
| GET | `/api/copart-live/events` | dev server |
| POST | `/api/copart-live/events` | root server — recebe eventos da extensão Chrome |

O histórico dos termos da tela `/marketplace` fica no `localStorage` do navegador, limitado aos 8
termos mais recentes. Essa persistência é exclusiva do cliente e não inclui resultados, sessão ou
credenciais.

## Auditoria do leilão ao vivo

O caminho crítico do chat é `MutationObserver → IndexedDB da extensão → outbox Mongo do bot → API
do Picareta → Mongo + Redis Stream → consolidador`. A extensão nunca depende da interpretação ou da
rede para conservar a mensagem original: eventos reconhecidos e não reconhecidos recebem `eventId`
estável e permanecem locais por oito dias. O bot confirma o lote apenas depois do upsert no outbox e
retenta o encaminhamento em background.

No Picareta, o Mongo é a fonte durável da auditoria e o Redis Stream desacopla a consolidação. O
consumidor idempotente deriva resultados finais, sessões e exceções de resultado ausente; reiniciar
ou reprocessar uma sessão não altera o fato bruto nem duplica o resultado. Logs brutos expiram após
oito dias (janela operacional exibida: sete), enquanto resultados e resumos consolidados continuam
no histórico.

## Layer de leilões públicos

O módulo `layers/auctions/` concentra as rotas e a regra dos leilões, sem colocar chamadas Mongo
ou Z-API nos componentes Vue. A tela administrativa fica em `/admin/leiloes`; a página pública
fica em `/lance/:slug`. A integração usa a mesma configuração Z-API já existente, mas envia para
o `announcementGroupId` salvo na coleção `whatsapp_communities`.

Rotas principais:

| Método | Rota | Finalidade |
|---|---|---|
| GET/POST | `/api/auctions` | listar/criar leilões |
| PATCH | `/api/auctions/:id` | editar rascunho |
| POST | `/api/auctions/:id/publish` | publicar e gerar aviso |
| POST | `/api/auctions/:id/announce` | reenviar aviso com a foto principal |
| POST | `/api/auctions/:id/finish` | finalizar e gerar aviso |
| GET | `/api/auctions/:id/bids` | listar lances administrativos |
| POST | `/api/auctions/bids/:id/accept` | aceitar lance pendente |
| POST | `/api/auctions/bids/:id/reject` | recusar lance pendente |
| GET/POST | `/api/auctions/community` | consultar/salvar comunidade |
| POST | `/api/auctions/community/invitation-link` | gerar link de convite da comunidade |
| GET/POST | `/api/public/auctions/:slug` e `/bids` | consultar leilão e enviar lance |


## Contrato de envio automático do Picareta (0.16.0)

A fila roda em um plugin Nitro do Picareta e persiste em seu MongoDB. A conclusão de scraping alimenta a fila também com registros atualizados, enquanto o webhook de novos IDs reaproveita o mesmo enfileiramento idempotente. A seleção usa a classificação histórica do Picareta e revalida cada lote antes de chamar o bot.

A integração reutiliza `POST /api/vehicles/:id/send`, com body `{ automatic: true, caption: string }` e header `x-scraper-service-key` validado contra `SCRAPER_SERVICE_KEY`. Somente esse caminho permite substituir a legenda padrão no `sendVehicleToZApi`. A foto, grupo de destino, atraso Z-API e criação do favorito seguem o fluxo existente. A requisição ao provedor tem timeout de 30 segundos; a chamada do Picareta tem 45 segundos. Aceite HTTP não equivale à confirmação de entrega. O worker separado de Marketplace não participa dessa fila.

## Scraper Pestana

`layers/scrapers/server/utils/sources/pestana.ts` contém descoberta, normalização e o contrato `ScraperSource`. `src/scrapers/pestana.ts` adapta o mesmo resultado para CLI/cloud; não há coleta no cliente nem implementação duplicada. O portal fornece todos os IDs em `/search-api/lote/filtrar`; os detalhes completos vêm de `/api/v2/lote/por-ids`. Metadados do HTML hidratado complementam nomes de características, leilões e comitentes. Protocolo e limites estão descritos em [03-scraping-pestana.md](03-scraping-pestana.md).

## Scrapers Vardana e Pampa Sul (0.37.0)

`layers/scrapers/server/utils/sources/vardana.ts` centraliza a coleta Vardana. `src/scrapers/vardana.ts` é o adapter CLI/cloud e chama o enriquecimento FIPE em `layers/cars/server/utils/public-auction-fipe.ts`; o runner Nuxt mantém seu enriquecimento existente após persistir. O helper consulta `fipe_cache` antes da API, separa cache por provider/referência/marca/modelo/ano e preserva valores publicados. Sem conexão Mongo, usa cache em memória.

`layers/scrapers/server/utils/sources/pampasul.ts` centraliza descoberta e normalização Pampa Sul. `src/scrapers/pampasul.ts` adapta o mesmo resultado para CLI/cloud. `public-auction-http.ts` compartilha somente transporte público, parser de moeda/data e concorrência fixa de três consultas. Não há automação de login, ofertas ou leitura de credenciais.

Os endpoints públicos de consulta exigem Referer/Origin e, na Pampa Sul, `X-Requested-With`. Paginação, contratos e validação estão em [04-scraping-vardana-pampasul.md](04-scraping-vardana-pampasul.md).

## FIPE manual na extensão (0.38.0)

`POST /api/vehicles/live-assistant` aceita `feesOnly: true` após autenticação/normalização para estimar taxas pela função compartilhada `estimateVehicleFees`, sem esperar histórico, correspondência ou captura. A extensão solicita essa estrutura uma vez por identidade/descrição de veículo e recalcula lances localmente; rejeita respostas atrasadas de outro lote e continua a consulta completa em paralelo. O modo financeiro não devolve dados de outros veículos.

`Salvar FIPE` e `Salvar lote` usam `/api/vehicles/ingest` com a FIPE confirmada e o lance real. A ingestão existente atualiza `scraped_vehicles`, sincroniza com Picareta e só encaminha resultados elegíveis ao WhatsApp. O marcador local `fipeManual` permite restaurar a FIPE confirmada da captura da mesma identidade ao reabrir a página; não é um campo novo de Mongo nem muda o esquema de FIPE. Detalhes em [05-extensao-fipe-manual.md](05-extensao-fipe-manual.md).

## Página individual Sodré (0.39.0)

O adapter da extensão reconhece também `/leilao/:leilao/lote/:codigo/` e usa `buildSodreDetailPreviewEvent` para ler o DOM cadastral identificado. `isIndividualLotPage` compartilha o modo de conferência com Copart: atualização passiva dos indicadores, `vehicle_detail` no assistente e ingestão somente por ação explícita. Uma leitura a cada 2,5 segundos, suspensa sem autenticação ou em aba oculta, acompanha atualizações do site sem acionar botões de lance/login. Consultas e taxas continuam no backend existente. Seletores e limitações estão em [06-extensao-lote-sodre.md](06-extensao-lote-sodre.md).
