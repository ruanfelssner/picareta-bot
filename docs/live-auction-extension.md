# Extensao de leilao ao vivo

Este documento descreve como a extensao Chrome atual funciona e como evoluir o coletor multi-site. O painel, observadores e endpoint de ingestao sao compartilhados; cada leiloeiro deve ter um adapter de leitura.

## Estado atual

A extensao atual fica em `.extension/copart-live-collector`.

Ela e uma extensao Manifest V3 composta por:

- `manifest.json`: registra o content script em paginas Copart, VIP Leiloes, Sodre Santoro, exemplos locais `file://` e iframes.
- `content.js`: injeta o painel na pagina, extrai o lote visivel, observa mudancas e decide se deve salvar.
- `background.js`: recebe mensagens do content script e faz o `POST` para o backend remoto.
- `content.css`: estilos do painel flutuante.
- `README.md`: instalacao manual no Chrome.

O nome da pasta ainda fala em Copart por historico, mas o painel atual usa `Picareta Smart Assistant`.

## Fluxo atual

1. A extensao usa o backend publicado em `https://picareta-bot.felss.dev`.
   Antes das chamadas, o service worker usa a credencial padrao ou uma sobrescrita salva em
   `chrome.storage.local` e adiciona o header de autenticacao. Nao ha configuracao inicial; a tela
   de opcoes serve para testar ou rotacionar a chave.
   No deploy, o inicializador combinado encaminha `/api/vehicles/*` para o Nuxt e preserva
   `/internal/scraping/*` no processo cloud; os dois fluxos compartilham o mesmo dominio.
2. O usuario abre uma pagina suportada: Copart, VIP Leiloes ou fixture local.
3. O content script injeta o painel `Picareta Smart Assistant`.
4. O botao `🔄` executa uma leitura unica da pagina. Em uma página individual Copart (`/lot/...`), ele recaptura os dados e atualiza o lote existente no banco e no histórico do Picareta. O botão `💾` continua salvando o lote atual, inclusive antes do resultado final.
5. O botao `▶` instala `MutationObserver` nos blocos relevantes, persiste o estado ativo por fonte e usa fallback de leitura periodica: 15 segundos na Copart e 2,5 segundos na VIP.
6. A cada mudanca, a extensao monta um evento de preview com lote, veiculo, lance, FIPE, status, imagem e URL.
7. O backend cruza o preview com `scraped_vehicles` e devolve FIPE, taxas e análise histórica.
8. A extensao usa exclusivamente o modo `Banco`.
9. Quando o lote tem resultado final e passa pelas regras, a extensao envia o evento para o banco.
10. O backend normaliza o evento para `VehicleRecord` e faz upsert em `scraped_vehicles`.

Enquanto o leilao esta aberto, a coleta automática apenas atualiza o preview e aguarda o resultado final. O salvamento manual pode persistir um lote ainda aberto; quando o resultado aparecer, a extensão reaproveita a mesma identidade e atualiza o registro existente. O botão `Atualizar exibidos` mantém lotes sem resultado como pendentes e inicia esse acompanhamento enquanto a página do leilão permanecer aberta.
Quando a mensagem final do chat informa um valor diferente do lance ainda exibido no painel, o
valor da mensagem final tem prioridade para o preço salvo e para o `soldPrice`.
Se a pagina recarregar ou a aba voltar do segundo plano, a extensao restaura o estado ativo e reinstala observadores quando o usuario deixou `Ativar` ligado.

