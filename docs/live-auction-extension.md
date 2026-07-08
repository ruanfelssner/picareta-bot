# Extensao de leilao ao vivo

Este documento descreve como a extensao Chrome atual funciona e como evoluir o coletor multi-site. O painel, observadores, decisao manual e endpoint de ingestao sao compartilhados; cada leiloeiro deve ter um adapter de leitura.

## Estado atual

A extensao atual fica em `.extension/copart-live-collector`.

Ela e uma extensao Manifest V3 composta por:

- `manifest.json`: registra o content script em paginas Copart, VIP Leiloes, exemplos locais `file://` e iframes.
- `content.js`: injeta o painel na pagina, extrai o lote visivel, observa mudancas e decide se deve salvar.
- `background.js`: recebe mensagens do content script e faz o `POST` para o backend local.
- `content.css`: estilos do painel flutuante.
- `README.md`: instalacao manual no Chrome.

O nome da pasta ainda fala em Copart por historico, mas o painel atual ja usa `Live Auction Collector`.

## Fluxo atual

1. O usuario roda o app Nuxt local em `http://localhost:3000`.
2. O usuario abre uma pagina suportada: Copart, VIP Leiloes ou fixture local.
3. O content script injeta o painel `Live Auction Collector`.
4. O botao `Atualizar` executa uma leitura unica da pagina.
5. O botao `Ativar` instala `MutationObserver` nos blocos relevantes, persiste o estado ativo por fonte e usa fallback de leitura periodica: 15 segundos na Copart e 2,5 segundos na VIP.
6. A cada mudanca, a extensao monta um evento de preview com lote, veiculo, lance, FIPE, status, imagem e URL.
7. A decisao automatica classifica se o lote pode ser salvo.
8. O usuario pode sobrescrever a decisao com o botao grande de salvar/ignorar.
9. Quando o lote tem resultado final, a extensao envia o evento para `POST /api/vehicles/ingest`.
10. O backend normaliza o evento para `VehicleRecord` e faz upsert em `scraped_vehicles`.

Enquanto o leilao esta aberto, a extensao apenas atualiza o preview. Ela so tenta salvar quando `saleStatus` vira um resultado final.
Se a pagina recarregar ou a aba voltar do segundo plano, a extensao restaura o modo ativo e reinstala observadores quando o usuario deixou `Ativar` ligado.

## Leitura da pagina

O content script le a pagina de tres formas, nessa ordem de utilidade:

- DOM visivel: containers de detalhe do veiculo, lance e chat.
- Shadow DOM: componentes web usados pela sala ao vivo.
- HTML/texto bruto: fallback quando os seletores mudam ou o conteudo esta encapsulado.

Na Copart, a sala pode estar dentro de iframe. Por isso a extensao roda com `all_frames: true` e usa uma ponte por `postMessage`:

- frame filho recebe `LIVE_AUCTION_PREVIEW_REQUEST`;
- frame filho responde `LIVE_AUCTION_PREVIEW_RESPONSE`;
- frame principal escolhe o melhor evento pelo score de campos preenchidos.

O debug do painel mostra quantos documentos/iframes foram lidos, tamanho do texto, contagem de blocos de detalhe/lance/chat, shadow roots e logs de envio.

## Campos extraidos hoje

O evento atual contem:

| Campo | Origem esperada |
|---|---|
| `auctionId` | URL ou campo `Leilao / Lote` |
| `lot` | campo do detalhe ou mensagens do chat |
| `code` | codigo do lote no leiloeiro |
| `description` | descricao/titulo do veiculo |
| `version` | versao do veiculo |
| `yearModel` | fabricacao/modelo |
| `brand` | marca |
| `model` | modelo |
| `category` | categoria do veiculo |
| `fipe`, `fipeRaw` | FIPE visivel |
| `damage` | tipo de monta |
| `condition` | condicao do veiculo |
| `yard` | patio |
| `bid`, `bidRaw` | lance/oferta atual ou final |
| `saleStatus` | `sold`, `conditional`, `not_sold`, `open` ou `null` |
| `imageUrl` | melhor imagem encontrada no DOM |
| `vehicleUrl` | URL do lote |
| `message` | status visivel ou mensagem de sistema |
| `observedAt` | horario local da coleta |

No backend atual, o evento e convertido para `VehicleRecord` usando `source: "copart"` ou `source: "vipleiloes"`.
Para VIP Leiloes, o backend persiste apenas a UF em `yard`, `location` e `state`; endereco completo de rua nao deve ser salvo.

