# Contrato de dados — extensão Copart → Painel de Mercado

Este documento existe para quem está construindo a extensão de Chrome que coleta dados do Copart. Ele descreve **exatamente o que o Painel de Mercado (`/`) espera encontrar no banco** para conseguir analisar os dados corretamente. Se a extensão gravar fora desse formato, o dashboard não vai quebrar — mas também não vai "ver" os dados.

Para o funcionamento atual da extensão e o plano de evolução multi-site, consulte também [Extensão de leilão ao vivo](live-auction-extension.md).

## ⚠️ Antes de codar: o caminho de hoje é um beco sem saída

O Painel de Mercado (`layers/cars/server/api/market/overview.get.ts`) lê **exclusivamente** a collection **`scraped_vehicles`** (o schema `VehicleRecord`, em `layers/cars/server/utils/schemas/vehicle.ts`).

Já existe um endpoint de ingestão para dados "ao vivo" do Copart — `POST /api/copart-live/events` (`server/api/copart-live/events.post.ts`) — mas ele grava numa collection **completamente separada**, `copart_live_auction_events`. Não existe hoje nenhum código que pegue o que está em `copart_live_auction_events` e transforme em um `VehicleRecord` dentro de `scraped_vehicles`. Ou seja: **se a extensão postar para esse endpoint, os dados nunca aparecem no painel.**

Hoje, quem escreve em `scraped_vehicles` para a fonte Copart é só o scraper server-side (`layers/scrapers/server/utils/sources/copart.ts`), rodando internamente via Playwright — não é chamado por HTTP.

**Conclusão prática:** para a extensão alimentar o painel, use `POST /api/vehicles/ingest`. Esse endpoint aceita o formato descrito abaixo e faz upsert em `scraped_vehicles` por `externalId`, igual ao scraper interno. O endpoint antigo `POST /api/copart-live/events` continua existindo apenas para eventos brutos ao vivo e não alimenta o painel de mercado.

---

## 1. Onde os dados entram

- **Collection:** `scraped_vehicles`
- **Chave de upsert:** `externalId` (string única — index unique). Recomendado: `sha1(source + url)`, igual ao scraper atual faz. Reenviar o mesmo `externalId` deve **atualizar** o registro existente, nunca duplicar.
- **Campos imutáveis após o insert inicial:** `source`, `scrapedAt`, `expiresAt` — não sobrescrever em atualizações subsequentes do mesmo lote.

## 2. Campos que o painel realmente usa

O endpoint do painel projeta apenas: `_id, brand, model, year, source, damage, price, soldPrice, fipe, saleStatus, saleStatusRaw, url` — mais contagens agregadas sobre `price`, `fipe`, `soldPrice` e `scrapedAt`/`source` para os cards de cobertura da base.

| Campo | Tipo | Obrigatório p/ análise | Efeito se faltar |
|---|---|---|---|
| `source` | `'copart'` (ou outro valor do enum `VehicleSource`) | sim | sem isso o registro não é agrupável por leiloeiro |
| `saleStatus` | `'unknown' \| 'sold' \| 'conditional' \| 'not_sold'` | **sim — é o filtro principal** | se não for `'sold'` ou `'conditional'`, o registro **fica de fora de toda a análise do painel** (ver seção 3) |
| `fipe` | `number \| null` | sim, para entrar nos cálculos de % | se `null` ou `<= 0`, o registro continua contado nos totais brutos, mas é excluído de qualquer média/% de FIPE |
| `price` | `number \| null` | sim (como fallback) | usado quando `soldPrice` não existe |
| `soldPrice` | `number \| null` | recomendado quando `saleStatus = 'sold'` | se ausente, o painel usa `price` no lugar — mas `price` pode ser só o lance no momento da coleta, não o valor real do martelo |
| `brand`, `model`, `year` | `string`, `string`, `number \| null` | sim, para os agrupamentos "por marca"/"por modelo" | `brand`/`model` nunca devem vir vazios; `year` pode ser `null` |
| `category` | `string \| null` | sim, para filtrar tipo de veículo antes de persistir | se faltar ou não for categoria permitida, o endpoint de ingestão ignora o lote |
| `damage` | `string \| null` | sim, para o agrupamento "por tipo de monta" | `null` cai no bucket "Sem informação" — não quebra nada, só perde granularidade |
| `consignor` | `string \| null` | não | comitente capturado na sala ao vivo e exibido no Histórico Live |
| `manualDecision` | `'auto' \| 'save' \| 'skip'` | não | `save` permite sobrescrever filtros automáticos de categoria/monta; não sobrescreve status final, marca/modelo ou URL |
| `url` | `string` | sim, para o link "ver anúncio" no drill-down das faixas | obrigatório no schema, não pode ser vazio |