Na lista `🗂️` de lotes capturados, cada item informa se foi salvo, ficou pendente ou apresentou falha,
além do motivo. O botão `Dados` abre uma modal com o log do salvamento — decisão manual/automática,
resultado capturado e horário da última ação — antes da tabela completa do JSON. Assim, um lote salvo
sem resultado final fica distinguido de um lote que ainda aguarda confirmação da Copart.
Quando o leilão avança antes da atualização visual, as mensagens finais já exibidas no chat são
reconciliadas com os lotes pendentes pelo número do lote e enviadas ao banco automaticamente.
O filtro da lista permite exibir todos, somente não salvos ou somente salvos. A busca ao lado do
filtro localiza por veículo, lote, código, categoria, pátio ou comitente, e o contador ao lado de
`Exibir` mostra quantos itens permanecem visíveis após os filtros. A posição do scroll é
preservada ao salvar, recapturar ou atualizar os itens, e as ações de dados, salvar, excluir e abrir
o link do veículo são representadas por ícones compactos. O cabeçalho pode ser arrastado para
reposicionar o painel, com a posição persistida por fonte.
O filtro `Mensagem ≠ lance` identifica divergências entre o valor final da mensagem e o lance
armazenado. O botão `Atualizar exibidos` respeita todos os filtros ativos e envia somente os itens
exibidos para atualizar o mesmo registro existente.
O filtro `Salvos manuais` separa os lotes enviados manualmente ou reprocessados pela lista. Uma
recaptura que não encontre uma imagem nova preserva as imagens já armazenadas no Bot e no Picareta.
Na sala ao vivo, quando o lote muda, a primeira leitura fica em quarentena para evitar misturar o
lance ou resultado do lote anterior com o veículo seguinte; o salvamento automático só pode ocorrer
após uma segunda leitura confirmando a mesma identidade do lote.
Na modal de dados, os campos principais podem ser editados e salvos diretamente por `fetch`; quando
o lote está aberto na página atual, `Atualizar novamente` busca os dados sem abrir uma nova guia.
A modal de dados também oferece `Atualizar novamente`: recaptura o lote quando ele está na página
atual ou abre o link em nova aba, executa a recaptura automaticamente e comunica o resultado à
modal original quando o item pertence a outra página.
Na página individual Copart (`/lot/...`), a extensão não atualiza nem sobrescreve o banco ao carregar.
Ela faz somente uma leitura inicial para comparação, sinaliza as mudanças encontradas e deixa o
salvamento para uma ação explícita após a conferência. O botão principal dessa página apenas relê
os dados; a atualização efetiva fica disponível na revisão/modal. A imagem da página individual
usa somente fontes principal/ativa ou o metadata da própria página, sem fallback para imagens
aleatórias do documento. Se a URL recebida já estiver vinculada a outro lote Copart, o Bot rejeita
essa imagem e preserva a existente; a edição administrativa do Picareta também bloqueia essa
duplicação.

## Worker de condicionais

As consultas automáticas de condicionais usam a sessão do navegador do usuário, que já pode estar
autenticada na Copart. O serviço cloud cria documentos em `copart_conditional_jobs`, e o service
worker da extensão busca um job, abre a URL do lote em uma aba em segundo plano e executa a leitura
da página e do endpoint estrutural com os cookies normais daquela sessão.

- cookies, tokens de sessão e dados de autenticação não são enviados nem persistidos no MongoDB;
- o backend recebe somente o resultado normalizado (`approved`, `refused`, `pending`, `removed` ou
  `blocked`) e os dados necessários para atualizar o histórico;
- cada job é atômico, tem navegador responsável, número de tentativas e pode ser retomado se a aba
  desaparecer por mais de dez minutos;
- o progresso da execução fica em `copart_conditional_runs`; cada resultado gera uma entrada em
  `copart_conditional_attempts`, incluindo duração, status e erro;
- Incapsula/Captcha não é contornado automaticamente: a consulta é marcada como erro e pode ser
  reprocessada depois que o usuário resolver o desafio na aba normal da Copart.

Para o worker funcionar, basta manter a extensão carregada no Chrome e uma sessão Copart válida em
uma aba. O Chrome pode abrir e fechar abas de consulta em sequência; não é necessário deixar uma
aba específica de lote aberta.

## Leitura da pagina

O content script le a pagina de tres formas, nessa ordem de utilidade:

- DOM visivel: containers de detalhe do veiculo, lance e chat.
- Shadow DOM: componentes web usados pela sala ao vivo.
- HTML/texto bruto: fallback quando os seletores mudam ou o conteudo esta encapsulado.

Na Copart, a sala pode estar dentro de iframe. Por isso a extensao roda com `all_frames: true` e usa uma ponte por `postMessage`:

- frame filho recebe `LIVE_AUCTION_PREVIEW_REQUEST`;
- frame filho responde `LIVE_AUCTION_PREVIEW_RESPONSE`;
- frame principal escolhe o melhor evento pelo score de campos preenchidos.

Para confirmar o encerramento na Copart, o status visual do lote continua sendo a fonte prioritária.
Como fallback, o parser também lê as mensagens de sistema do `#chatMessageContainer`. Frases como
`Lote 111 vendido por R$ ...` e `Lote 108 não foi vendido` são usadas somente quando o status visual
não informa um resultado final e quando o número da mensagem corresponde ao lote atual.

Em páginas individuais da Copart, o campo `Lote/Vaga` é tratado separadamente: em valores como
`5/LA-06`, `5` vai para `lot` e `LA-06` permanece apenas como vaga interna. O código numérico da
URL (`/lot/1134650`) continua sendo usado como `code` e como identidade do registro.

O painel não possui modo de debug. Eventos operacionais de leitura e envio continuam disponíveis no console do DevTools.