## Decisao de salvar

A extensao separa bloqueios fortes e fracos.

Bloqueios fortes:

- resultado ainda nao finalizado;
- sem codigo/link do lote;
- sem marca/modelo.

Bloqueios fracos:

- sem categoria;
- categoria fora da lista permitida;
- patio fora do PR ou sem estado detectado;
- grande monta, sucata, perda total ou irrecuperavel.

Modo automatico:

- aguarda resultado final sem salvar lances parciais;
- salva apenas patios do PR;
- salva somente se passar nos bloqueios fortes e fracos;
- ignora quando a regra de categoria/monta descarta o lote.

Modo manual:

- `skip`: nunca salva aquele lote;
- `save`: salva quando os bloqueios fortes forem resolvidos, ignorando bloqueios fracos;
- `auto`: volta para a regra automatica.

## Ingestao atual

Endpoint usado:

```
POST /api/vehicles/ingest
```

O endpoint:

- aceita um evento unico ou `{ events: [...] }`;
- limita lote a 25 eventos por request;
- valida token opcional `LIVE_AUCTION_EXTENSION_TOKEN` via header `x-live-auction-extension-token`;
- aceita `COPART_EXTENSION_TOKEN` e `x-copart-extension-token` como fallback de compatibilidade;
- normaliza valores monetarios e datas;
- exige resultado final: `sold`, `conditional` ou `not_sold`;
- exige marca, modelo e URL/codigo;
- aceita `source: "copart"` ou `source: "vipleiloes"`;
- salva automaticamente apenas registros com `state: "PR"`;
- para VIP Leiloes, grava apenas a UF e descarta endereco completo do patio;
- usa `externalId = sha1(source + url)`;
- faz upsert em `scraped_vehicles`;
- preserva campos imutaveis no insert: `source`, `scrapedAt`, `expiresAt`;
- registra logs `[live-auction-ingest] recebido`, `ignorado` e `salvo`.

O endpoint antigo `POST /api/copart-live/events` grava eventos brutos em `copart_live_auction_events` e nao alimenta o painel principal.

## Limitacoes atuais

Pontos que ainda devem ser melhorados:

- A pasta ainda se chama `.extension/copart-live-collector`.
- Os adapters ainda estao dentro de `content.js`; o alvo e extrair para arquivos separados.
- A Copart ainda tem regra propria de categorias permitidas.
- A VIP ainda precisa ser testada na pagina real ao vivo, porque o acesso HTTP direto retorna Cloudflare.
- Novas fontes ainda precisam de normalizador explicito no backend quando tiverem regras proprias.

Essas limitacoes nao impedem a coleta atual de Copart/VIP, mas ainda deixam a manutencao mais dificil se muitos sites forem adicionados.

## Arquitetura alvo multi-site

A evolucao deve separar motor, UI e adapters por leiloeiro.

Estrutura sugerida para a extensao:

```text
.extension/live-auction-collector/
  manifest.json
  background.js
  content-core.js
  content.css
  adapters/
    copart.js
    vipleiloes.js
  shared/
    dom.js
    money.js
    decision.js
```

O motor compartilhado fica responsavel por:

- injetar e atualizar o painel;
- ativar/desativar observadores;
- ler iframes e shadow DOM;
- manter decisoes manuais por lote;
- calcular assinatura do preview e do envio;
- fazer logs e debug;
- enviar evento para o background.

Cada adapter fica responsavel por:

- dizer se suporta a URL atual;
- definir seletores relevantes;
- extrair campos da pagina;
- inferir status de venda;
- montar URL canonica do lote;
- definir regras fracas especificas de categoria, quando existirem.

Interface conceitual:

```typescript
interface LiveAuctionAdapter {
  id: string
  source: VehicleSource
  label: string
  matches(url: URL): boolean
  getObserverSelectors(): string[]
  extract(context: LiveAuctionContext): LiveAuctionEvent
  getSoftBlockReason(event: LiveAuctionEvent): string | null
}
```

O backend tambem deve ficar source-aware:

- renomear o contrato interno de `CopartExtensionEvent` para algo generico, como `LiveAuctionIngestEvent`;
- aceitar `source` real do enum `VehicleSource`;
- manter compatibilidade com Copart durante a migracao;
- trocar `COPART_EXTENSION_TOKEN` por um token generico, aceitando o antigo como fallback;
- mover regras especificas para normalizadores por fonte;
- gerar `externalId = sha1(source + url)`;
- permitir que fontes sem categoria confiavel sejam validadas por outro criterio, sem quebrar a Copart.

