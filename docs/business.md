# Regras de Negócio

## Fluxo Principal

```
Scraping → Persistência (TTL 30d) → Preview UI → Envio WhatsApp → Favorito → Rastreamento
```

1. Usuário seleciona fontes e inicia scraping no Preview
2. Cada veículo encontrado é convertido para `VehicleRecord` e salvo com `status: "scraped"`
3. Veículos aparecem em tempo real via SSE no Preview
4. Usuário envia 1 veículo por vez para o WhatsApp
5. Ao enviar: `status` muda para `"sent"` e um `FavoriteRecord` é criado
6. Na página de Favoritos, o usuário acompanha e pode registrar o preço de venda

---

## Cálculo de % FIPE

```
fipePercent = Math.round((price / fipe) * 100)
```

- < 70% → muito interessante (destacar em verde)
- 70–85% → interessante
- 85–100% → próximo da tabela
- > 100% → acima da tabela (raramente relevante em leilão)

`fipePercent` é calculado tanto na época do envio (`FavoriteRecord.fipePercent`) quanto na época da venda (`soldFipePercent`), permitindo comparação histórica.

---

## Filtros Geográficos

Estados ativos por padrão: **PR, SC, SP, RS**

Regra de downgrade de relevância por localização (legado marketplace):
- RS → relevância reduzida (distância maior)
- Fora de PR → relevância reduzida mas não descartada

Para leilões, o filtro geográfico é aplicado no scraping — veículos de outros estados são descartados na source antes de persistir.

---

## Regras de Filtro (Combo Rules)

Cada `AuctionComboRule` define um critério de inclusão ou exclusão:

| Campo | Tipo | Descrição |
|---|---|---|
| `mode` | `"include"` \| `"exclude"` | Se inclui ou exclui veículos que batam |
| `brand` | string? | Marca do veículo (ex: "Toyota") |
| `model` | string? | Modelo (ex: "Corolla") |
| `text` | string? | Palavra no título/descrição |
| `minYear` | number? | Ano mínimo de fabricação |
| `enabled` | boolean | Se a regra está ativa |

**Lógica de aplicação:**
1. Filtros `include` definem o que queremos ver
2. Filtros `exclude` removem da lista mesmo que batam no include
3. Se não há nenhum `include`, tudo passa (exceto os `exclude`)
4. Combinação de campos numa mesma regra usa AND (brand E model E minYear)

---

## Persistência Temporária (Scraped Vehicles)

- TTL padrão: 30 dias via índice MongoDB `{ expiresAt: 1 }`
- Veículo com `auctionDate` e sem valor (`price == null`) expira em `auctionDate + 72h`
- Se o scraping encontrar veículo sem valor cujo leilão já passou há mais de 72h, ele não deve ser persistido
- Upsert por `externalId` — re-scrapar o mesmo veículo atualiza os dados, não duplica
- Campos imutáveis após insert: `source`, `url`, `externalId`, `scrapedAt`, `expiresAt`
- `status` é o único campo de ciclo de vida — muda de `scraped` → `sent`

---

## Favoritos

- Criados automaticamente ao enviar via WhatsApp — nunca criar manualmente
- Não têm TTL — permanecem para sempre
- Um veículo pode gerar apenas 1 favorito (constraint por `vehicleId`)
- `fipePercent` na época do envio é imutável após criação
- `soldFipePercent` é calculado no PATCH quando `soldPrice` e `soldFipe` forem fornecidos

---

## Copart ao vivo

- O monitor roda dentro do `pnpm dev`, via backend Express + Playwright.
- A captura lê a tela visível da sala ao vivo da Copart usando o perfil persistente já configurado.
- Perfil usado: `PROFILE_PATH` ou, se ausente, `./data/facebook-profile`.
- Se a Copart abrir deslogada, usar o botão "Abrir/login Copart", entrar pela home pública, aceitar termos após autenticar e manter a janela aberta antes de iniciar a captura.
- A captura reaproveita a janela aberta pelo botão de login para preservar cookies de sessão que podem não sobreviver ao fechamento do Chromium.
- Se a Copart continuar derrubando sessão no Chromium Playwright, configurar `COPART_CHROME_CDP_URL` e abrir o Chrome real logado com remote debugging. Exemplo Windows: `chrome.exe --remote-debugging-port=9222 --user-data-dir=%TEMP%\copart-cdp`.
- A modal de termos da Copart só renderiza os botões quando o usuário não é anônimo; se eles sumirem, o profile Playwright ainda está deslogado.
- Cada mudança relevante é persistida em `copart_live_auction_events`.
- Eventos de sistema como `Novo lance`, `Venda condicional` e `Vendido` geram registros idempotentes.
- O resultado final do lote deve guardar:
  - lote e código Copart
  - imagem/URL do lote
  - descrição, versão, ano/modelo, tipo de monta e pátio
  - lance final
  - status da venda: `sold` ou `conditional`
  - `% FIPE` no horário da captura
- Captura ao vivo não cria favorito e não dispara WhatsApp automaticamente.

---

## FIPE

- Provider: API Parallelum (`https://fipe.parallelum.com.br/api/v2`)
- Cache: 30 dias em `fipe_cache` — buscar por `(brand, model, year)` antes de chamar a API
- Consulta por placa (placafipe.com): disponível apenas no backend — não exposta na UI
- Token de API: `FIPE_API_TOKEN` (env) — aumenta rate limit diário

---

## WhatsApp / Envio

- Envio sempre 1 veículo por vez — sem envio em lote
- Delay entre mensagens: `ZAPI_DELAY_MESSAGE` segundos (env, default 2)
- Máximo de imagens por mensagem: `ZAPI_MAX_IMAGES` (env, default 5)
- Ao enviar, registrar em `favorites` + atualizar `vehicles.status = "sent"`
- Worker (`src/worker.ts`) processa comandos de busca vindos do WhatsApp — processo separado

---

## O que foi removido intencionalmente

| Funcionalidade | Motivo |
|---|---|
| Salvar por URL | Substituído pela persistência padronizada via scraping |
| Seleção de envio em lote | Fluxo é sempre 1 a 1 para manter controle |
| Consulta FIPE por placa na UI | Disponível apenas internamente via worker |
