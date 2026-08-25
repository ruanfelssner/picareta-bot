# Regras de Negócio

## Fluxo Principal

Ao final de cada scraping manual/API, se houver insercoes reais, o bot chama o webhook do Picareta uma unica vez. O bot nao envia um evento por veiculo: o Picareta recebe o lote completo, cruza os IDs novos com os filtros de cada usuario e decide quais Push agrupados devem ser entregues. Recoletas que apenas atualizam registros existentes nao geram esse aviso.

```
Scraping → Persistência (TTL 5 anos) → Preview UI → Envio WhatsApp → Favorito → Rastreamento
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

Para leilões, o filtro geográfico é aplicado na exibição. O envio pelo botão manual do WhatsApp não é bloqueado por estado/cidade — a decisão de envio é do usuário.

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

## Filtros de Período e Monta

- A lista principal abre em `Próximos`.
- `Próximos` inclui somente leilões de hoje e amanhã, desde que `auctionStatus != "finished"` e `saleStatus` não seja resultado final.
- `Todos` mostra apenas leilões ativos de hoje para frente, incluindo `auctionStatus = "future"` e veículos sem `auctionDate`; não inclui `Passados`.
- `Passados` mostra veículos com `auctionStatus = "finished"`, `saleStatus = "sold" | "conditional" | "not_sold"` ou `auctionDate` anterior ao dia atual, exceto quando `auctionStatus = "future"`.
- Registros antigos sem `auctionStatus`, mas com `auctionDate` passada, são exibidos como `auctionStatus = "finished"` na API e não podem ser reenviados por WhatsApp, salvo `saleStatus = "sold"`.
- Para Copart legado nessa condição, a API preenche `auctionStatusRaw = "Venda Finalizada"` para o card mostrar o mesmo termo do site.
- `Venda futura` da Copart vira `auctionStatus = "future"` e continua em `Todos` quando é lote novo ou ainda não há histórico suficiente.
- Se um lote Copart já existia com leilão anterior conhecido e depois volta como `Data da Venda: Venda Futura`, ele é tratado como `saleStatus = "not_sold"` e `auctionStatus = "finished"`.
- `Venda finalizada` da Copart vira `auctionStatus = "finished"` e vai para `Passados`.
- `Condicional` da Copart vira `saleStatus = "conditional"` quando esse texto aparecer nos dados coletados.
- `Vendido`, `Condicional` e `Não vendido` do Claudio Kuss vêm do endpoint `json_lance_historico.php` e viram `saleStatus = "sold" | "conditional" | "not_sold"` com `auctionStatus = "finished"`.
- Quando o Claudio Kuss retorna `Vendido`, o valor final é persistido em `soldPrice`.
- Grande monta, sucata, perda total e irrecuperável são descartados e não devem aparecer nas listas.

---

## Persistência Temporária (Scraped Vehicles)

- TTL padrão: 5 anos via índice MongoDB `{ expiresAt: 1 }`
- Veículo com `auctionDate` e sem valor (`price == null`) expira em `auctionDate + 72h`
- Se o scraping encontrar veículo sem valor cujo leilão já passou há mais de 72h, ele não deve ser persistido
- Upsert por `externalId` — re-scrapar o mesmo veículo atualiza os dados, não duplica
- Se o `externalId` mudar mas o scraper reencontrar o mesmo lote/leilão, o `VehicleRecord` existente é atualizado mesmo quando `status = "sent"` ou `"favorite"`
- Campos imutáveis após insert: `source`, `scrapedAt`, `expiresAt`
- `url` e `externalId` podem ser migrados apenas durante reconciliação de duplicados do mesmo lote
- `status` controla envio/favorito e muda de `scraped` → `sent`
- `auctionStatus` controla o ciclo do leilão: `unknown`, `upcoming`, `future`, `finished`
- `saleStatus` controla o resultado de venda conhecido: `unknown`, `sold`, `conditional`, `not_sold`
- Na Copart, `Venda Futura` após um leilão já conhecido representa `not_sold`; `Venda Futura` sem histórico continua sendo leilão futuro
- Quando um lote Copart some de uma coleta completa, ele é marcado como `auctionStatus = "finished"` em vez de ser removido imediatamente

---

## Favoritos

- Criados automaticamente ao enviar via WhatsApp — nunca criar manualmente
- Não têm TTL — permanecem para sempre
- Um veículo pode gerar apenas 1 favorito (constraint por `vehicleId`)
- `priceAtSend`, `fipeAtSend` e `fipePercent` são histórico do momento do envio e não mudam após scraping
- A tela de Favoritos pode exibir preço/FIPE atuais buscando o `VehicleRecord` por `vehicleId`
- `soldFipePercent` é calculado no PATCH quando `soldPrice` e `soldFipe` forem fornecidos
- Se o envio partir de um `VehicleRecord` já `saleStatus = "sold"`, o favorito nasce com `soldPrice`, `soldFipe` e `soldFipePercent` preenchidos

---

## Copart ao vivo

## Reconsulta de condicionais Copart

- O serviço cloud executa a verificação às 09:00 de segunda e quinta-feira, no fuso `America/Sao_Paulo`.
- Entram na fila somente condicionais Copart com pelo menos seis dias desde `auctionDate` (ou `conditionalOriginalAuctionDate`) e substatus pendente/legado.
- A página individual do lote é consultada com o perfil persistente do Playwright já utilizado pelo bot.
- `Venda Finalizada`, `Leilão Finalizado` ou o bloco `Resultado da condicional: Finalizado/Finalizada`, sem uma nova data de leilão, é registrado como `conditionalStatus = approved`.
- Nova data posterior à data condicional, combinada com ação de lance (`Dar Lance Agora`/equivalente), é registrada como `conditionalStatus = refused`; `auctionDate` passa a ser a nova data.
- Ausência de evidência suficiente mantém o lote pendente para a próxima janela. Bloqueio da Copart não altera dados.
- A consulta é limitada a 100 lotes por execução e não cria uma nova oportunidade; atualiza o mesmo registro compartilhado com o Picareta.
- Cada lote consultado gera uma tentativa em `copart_conditional_attempts`, com execução automática/manual, início, fim, duração, resultado e erro quando houver.
- O Picareta lista as tentativas paginadas, atualiza execuções em andamento e permite disparar uma nova tentativa geral ou por lote através do endpoint cloud autenticado.
- O botão manual força a consulta do lote pendente mesmo antes da janela normal de seis dias; a execução continua assíncrona no serviço cloud.

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
  - descrição, versão, ano/modelo, marca, modelo, tipo de monta e pátio
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
- O card do veículo pode consultar sugestões por marca/modelo/ano e aplicar uma FIPE escolhida manualmente
- Aplicar uma sugestão atualiza `VehicleRecord.fipe`, código, referência, combustível, match e `fipeCheckedAt`
- A troca manual de FIPE não altera `FavoriteRecord.priceAtSend`, `fipeAtSend` nem `fipePercent`, que são históricos do envio

---

## Taxas Estimadas de Compra

O card do veículo e a mensagem de WhatsApp exibem uma estimativa de `Valor + taxas` quando a fonte tem regra cadastrada.

Fontes com taxa fixa:
- `vs-veiculos`
- `ph-batidos`

Regra: `valor final = preço + R$ 800`.

Fontes com cálculo de leilão:
- `sodre`
- `copart`
- `favareto`
- `claudio-kuss`
- `vardana`
- `vipleiloes`

Regra:

```
valor final = lance + comissão do leiloeiro + DSAL estimada + taxas operacionais
```

- Comissão do leiloeiro: `5%` do lance.
- Taxas fixas operacionais: ATPV/documento `R$ 150`, carregamento `R$ 100`, boleto `R$ 10`.
- Logística estimada: moto `R$ 250`, carro passeio `R$ 500`, caminhonete/SUV `R$ 800`, caminhão `R$ 1.500`.
- DSAL estimada por faixa do lance:
  - até `R$ 4.999`: `R$ 600`
  - `R$ 5.000` a `R$ 9.999`: `R$ 900`
  - `R$ 10.000` a `R$ 19.999`: `R$ 1.400`
  - `R$ 20.000` a `R$ 29.999`: `R$ 1.900`
  - `R$ 30.000` a `R$ 49.999`: `R$ 2.900`
  - `R$ 50.000` a `R$ 74.999`: `R$ 3.500`
  - a partir de `R$ 75.000`: `R$ 4.500`

A classificação logística é inferida pelos textos do veículo. Quando não houver sinal claro de moto, SUV/picape/caminhonete ou caminhão, usar `carro_passeio`.

## Análise de lance máximo

Na lista de veículos, o indicador `Análise IA` é uma estimativa estatística baseada nos lotes `sold` capturados pela extensão e já registrados no painel. Ele não chama um modelo externo.

Critérios de amostra, nesta ordem:

1. mesmo modelo, leiloeiro e tipo de monta, com pelo menos 3 vendidos;
2. mesmo modelo no leiloeiro ou no mercado, com pelo menos 3 vendidos;
3. leiloeiro + tipo de monta ou leiloeiro, com pelo menos 10 vendidos;
4. tipo de monta no mercado, com pelo menos 10 vendidos;
5. mercado geral, com pelo menos 30 vendidos.

A média de venda e a média condicional são calculadas em `% da FIPE` usando `soldPrice ?? price` (ou `price` quando não há `soldPrice`). O total recomendado usa a média de venda: `FIPE atual × média de venda`; quando houver regra de taxas para a fonte, o indicador desconta comissão, DSAL, logística e taxas operacionais para exibir o `lance até`. Sem amostra mínima de vendidos, o indicador não é exibido.

Na extensão de leilão ao vivo, o lote atual é cruzado com `scraped_vehicles` por URL, código,
lote e identidade do veículo. O painel reutiliza a FIPE do registro encontrado e aplica a mesma
análise de lance máximo usada nos cards. Uma FIPE escolhida ou digitada manualmente atualiza o
registro correspondente; sem correspondência, vale para o lote atual e segue no evento de
ingestão final.

---

## WhatsApp / Envio

- Envio sempre 1 veículo por vez — sem envio em lote
- Veículo finalizado enviado pelo WhatsApp deve deixar o desfecho claro: `sold`, `conditional` ou `not_sold`
- Resultado final inclui valor de arremate e `% FIPE` quando disponíveis
- Mensagens incluem `Análise IA` com lance máximo, total com taxas, média histórica da FIPE e tamanho da amostra quando houver histórico suficiente
- Mensagens de leilão finalizado usam linhas curtas: desfecho/fonte, veículo, FIPE, condição, arremate, taxas, total, data e link separado
- Mensagens incluem monta e sinais relevantes encontrados nos textos do veículo, como financiamento e enchente/alagamento
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