Nenhum desses campos, se ausente, gera erro — o painel **degrada silenciosamente** (exclui o registro do cálculo específico, não da base). Mas dado incompleto = análise mais pobre, então preencha o máximo possível.

## 3. A regra mais importante: o que conta como "resultado"

O painel só considera um veículo como dado de mercado utilizável quando:

```
saleStatus ∈ { 'sold', 'conditional' }
```

- `saleStatus = 'not_sold'` é contado à parte (card "não vendidos excluídos"), mas **nunca** entra em média de %, faixa de martelo ou mapa de oportunidade.
- `saleStatus = 'unknown'` (ou ausente) também fica fora — é tratado como "leilão ainda sem resultado", e o `price` desse registro pode ser só um lance parcial, não o valor final.

**Portanto:** a extensão só deve marcar `saleStatus` como `'sold'`/`'conditional'`/`'not_sold'` quando tiver certeza do resultado real do lote (leilão encerrado com resultado visível na página do Copart). Enquanto o leilão está em andamento, deixe `saleStatus = 'unknown'` (ou simplesmente não envie o campo — o default do schema já é `'unknown'`).

### Mapeamento de texto Copart → `saleStatus` (como já funciona hoje no scraper interno)

| Texto encontrado na página do Copart | `saleStatus` |
|---|---|
| "Vendido" / "Arrematado" / "Lance vencedor" / "Sold" | `sold` |
| "Condicional" | `conditional` |
| "Não vendido" | `not_sold` |
| Lote com histórico anterior que reaparece como "Venda Futura" | `not_sold` (reentrou no leilão sem vender) |
| Sem nenhum desses textos ainda | `unknown` (não enviar `saleStatus`, ou enviar `'unknown'`) |

Quando marcar `saleStatus = 'sold'`, preencha também `soldPrice` com o valor real arrematado — é o campo que o painel prioriza para o cálculo de %FIPE do vendido (`soldPrice ?? price`).

## 4. Fórmula de %FIPE (para conferência)

```
% da FIPE = (soldPrice ?? price) / fipe × 100
```

Só é calculada quando **ambos** `fipe > 0` e (`soldPrice` ou `price`) estão presentes. Essa é a métrica usada nas faixas (`<40%`, `40-45%`, ... `>80%`), nas médias por marca/leiloeiro/monta e no mapa de oportunidade.

## 5. Regras de monta ("damage")

Não existe um enum fixo — o campo é texto livre, e o painel classifica por regex (acento-insensível): contém "pequena" → pequena monta; "media"/"média" → média monta; "grande"/"sucata"/"perda total"/"irrecuperável" → grande monta. Mande o texto mais fiel possível ao que aparece na página do Copart (ex: `"Pequena Monta"`, `"Média Monta"`).

**Atenção:** o scraper interno **descarta** lotes de grande monta/sucata/perda total/irrecuperável — eles não devem ser persistidos. Se a extensão for alimentar o mesmo pipeline, siga a mesma regra para manter consistência com o resto da base.

## 6. Regras de categoria Copart

A extensão deve capturar o campo `Categoria` da página. O endpoint `POST /api/vehicles/ingest` só persiste as mesmas categorias usadas pelo scraper interno da Copart:

- `Automóveis`
- `SUV Grandes`
- `SUV Pequenos`
- `Picapes Grandes`
- `Picapes Pequenas`

Categorias como `Motos`, caminhões, ônibus, máquinas e outras variações fora dessa lista são ignoradas antes do upsert em `scraped_vehicles`.

O operador pode sobrescrever essa decisão pela extensão com `manualDecision: 'save'`. Esse override é intencional e rastreável nos logs, mas o backend ainda exige status final (`sold`, `conditional` ou `not_sold`), marca/modelo e URL/código.

## 7. Validações se for usar edição manual

Hoje já existe `PATCH /api/vehicles/:id/edit`, usado pela tela `/cars` para correções manuais pontuais (não é para ingestão em massa). Regras de validação lá, úteis como referência de tipos aceitos:

- `price`, `soldPrice`, `fipe`: número `>= 0` ou `null` explícito. Qualquer outro valor retorna erro 400.
- `saleStatus`: precisa ser exatamente `'unknown' | 'sold' | 'conditional' | 'not_sold'`.
- Ao setar `saleStatus` manualmente, o sistema grava `saleStatusRaw = 'Manual'` — é assim que o painel diferencia "vendido detectado automaticamente" de "vendido marcado à mão" (card "X de Y vieram de marcação manual").
- Ao setar `fipe` manualmente, o sistema zera os campos de proveniência (`fipeCode`, `fipeBrandMatched`, etc.) — se a extensão capturar a FIPE junto com o lote, preencha `fipeCode`/`fipeReferenceMonth` também quando disponível, para não perder essa rastreabilidade.

## 8. Expiração dos dados (TTL) — por que isso importa para o painel

`scraped_vehicles` tem TTL automático:

- Expira em 30 dias por padrão (`expiresAt = scrapedAt + 30d`).
- Se o veículo tem `auctionDate` mas **não tem preço**, expira em `auctionDate + 72h` — bem mais rápido.
- Um veículo sem preço cujo leilão já passou há mais de 72h **não deve nem ser inserido**.

**Implicação direta para o painel:** se a extensão só rodar esporadicamente, um lote que virou "vendido" pode expirar e sumir da base antes de acumular amostra suficiente para as análises. Se o objetivo é ter histórico confiável de resultados de leilão, vale considerar gravar o resultado assim que detectado (não esperar o próximo ciclo), e eventualmente pedir a criação de uma tabela de histórico permanente (fora do TTL) — hoje isso não existe.

## 9. Checklist rápido para a extensão

- [ ] Gerar `externalId` estável (ex: `sha1(source + url)`) e reenviar o mesmo valor ao atualizar o mesmo lote.
- [ ] Sempre enviar `source: 'copart'`, `brand`, `model`, `title`, `url` (campos obrigatórios no schema).
- [ ] Enviar `category` e só persistir categorias permitidas: `Automóveis`, `SUV Grandes`, `SUV Pequenos`, `Picapes Grandes`, `Picapes Pequenas`.
- [ ] Permitir override explícito com `manualDecision: 'save'` ou `manualDecision: 'skip'`, mantendo `auto` como padrão.
- [ ] Só marcar `saleStatus` como `sold`/`conditional`/`not_sold` quando o resultado estiver confirmado na página; caso contrário, omitir (fica `unknown`).
- [ ] Ao marcar `sold`, preencher `soldPrice` (não só `price`).
- [ ] Preencher `fipe` sempre que disponível — sem isso o lote não entra em nenhuma % do painel.
- [ ] Preencher `damage` com o texto da página, sem inventar categoria.
- [ ] Nunca enviar string vazia para campo desconhecido — usar `null`.
- [ ] Não persistir lotes de grande monta / sucata / perda total / irrecuperável.
- [ ] Enviar para `POST /api/vehicles/ingest` — `POST /api/copart-live/events` **não** alimenta o painel hoje.