O painel não gera avisos sonoros. O estado do salvamento fica visível no resumo do lote e no
diagnóstico da lista de capturas.

## Assistente do lote

Cada preview com identificação mínima chama:

```text
POST /api/vehicles/live-assistant
```

O backend procura o mesmo veículo em `scraped_vehicles`, priorizando URL e código do lote e usando
lote, marca, modelo e ano como fallback. A resposta inclui o veículo correspondente, FIPE,
percentual do lance, taxas estimadas e a mesma `Análise IA` exibida nos cards.

Não há consulta FIPE manual na extensão. Quando o backend encontra um veículo correspondente,
a FIPE histórica continua sendo usada automaticamente no resumo e na análise do lote.

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
| `consignor` | comitente do lote |
| `bid`, `bidRaw` | lance/oferta atual ou final |
| `saleStatus` | `sold`, `conditional`, `not_sold`, `open` ou `null` |
| `imageUrl` | melhor imagem encontrada no DOM |
| `vehicleUrl` | URL do lote |
| `message` | status visivel ou mensagem de sistema |
| `observedAt` | horario local da coleta |

No backend atual, o evento e convertido para `VehicleRecord` usando `source: "copart"` ou `source: "vipleiloes"`.
Para VIP Leiloes, o backend persiste apenas a UF em `yard`, `location` e `state`; endereco completo de rua nao deve ser salvo.

Os textos de monta sao normalizados na ingestao: `Sem monta`, `Não batido`, `Sem sinistro`, `Usado` e `Seminovo` viram `Sem monta`. `Sinistrado` sem pequena/média monta permanece como texto indeterminado e entra no bucket `Outros`, sem ser comparado com veículos não batidos.

Na análise da extensão, a média de venda e a média condicional são exibidas separadamente em percentual da FIPE e em valor aproximado. A média condicional é informativa e não altera o lance máximo recomendado, que continua baseado nas vendas efetivadas.

## Decisao de salvar

A extensao separa bloqueios fortes e fracos.

Bloqueios fortes (nunca configuraveis — sempre exigidos):

- resultado ainda nao finalizado;
- sem codigo/link do lote;
- sem marca/modelo.

Bloqueios fracos (configuraveis no painel, botao `⚙️ Config`):

- sem categoria (so Copart);
- categoria fora da lista configurada em "Categorias Copart" — por padrão o campo fica vazio e
  todas as categorias são aceitas;
- quando uma lista personalizada é informada, caminhões e motos podem ser controlados pelos toggles
  "Habilitar caminhões na coleta automática" e "Habilitar motos na coleta automática";
- estado do patio fora da lista configurada em "Estados para salvar automatico";
- sem estado detectado no texto do lote — so bloqueia se "Bloquear lote quando nao detectar
  estado" estiver ligado (ligado por padrao);
- nao ha mais bloqueio automatico por tipo de monta; grande monta, sucata, perda total e irrecuperavel tambem podem ser salvos.

Modo Banco (automatico):

- aguarda resultado final sem salvar lances parciais;
- salva somente se passar nos bloqueios fortes e fracos acima;
- as listas de estados/categorias e o toggle de estado obrigatorio ficam salvos no
  `localStorage` do navegador (`liveAuctionCollector:settings:v2`), entao persistem entre
  sessoes e paginas.
- quando a regra automatica aprova o lote, a extensao envia `manualDecision: "save"` pro
  backend (nao `"auto"`) — isso faz o servidor honrar a configuracao da extensao em vez do
  proprio limite fixo dele (`AUTO_SAVE_ALLOWED_STATES = ['PR']` em `ingest.post.ts`, que so
  vale de verdade pra quem chama o endpoint sem passar por essa decisao, ex.: outro cliente).

O painel não exibe mais ações de decisão manual nem alternância de destino. O salvamento ocorre
somente no banco, seguindo as regras automáticas configuradas. O topo do resumo sinaliza quando
o lote será salvo ao identificar o resultado final.

## Ingestao atual

Endpoint usado:

```
POST /api/vehicles/ingest
```

O endpoint:

- aceita um evento unico ou `{ events: [...] }`;
- limita lote a 25 eventos por request;
- valida token opcional `LIVE_AUCTION_EXTENSION_TOKEN` via header `x-live-auction-extension-token`;
- recebe do service worker a credencial padrao ou a sobrescrita salva em `chrome.storage.local`;
- aceita `COPART_EXTENSION_TOKEN` e `x-copart-extension-token` como fallback de compatibilidade;
- normaliza valores monetarios e datas;
- exige resultado final: `sold`, `conditional` ou `not_sold`;
- exige marca, modelo e URL/codigo;
- aceita `source: "copart"`, `source: "vipleiloes"` ou `source: "sodre"`;
- por padrao (`manualDecision` diferente de `"save"`) so aceita automaticamente `state: "PR"` —
  na pratica isso so importa pra chamadas que nao passam pela decisao da extensao, ja que o
  painel sempre manda `"save"` quando a configuracao dele propria aprova o lote (ver acima);
