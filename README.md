# POC - Extração Básica de Anúncios do Facebook Marketplace

POC em Node.js + TypeScript usando Playwright para:
- abrir o Facebook Marketplace em navegador local,
- manter sessão com perfil persistente,
- permitir login manual na primeira execução,
- buscar um termo,
- scrollar um número limitado de telas,
- extrair informações visíveis dos cards,
- salvar resultados em JSON.
- opcionalmente persistir no MongoDB (Mongoose) e enviar imagens para WhatsApp via Z-API.

## Requisitos

- Node.js 20+
- pnpm

## Instalação

1. Instale dependências:

```bash
pnpm install
```

2. Instale o Chromium do Playwright:

```bash
pnpm exec playwright install chromium
```

3. Copie o arquivo de ambiente:

```bash
cp .env.example .env
```

4. Ajuste os valores no `.env` conforme necessário.

O padrão de busca está fixo no código (não depende de várias env vars):
- Usa URL com `locationId` (sem faixa de preço/tempo forçada por padrão).
- Usa um motor de regras pluggável em `src/rules/`.
- Seleciona regra automaticamente conforme o termo (ex.: `wheels` para buscas de roda/furação).
- Mantém fallback para regra `generic` em outros itens.
- Abre detalhe apenas para anúncios com match inicial mínimo.

Integrações opcionais:
- MongoDB via Mongoose: configure `MONGO_URI` (e opcionalmente `MONGO_DB_NAME`).
- Separação de banco no worker (opcional):
  - fila de comandos: `MONGO_QUEUE_URI` + `MONGO_QUEUE_DB_NAME`
  - dados de anúncios/resultados: `MONGO_DATA_URI` + `MONGO_DATA_DB_NAME`
  - fallback: se não definir os específicos, usa `MONGO_URI` + `MONGO_DB_NAME`.
- Z-API: configure `ZAPI_ENABLED=true` e credenciais (`ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`, `ZAPI_CLIENT_TOKEN`, `ZAPI_PHONE`).
  - Para grupo, use em `ZAPI_PHONE` o `phone` retornado no endpoint de grupos (ex.: `1203...-group`).
  - Regra de envio com Mongo ativo:
    - envia anúncio apenas na primeira vez;
    - reenviará somente quando houver queda de preço detectada;
    - inclui na legenda a data/hora em que o anúncio foi coletado.
  - Envio em fila: os anúncios já começam a ser enviados durante a coleta (não precisa esperar o fim do scraping).
  - Formato de envio:
    - relevância alta: imagem + legenda individual;
    - relevância média/baixa: mensagem única em lista (`Nome - Valor - Link`).
  - Mensagens de status do comando (início/fim) são enviadas pelo próprio worker para o grupo do comando.
  - Heartbeat do worker na fila (para o webhook detectar bot offline):
    - `WORKER_HEARTBEAT_SECONDS` (default `20`)
    - `WORKER_ID` (opcional; default `bot-anuncios@<hostname>`)
- FIPE API (Deivid Fortuna): configure `FIPE_API_ENABLED=true` e (recomendado) `FIPE_API_TOKEN`.
  - Base: `FIPE_API_BASE_URL` (default `https://fipe.parallelum.com.br/api/v2`)
  - Tipo: `FIPE_API_VEHICLE_TYPE` (default `cars`)
  - Referência opcional: `FIPE_API_REFERENCE`
  - O token gratuito em `https://fipe.online` aumenta o limite diário e evita bloqueio por taxa.

## Execução

Rodar e informar o termo no terminal:

```bash
pnpm dev
```

Opcionalmente, pode passar o termo por argumento:

```bash
pnpm dev "escape polo tsi"
```

`pnpm dev` é modo local de análise e **não publica no WhatsApp**.
Publicação via Z-API acontece apenas no `pnpm worker`.

No `pnpm dev`, além do resultado final, o bot salva um snapshot completo da coleta para análise de regra:
- `output/results.json`
- `output/analysis/<timestamp>-<termo>.json`

### Modo Worker (fila de comandos do WhatsApp)

Para processar comandos recebidos pelo `nicho` na collection `marketplace_commands`:

```bash
pnpm worker
```

Comportamento:
- busca comandos `SEARCH` com status `PENDING`;
- marca como `RUNNING`;
- envia mensagem de status "busca iniciada" para o grupo do comando;
- executa Playwright com o termo do comando;
- envia resultados para o grupo do comando (quando Z-API estiver ativa);
- envia mensagem "busca finalizada" ao concluir;
- finaliza como `DONE`, `FAILED` ou `CANCELLED`.

Com isso, no fluxo por WhatsApp você roda apenas o worker.  
`pnpm dev` fica para uso manual/local.

### Serviço cloud do scraping

O servico de producao pode ser iniciado com `pnpm start:cloud` ou `pnpm start:combined`. Ambos
sobem o Nuxt e o scraper atras da mesma porta. Para executar somente o scraper durante diagnosticos,
use `pnpm start:scraper`.

