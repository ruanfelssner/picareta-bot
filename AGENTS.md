# AGENT.md

Instruções de trabalho para agentes de IA neste projeto.
Leia a seção da área em que vai atuar antes de qualquer mudança.

**Documentação de referência** (leia antes de implementar):
- [docs/schema.md](docs/schema.md) — tipos, interfaces, collections MongoDB
- [docs/architecture.md](docs/architecture.md) — estrutura de layers, rotas de API, convenções de código
- [docs/business.md](docs/business.md) — regras de negócio, fluxos, cálculos

---

## Regra fundamental

Toda chamada de backend (MongoDB, scrapers, FIPE, Z-API) DEVE estar em `server/api/` ou nos `layers/`.
Nunca colocar lógica de dados em componentes Vue ou composables de cliente.

---

## Por área

### Preview ao vivo (`pages/index.vue`)

- Consulte `docs/business.md` — seção "Fluxo Principal"
- `SourceSelector.vue` controla quais fontes rodam — mínimo 1 selecionada para habilitar o botão
- Scraping persiste na collection `scraped_vehicles` ANTES de emitir o evento SSE
- Não adicionar seleção em lote — envio é sempre 1 a 1 via botão no card
- Não exibir consulta FIPE por placa nesta página

### Filtros (`pages/filters.vue`)

- Consulte `docs/schema.md` — seção `AuctionComboRule`
- Consulte `docs/business.md` — seção "Regras de Filtro"
- O formulário de adição fica SEMPRE fixo acima da lista — a lista cresce para baixo
- Após adicionar uma regra: limpar campos e retornar foco ao primeiro campo
- Ordenação da lista: enabled primeiro, depois include antes de exclude

### Favoritos (`pages/favorites.vue`)

- Consulte `docs/schema.md` — seção `FavoriteRecord`
- Consulte `docs/business.md` — seção "Favoritos" e "Cálculo de % FIPE"
- Favoritos são criados pelo send — nunca criar manualmente nesta página
- `fipePercent` na época do envio é imutável — não recalcular no PATCH
- `soldFipePercent` é calculado no PATCH quando `soldPrice` e `soldFipe` chegarem

### VehicleCard (`components/VehicleCard.vue`)

- Props: `vehicle: VehicleRecord`, `showSendButton?: boolean`, `compact?: boolean`
- Emite `send` — o pai é responsável por chamar a API
- Badge de fonte: cor definida em `layers/core/constants/sources.ts`
- % FIPE só aparece se `vehicle.fipe != null && vehicle.price != null`
- Imagem com fallback para placeholder SVG se `imageUrls` vazio

### Scrapers (`layers/scrapers/`)

- Consulte `docs/architecture.md` — seção "Scrapers (interface padrão)"
- Consulte `docs/schema.md` — seção "VehicleRecord — Regras de preenchimento"
- Cada scraper exporta `ScraperSource` com `id`, `name` e `run()`
- Adapter em `layers/scrapers/adapters/xxx.ts` — converte raw → VehicleRecord
- Falha em uma source não para as outras — capturar por source com try/catch
- Log obrigatório: `console.info("[scraper:xxx] iniciando")` e ao finalizar

### FIPE (`layers/fipe/`)

- Consulte `docs/business.md` — seção "FIPE"
- Sempre verificar `fipe_cache` antes de chamar a API Parallelum
- Nunca expor o token FIPE no cliente
- Consulta por placa: backend only — não criar rota pública para isso

### WhatsApp (`layers/whatsapp/`)

- Consulte `docs/business.md` — seção "WhatsApp / Envio"
- Ao enviar: criar `FavoriteRecord` + atualizar `vehicle.status = "sent"` na mesma operação
- Respeitar `ZAPI_DELAY_MESSAGE` entre envios
- O worker (`src/worker.ts`) é processo separado — não alterar sua lógica ao mexer nos layers

---

## Ao finalizar uma implementação

Ao concluir qualquer implementação, correção, refactor ou conjunto de mudanças relacionadas, SEMPRE sugerir uma mensagem de commit no formato convencional:

```
<tipo>(<escopo>): <descrição curta no imperativo>

<corpo opcional: o que mudou e por quê, se não for óbvio>
```

**Tipos válidos:** `feat`, `fix`, `refactor`, `chore`, `docs`, `style`, `test`

**Escopos sugeridos por área:**
- `cars` — layer de veículos (preview, archive, saves)
- `scrapers` — motor de scraping e adapters
- `marketplace` — layer do Facebook Marketplace
- `fipe` — integração FIPE
- `whatsapp` — worker e formatters
- `filters` — regras de filtro
- `schema` — tipos e schemas de dados
- `infra` — MongoDB, plugins, configuração Nuxt

**Exemplo de sugestão ao finalizar:**
```
feat(cars): adicionar seleção de fontes por checkbox no preview ao vivo

Usuário agora pode selecionar quais scrapers ativar antes de iniciar.
Mínimo de 1 fonte obrigatória para habilitar o botão de scraping.
```

A sugestão deve aparecer ao final da resposta, em bloco destacado, sem executar o commit — a decisão de commitar é sempre do usuário.

---

## Nunca fazer

- `any` no TypeScript — usar `unknown` com narrowing
- String vazia em campos de `VehicleRecord` — usar `null`
- Criar favorito sem ter enviado via WhatsApp
- Alterar `expiresAt` de um `VehicleRecord` após o insert
- Duplicar lógica de negócio entre client e server
- Expor consulta FIPE por placa na UI
- Implementar envio em lote