- para VIP Leiloes e Sodre Santoro, grava apenas a UF e descarta endereco completo do patio;
- usa `externalId = sha1(source + url)`;
- faz upsert em `scraped_vehicles`;
- preserva campos imutaveis no insert: `source`, `scrapedAt`, `expiresAt`;
- registra logs `[live-auction-ingest] recebido`, `ignorado` e `salvo`.

O endpoint antigo `POST /api/copart-live/events` grava eventos brutos em `copart_live_auction_events` e nao alimenta o painel principal.

### Recaptura manual de lote Copart

Em uma página individual `https://www.copart.com.br/lot/{codigo}`, o botão `🔄` usa
`POST /api/vehicles/recapture`. A operação aguarda a renderização tardia dos detalhes e da
imagem principal ativa, sem escolher uma miniatura de outro lote, localiza o lote por URL/código, atualiza somente os campos encontrados na página e
preserva os valores anteriores quando a Copart não renderiza um campo. Quando a página renderiza
uma nova imagem válida, ela substitui a imagem anterior. O `imageUrl` também faz parte da
assinatura de salvamento, então uma imagem que chega depois não é descartada como se nada tivesse
mudado. Na página `/lot`, o lance lido na página tem prioridade; enquanto a Copart ainda não
expõe o valor, o painel usa o último lance capturado para o mesmo lote como fallback temporário.
A operação não cria um novo lote. Depois da atualização, o registro completo é enviado ao
Picareta para corrigir a listagem pública e seus filtros.

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
- registrar eventos operacionais no console;
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

1. Abrir a URL no Chrome e capturar pelo DOM e console:
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

## Adapter Sodre Santoro

Terceiro adapter implementado, na tela "Telao" da Sodre (`https://leilao.sodresantoro.com.br/app/telao/?ref={leilao_id}`).
Fixture salva localmente em `.extension/sodre/` (pagina completa "Salvar como" do Chrome).

Diferente de Copart e VIP, a Sodre renderiza o lote atual direto no DOM via jQuery
(`.html()`), sem iframe e sem Shadow DOM — leitura e so texto/classe, sem ponte de frames.

- `source: "sodre"`.
- URLs suportadas: `https://*.sodresantoro.com.br/app/telao/*`.
- Fixture local: `.extension/sodre/*` (arquivo `file://`).
- Leilao e lote interno: extraidos primeiro da URL da foto atual (`/veiculos/{leilao_id}/{lote_id}/`).
  Os inputs `#leilao_id` e `#lote_id` sao apenas fallback, pois a Sodre pode manter `#lote_id`
  apontando para outro lote durante a navegacao ao vivo.
- Numero do lote e nome: `.act-titulo-lote-atual`, formato `"0169 - FORD KA FLEX 13/13"`.
- Descricao completa: `.act-descricao-lote-atual`, formato `"FORD KA FLEX - 2013/2013 - ..."` —
  usada para extrair marca/modelo/ano (mais confiavel que o titulo curto, que so tem ano com 2 digitos) e o tipo de monta.
- Patio/UF: quando o campo proprio nao existe, a extensao procura a localizacao na descricao
  (`Bem encontra-se: ... /PR`) e usa a UF encontrada para liberar o salvamento automatico.
- Mensagem do operador: `.act-mensagem-lote-atual`.
- Lance atual: `.act-valor-lance-atual`.
- Resultado final: o elemento `.act-status-lote-atual` recebe uma classe CSS exclusiva por status
  (visto no `Telao.js` original do leiloeiro), sem precisar interpretar texto:
  - `vendido` -> `sold`
  - `condicional` -> `conditional`
  - `nao-vendido`, `repasse`, `retirado` -> `not_sold`
  - `aguardando`, `dou-lhe-uma`, `dou-lhe-duas`, `pregao` -> `open`, sem salvar
- Imagem: `.slideshow .item.current a.act-colorbox` (href de alta resolucao; fallback pro `img` do slide).
- Sincronizacao: enquanto o coletor esta ativo, observa `#sincronizar`; se a classe `ativo` cair,
  aciona novamente o controle da propria Sodre, com intervalo minimo entre tentativas.