O `Dockerfile` publica os dois processos atras de uma unica porta. O inicializador combinado envia
`/health` e `/internal/scraping/*` para o servico cloud e encaminha as demais rotas, incluindo
`/api/vehicles/*` da extensao Chrome, para o Nuxt.

Variáveis mínimas do serviço:

- `SCRAPER_SERVICE_KEY`: chave recebida do Picareta no header `x-scraper-service-key`.
- `PICARETA_INGEST_URL`: endpoint `/api/v1/scraped-vehicles/ingest` do Picareta.
- `PICARETA_INGEST_KEY`: mesma chave privada configurada em `NUXT_SCRAPED_VEHICLES_INGEST_KEY`.
- `PICARETA_OPPORTUNITY_WEBHOOK_URL`: endpoint de análise e Push das novas oportunidades.
- `HEADLESS=true`.

O servico Nuxt e a extensao incluem uma credencial padrao para as chamadas a `/api/vehicles/*`,
sem configuracao inicial. `LIVE_AUCTION_EXTENSION_TOKEN` fica disponivel como sobrescrita: ao
rotacionar o valor no servidor, informe a mesma chave nas opcoes da extensao e use **Salvar e
testar**.

Em uma hospedagem cloud, o serviço deve ser publicado como serviço persistente HTTP, com `PORT` fornecida pela plataforma. O Admin cria o `runId`, o bot envia progresso por callback e o Picareta persiste o estado em `scraping_runs`.

O Dockerfile usa a mesma versao do Playwright declarada no lockfile, instala o Chromium, gera o
bundle Nuxt e inicia ambos com `pnpm start:combined`. Um comando personalizado antigo usando
`pnpm start:cloud` tambem inicia o modo combinado; somente `pnpm start:scraper` isola o scraper.

### Fontes de Leilão Ativas

- VS Veículos
- Sodré Santoro
- Copart
- Favareto
- Claudio Kuss
- Lucinei Automóveis (Ribeirão Preto/SP)
- Vardana Leilões
- Mega Leilões
- Superbid
- Leilões Judiciais
- VIP Leilões (sinistrados, usados e seminovos)

Configuração opcional específica do Claudio Kuss:
- Descoberta automática via `https://www.claudiokussleiloes.com.br/proximos-leiloes` (lendo links `relacao-foto/<id>` e `relacao-lista/<id>`).
- Também tenta preencher a data do leilão para cada lote coletado.
- `CLAUDIO_KUSS_LEILAO_IDS` (lista CSV de IDs de leilão, ex.: `872,873`)
- `CLAUDIO_KUSS_MAX_AUCTIONS` (limite de leilões descobertos por execução)
- `CLAUDIO_KUSS_MAX_PAGES` (limite de páginas por leilão)
- `LUCINEI_MAX_PAGES` (limite de páginas da listagem da Lucinei; default 20)
- `VARDANA_LEILAO_IDS` (lista CSV opcional; se ausente, descobre pelo índice do site)
- `SCRAPER_SOURCE_TIMEOUT_MS` (timeout por fonte no scraping manual/API; default `300000`)
- `VIPLEILOES_MAX_PAGES` (limite de páginas por classificação da VIP)
- `VIPLEILOES_CLASSIFICATIONS` (ordem CSV das classificações; default `Usados,Seminovos,Sinistrados`)
- `VIPLEILOES_REQUEST_DELAY_MS` (delay entre páginas/requisições da VIP; default `1500`)
- `VIPLEILOES_PROFILE_PATH` (perfil persistente Playwright da VIP; default `data/vipleiloes-profile`)
- `VIPLEILOES_HEADLESS` (override opcional para a VIP; use `false` para validar anti-bot manualmente)

## Primeira execução e login manual

- O script abre `https://www.facebook.com/marketplace` usando perfil persistente em `data/facebook-profile`.
- Se detectar login, checkpoint ou verificação, o terminal mostrará:

`Faça login/verificação manualmente na janela aberta. Depois pressione ENTER no terminal.`

- Faça o login/verificação manual na janela do navegador e pressione `ENTER` no terminal para continuar.

## Saída

- Arquivo final: `output/results.json`
- Resumo para WhatsApp: `output/whatsapp.txt`
- Se Mongo estiver ativo: grava em `listings`, `search_runs`, `run_results`, `zapi_dispatches`.
- Se Z-API estiver ativa: envia imagens (quando houver URL de imagem no card) com legenda para o destino informado.
- Formato:

```json
{
  "searchTerm": "...",
  "collectedAt": "...",
  "total": 0,
  "results": []
}
```

## Observações de segurança e escopo

- Não armazena usuário/senha.
- Não exporta cookies manualmente.
- Não usa API interna do Facebook/GraphQL/endpoints de rede.
- Não envia mensagem para vendedor.
- Não usa proxy, bypass de captcha ou automação de múltiplas contas.
- Coleta apenas dados visíveis em tela.
- Não salva imagem no MongoDB (somente metadados e logs de envio).