## Plano de migracao

1. [x] Documentar o estado atual da extensao e do endpoint.
2. [x] Criar um contrato canonico de evento ao vivo independente da Copart.
3. [x] Refatorar `content.js` para selecionar adapter Copart ou VIP, mantendo o motor compartilhado.
4. [x] Refatorar `POST /api/vehicles/ingest` para aceitar fonte generica.
5. [x] Atualizar `manifest.json` com permissoes para VIP Leiloes.
6. [x] Criar fixture HTML da VIP em `.extension/copart-live-collector/vip/`.
7. [x] Implementar adapter inicial VIP Leiloes.
8. [ ] Testar o adapter VIP na pagina real ao vivo e ajustar textos finais.
9. [ ] Extrair adapters para arquivos separados.
10. [ ] Comparar registros salvos no painel com o scraper server-side existente de `vipleiloes`.
11. [ ] Renomear pasta/prefixos restantes se a extensao multi-site estabilizar.

## Proximo alvo: VIP Leiloes

URL alvo inicial:

```
https://www.vipleiloes.com.br/eventoonline/070726bssc
```

Investigacao inicial em terminal retornou Cloudflare `403`/redirects. Portanto, para VIP Leiloes o caminho e a extensao rodando na pagina aberta no Chrome do usuario, nao scraping HTTP direto por `curl`.

Adapter inicial implementado:

- `source: "vipleiloes"`.
- URLs suportadas: `https://*.vipleiloes.com.br/eventoonline/*`.
- Fixtures locais suportadas: `.extension/copart-live-collector/vip/`.
- Lote e leilao: campos `evo-hidden-*` e breadcrumb.
- Titulo, ano e marca: `data-bind-carrossel-*`.
- Detalhes: tabela `#evo-detalhesanuncio-tabela`.
- Lance: `#evo-oferta-valoratual`.
- Situacao: `#evo-transmissao-anunciosituacao`.
- Historico: `#evo-transmissao-anunciohistorico`.
- Imagem: `#evo-carrossel-itens`.
- Resultado final:
  - `Vendido` -> `sold`
  - `Repasse` -> `not_sold`
  - `Condicional` -> `conditional`
  - `Em Pregão` e `Dou-lhe duas` -> `open`, sem salvar
- Categoria: `Automóveis` por padrao, porque a pagina ao vivo da VIP nao expoe categoria estruturada.
- Monta: `Sem monta` por padrao quando a pagina nao trouxer tipo de monta.
- FIPE: fica `null`, porque a pagina ao vivo da VIP nao exibe FIPE.
- Data do card: usa `observedAt` como `auctionDate` na ingestao.

Primeiros passos tecnicos para VIP:

1. Abrir a URL no Chrome, ativar debug e capturar:
   - texto do lote atual;
   - seletor ou texto do numero do lote;
   - titulo/descricao do veiculo;
   - marca, modelo e ano, se vierem separados;
   - lance atual/final;
   - status final;
   - imagem principal;
   - URL canonica do lote;
   - patio/localizacao;
   - tipo de monta ou observacoes equivalentes.
2. Confirmar ou ajustar textos VIP para `saleStatus`:
   - vendido/arrematado/lance vencedor -> `sold`;
   - condicional, se existir -> `conditional`;
   - nao vendido/sem lance/retirado, se existir -> `not_sold`;
   - em andamento -> `unknown` ou `open` no preview, sem salvar.
3. Salvar novos exemplos HTML reais da VIP para regressao do adapter sempre que aparecer um status final diferente.

O ponto critico da VIP e descobrir se os dados estao no DOM renderizado, em shadow DOM, em iframe ou em chamadas internas de API/WebSocket. A extensao deve priorizar DOM visivel primeiro, porque e o que o operador confere na tela.

## Checklist antes de implementar VIP

- [x] Backend aceita `source: "vipleiloes"` vindo da extensao.
- [x] Ingestao nao monta URL Copart quando `source` nao e Copart.
- [x] Regras de categoria sao por fonte.
- [x] Logs mostram `source`, leilao, lote, status, preco, marca/modelo e motivo de descarte.
- [x] Painel usa nome generico, por exemplo `Live Auction Collector`.
- [x] Manifest inclui VIP Leiloes.
- [ ] Adapter Copart continua funcionando apos a refatoracao em teste real.
- [x] Existe fixture ou pagina salva da VIP para testar sem depender de leilao ao vivo.