- URL canonica do lote: `https://leilao.sodresantoro.com.br/leilao/{leilao_id}/lote/{lote_id}/` —
  mesmo formato usado pelo scraper automatico `layers/scrapers/server/utils/sources/sodre.ts`,
  entao a extensao atualiza o mesmo documento que o scraper ja criou, em vez de duplicar.
- Marca/modelo: separados de forma ingenua pelo primeiro token do titulo (`headParts[0]` = marca,
  resto = modelo). Nao trata marcas com mais de uma palavra (ex.: "Alfa Romeo").
- Local do lote: a tela nao expoe um campo de UF estruturado. A extensao tenta achar um endereco
  apos `"Bem encontra-se:"` e um token de 2 letras que bata com uma UF valida em qualquer lugar do
  endereco. Enderecos que mencionam `Guarulhos` sao inferidos como `SP`; quando nao acha nem infere
  uma UF, o lote fica sem estado e so e salvo com decisao manual (`save`).

### Scraper automatico tambem reporta status finalizado

Diferente da Copart, o scraper automatico da Sodre (`sodre.ts`) consulta a API de busca de lotes do
site, que ja inclui `lot_status_id` — ou seja, ele grava `saleStatus` finalizado (`sold`/`conditional`)
com frequencia, nao so `unknown` como a Copart. Isso quebra a heuristica usada em
`GET /api/vehicles/live-history` (ver [`docs/live-history-view.md`](./live-history-view.md)) de isolar
a extensao so por status final. Para Sodre, o filtro `onlyExtension=true` (campo `collectedVia`) e o
unico jeito confiavel de ver so o que a extensao capturou ao vivo.

## Checklist antes de implementar VIP

- [x] Backend aceita `source: "vipleiloes"` vindo da extensao.
- [x] Ingestao nao monta URL Copart quando `source` nao e Copart.
- [x] Regras de categoria sao por fonte.
- [x] Logs mostram `source`, leilao, lote, status, preco, marca/modelo e motivo de descarte.
- [x] Painel usa o nome `Picareta Smart Assistant`.
- [x] Manifest inclui VIP Leiloes.
- [ ] Adapter Copart continua funcionando apos a refatoracao em teste real.
- [x] Existe fixture ou pagina salva da VIP para testar sem depender de leilao ao vivo.

## Lotes capturados e recuperação

A extensão mantém localmente, por fonte, uma caixa de captura dos lotes identificados enquanto o
coletor está ativo. Essa caixa não depende dos filtros de categoria, estado, monta ou da decisão de
salvar em `scraped_vehicles`: todo lote com identificador recuperável entra uma vez e recebe
atualizações posteriores sem substituir dados já preenchidos por valores vazios. Na Copart, a
extensão faz novas leituras após a troca do lote até a ficha terminar de carregar os cinco campos
de classificação/localização; se o código Copart só aparecer depois do lote, a captura é mesclada
pela combinação leilão + lote para evitar uma segunda entrada incompleta.

O botão `🗂️` abre a lista de lotes capturados localmente. A listagem usa linhas compactas para facilitar
a conferência de muitos lotes. Cada item mostra o motivo/status da captura e oferece `Reprocessar`,
que envia o último evento para a base principal e marca o item como salvo. O botão `💾` percorre todos
os itens ainda pendentes, enviando cada lote individualmente, inclusive os que ainda estão sem resultado
final quando o envio é uma decisão manual explícita; ele exibe o progresso e mantém no local apenas os
itens que falharem por erro ou não puderem ser validados. O botão `⬇️` exporta todos os itens locais da fonte atual para
um arquivo JSON, permitindo revisar, corrigir ou reaproveitar os dados mesmo quando o backend estiver
indisponível.
Cada item também possui `Dados`, que abre uma modal com todos os campos do JSON em uma tabela, e
`Excluir`, que remove somente aquele lote da captura local. O botão `🗑️` no cabeçalho limpa todos os
lotes da fonte atual após confirmação.

Como apoio, os lotes efetivamente bloqueados continuam sendo registrados na coleção
`ignored_live_auction_lots`, com uma entrada idempotente por fonte e identificador. Essa coleção não
é a fonte principal da lista local e uma falha de rede nela não apaga os lotes capturados no navegador.

Rotas usadas pela extensão:

- `POST /api/vehicles/ignored-lots` — registra ou atualiza um lote bloqueado como apoio.
- `GET /api/vehicles/ignored-lots?source=copart&status=pending` — lista pendências do apoio remoto.
- `POST /api/vehicles/ignored-lots/:id/resolve` — marca o lote como recuperado após o envio.

Os registros remotos ficam disponíveis por cinco anos. A retenção local segue o armazenamento do
navegador até o usuário limpar os dados da extensão/site ou exportar o JSON.
