# Servidor MCP para o ChatGPT (0.51.0)

Permite mandar no ChatGPT uma foto ou descrição de peça automotiva e deixar que ele consulte o bot:
Facebook Marketplace, leilões monitorados, Mercado Livre e web. **Somente consultas**: nenhuma
ferramenta publica anúncios, envia WhatsApp ou fala com vendedores.

- Endpoint: `https://picareta-bot.felss.dev/mcp` (Streamable HTTP, sem sessão, respostas JSON)
- SDK: `@modelcontextprotocol/sdk` (oficial, TypeScript) + `zod` para validação
- Autenticação: OAuth 2.1 com PKCE (ChatGPT) ou `Authorization: Bearer <MCP_ACCESS_KEY>` (demais clientes)

## Arquitetura

```
ChatGPT ──HTTPS──▶ Railway ──▶ start-combined (porta pública)
                                 ├─ /health, /internal/scraping/*  → cloud-service (inalterado)
                                 └─ todo o resto                  → Nuxt/Nitro
                                       ├─ /mcp                         server/routes/mcp.ts
                                       ├─ /oauth/{register,authorize,token}
                                       └─ /.well-known/oauth-*         (nuxt.config.ts → serverHandlers)

/mcp ─┬─ search_marketplace ─▶ fila Mongo marketplace_web_searches ─▶ pnpm worker (PC com perfil do Facebook)
      ├─ search_auctions    ─▶ GET /api/vehicles (chamada interna; mesma consulta da tela)
      ├─ search_mercadolivre ─▶ API oficial do Mercado Livre (token no backend)
      ├─ search_web          ─▶ Brave Search API (chave no backend)
      └─ search_parts        ─▶ Mercado Livre + web na hora, Marketplace em segundo plano
```

Nada mudou no Dockerfile, no proxy combinado nem no cloud-service: o proxy já encaminhava para o Nuxt
toda rota fora de `/health` e `/internal/scraping/*`.

### Reaproveitamento

| Necessidade | Reaproveitado | Mudança |
|---|---|---|
| Busca no Marketplace | Fila `marketplace_web_searches` + `runWebSearchJob` do worker (mesmo fluxo da tela `/marketplace`, Z-API desligada) | Job ganhou `origin: 'mcp'` e `options` (local, raio, preço, condição). `searchConfigOverride` em `executeSearchRun`; `radius` na URL |
| Job ID assíncrono | `_id` do documento da fila, `getWebSearchDelta`, heartbeat do worker | Nenhuma |
| Leilões | `GET /api/vehicles` (filtros, deduplicação, ciclo de vida) | Nenhuma |
| Tela `/marketplace` | — | Ignora buscas `origin: 'mcp'` em "busca atual" e no bloqueio de busca única |

Arquivos novos ficam em `server/mcp/` (lógica), `server/routes/mcp.ts` e `server/routes/oauth/*`.
`shared/utils/marketplace-search-options.ts` é o contrato das opções entre Nuxt e worker.

## Ferramentas

Todas têm `readOnlyHint: true`. Entradas validadas com zod (limites abaixo); erro de validação ou da
origem volta como resultado `isError` com mensagem em português, sem detalhes internos.

| Ferramenta | Para quê | Parâmetros principais |
|---|---|---|
| `search_parts` | Ponto de entrada recomendado: consulta Mercado Livre e web e inicia o Marketplace | `query` (2–80), `sources` (`marketplace`, `mercadolivre`, `web`), filtros do Marketplace, `max_results_per_source` (1–20, padrão 8) |
| `search_marketplace` | Anúncios no Facebook Marketplace | `query` (2–80), `location`, `radius_km` (1–500), `min_price`, `max_price`, `condition` (`qualquer`/`novo`/`usado`), `max_results` (1–50), `wait_seconds` (0–25, padrão 20) |
| `get_search_job` | Status e resultados de busca assíncrona | `job_id` (24 hex), `max_results` |
| `search_auctions` | Veículos nos leilões monitorados (última coleta) | `query`, preço, ano, `states` (UF), `sources` (IDs ativos), `period` (`all`, `upcoming`, `today`, `tomorrow`, `past`), `max_fipe_percent`, `apply_user_filters`, `sort`, `max_results` |
| `search_mercadolivre` | Peças no Mercado Livre Brasil | `query` (2–120), `condition`, preço, `max_results` (1–50) |
| `search_web` | Peças em lojas de autopeças e na web | `query` (2–150), `focus` (`lojas`/`geral`), `max_results` (1–20) |

### Resultado padronizado

Cada item de `results` segue o mesmo formato (`server/mcp/listing.ts`):

```json
{
  "title": "Farol Gol G5 esquerdo cód. 5U0941007",
  "price": 450,
  "priceText": "R$ 450",
  "currency": "BRL",
  "location": "Curitiba, PR",
  "condition": "usado",
  "conditionDetail": null,
  "oemCode": "5U0941007",
  "imageUrl": "https://...",
  "url": "https://www.facebook.com/marketplace/item/...",
  "platform": "facebook-marketplace",
  "platformName": "Facebook Marketplace"
}
```

- `condition`: `novo`, `usado`, `recondicionado`, `sinistrado` ou `null` quando a fonte não informa.
  No Marketplace o card não traz condição: só é preenchida quando a busca filtrou por condição.
- `oemCode`: atributo de part number do Mercado Livre ou código citado com rótulo explícito
  (`cód.`, `código`, `OEM`, `ref.`, `part number`, `PN`). Nunca é inventado.
- `search_auctions` acrescenta `vehicle` (marca, modelo, ano, km, combustível) e `auction` (data, lote,
  status, FIPE e `fipePercent`). Em leilão, `conditionDetail` traz a avaria/monta.

### Fluxo assíncrono do Marketplace

1. `search_marketplace` (ou `search_parts`) confere o heartbeat do worker. Offline → erro imediato, nada é enfileirado.
2. Cria o job na fila (no máximo 3 jobs do MCP ativos) e espera até `wait_seconds` (`search_parts` não espera).
3. Se `done=false`, o ChatGPT recebe `jobId` e `nextStep` e chama `get_search_job` a cada 20–30 s.
4. Antes do fim, `results` traz as prévias já aprovadas; ao concluir, a lista final (`resultsAreFinal: true`).
5. `stale: true` indica worker travado (sem atualização há 5 min).

A busca do worker costuma levar de 1 a 4 minutos (scroll + detalhe de até 20 anúncios). Buscas do MCP
entram na mesma fila da tela e da fila do WhatsApp, executadas uma por vez.

### Timeouts e limites (fixos no código)

| Item | Valor |
|---|---|
| Execução de uma ferramenta | 45 s |
| Cada fonte dentro de `search_parts` | 15 s |
| Mercado Livre / Brave por requisição | 12 s |
| `/api/vehicles` interno | 20 s |
| Chamadas ao `/mcp` | 60/min por tipo de credencial + IP |
| Chave errada na tela de autorização | 5 tentativas / 15 min por IP |
| Registro de cliente e token | 30/min por IP |

Logs: `[mcp] <ref> <ferramenta> ok|erro <ms>`, `[mcp:oauth] ...`, `[mcp:marketplace]`, `[mcp:mercadolivre]`,
`[mcp:web]`. Chaves e tokens nunca são registrados; a `ref` aparece na mensagem de erro genérica para
localizar o log.

## Configuração

Variáveis no serviço do Railway (e no `.env` local). Credenciais ficam só no backend.

| Variável | Obrigatória | Uso |
|---|---|---|
| `MCP_ACCESS_KEY` | Sim | Ativa o `/mcp`. Mínimo 24 caracteres. É a chave digitada na tela de autorização, o Bearer fixo dos demais clientes e a base da assinatura dos tokens OAuth. Gere com `openssl rand -hex 32` |
| `MERCADOLIVRE_CLIENT_ID` / `MERCADOLIVRE_CLIENT_SECRET` | Para Mercado Livre | App criado em developers.mercadolivre.com.br |
| `MERCADOLIVRE_REFRESH_TOKEN` | Para Mercado Livre | Refresh token inicial (ver abaixo) |
| `BRAVE_SEARCH_API_KEY` | Para busca web | Chave da Brave Search API |

Sem `MCP_ACCESS_KEY`, `/mcp`, `/oauth/*` e `/.well-known/oauth-*` respondem como desativados.
Fontes sem credencial aparecem como `nao_configurado` em `search_parts` e as ferramentas individuais
explicam o que falta.

### Publicação

1. No PC de desenvolvimento: `pnpm install` (o `package.json` ganhou `@modelcontextprotocol/sdk` e `zod`;
   o Dockerfile usa `--frozen-lockfile`, então o `pnpm-lock.yaml` atualizado precisa ir junto no commit).
2. Configurar as variáveis acima no Railway e publicar normalmente.
3. Conferir: `GET https://picareta-bot.felss.dev/.well-known/oauth-protected-resource/mcp` deve devolver JSON
   com `resource` terminando em `/mcp`.
4. **Atualizar também o worker local** (`git pull` + reiniciar `pnpm worker`). Um worker antigo executa a busca,
   mas ignora localização, raio, preço e condição enviados pelo MCP.

### Mercado Livre: obter o refresh token inicial

A busca da API do Mercado Livre exige token OAuth. O access token dura cerca de 6 h e cada renovação
devolve um novo refresh token de uso único; o bot grava o mais recente na coleção `mcp_integration_tokens`
(Mongo de dados), então a variável de ambiente só é lida na primeira vez ou como recuperação.

1. Em developers.mercadolivre.com.br, crie um app com uma redirect URI HTTPS sua (ex.: `https://picareta-bot.felss.dev/`)
   e permissão de leitura.
2. Abra no navegador, logado na conta do ML:
   `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=<CLIENT_ID>&redirect_uri=<REDIRECT_URI>`
3. Copie o `code` da URL de retorno e troque pelo token:

   ```bash
   curl -X POST https://api.mercadolibre.com/oauth/token \
     -H 'content-type: application/x-www-form-urlencoded' \
     -d 'grant_type=authorization_code&client_id=<CLIENT_ID>&client_secret=<SECRET>&code=<CODE>&redirect_uri=<REDIRECT_URI>'
   ```

4. Salve o `refresh_token` da resposta em `MERCADOLIVRE_REFRESH_TOKEN`.

Se o ML recusar a renovação (token revogado ou não usado por 6 meses), a ferramenta pede um novo refresh
token; repita os passos e atualize a variável. A API pode restringir a busca para alguns apps; nesse caso a
ferramenta devolve `HTTP 403` com a orientação correspondente.

### Busca web: por que Brave e não Google

A Custom Search JSON API do Google está fechada para novos clientes desde janeiro de 2026 e será
desligada em 01/01/2027; o Google não oferece outra API self-service de busca na web aberta. A Brave
Search API tem índice próprio, plano self-service e é chamada só pelo backend. `focus: "lojas"` acrescenta
"comprar" ao termo e prioriza lojas conhecidas e resultados com preço. Preço vem do resumo da página e
deve ser confirmado no site.

## Autenticação

### OAuth (ChatGPT)

O ChatGPT aceita OAuth, "sem autenticação" ou misto — não aceita header fixo. Por isso o bot tem um
servidor OAuth 2.1 mínimo e **sem estado** (`server/mcp/oauth-tokens.ts`):

1. O ChatGPT chama `/mcp`, recebe `401` com `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp"`.
2. Lê os metadados (`/.well-known/oauth-authorization-server`) e faz registro dinâmico em `/oauth/register`.
   O `client_id` é a própria metadata assinada (HMAC); redirect só HTTPS (HTTP apenas em localhost).
3. Abre `/oauth/authorize`: tela "Conectar ao Bot-Anúncios" pede a `MCP_ACCESS_KEY`. PKCE S256 obrigatório.
4. `/oauth/token` troca o código (5 min, uso único) por access token (1 h) e refresh token (30 dias).

Tokens são assinados com chave derivada da `MCP_ACCESS_KEY`. **Trocar a `MCP_ACCESS_KEY` revoga todos os
tokens e clientes**; o ChatGPT pedirá nova autorização. Códigos usados ficam em memória (instância única).

### Bearer fixo (outros clientes)

`Authorization: Bearer <MCP_ACCESS_KEY>` funciona em clientes que aceitam header (Claude Desktop/Code,
Cursor, MCP Inspector, Responses API da OpenAI).

```bash
curl -s https://picareta-bot.felss.dev/mcp \
  -H "authorization: Bearer $MCP_ACCESS_KEY" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Teste visual: `npx @modelcontextprotocol/inspector`, transporte "Streamable HTTP", URL do `/mcp` e header
`Authorization` (ou o fluxo OAuth do próprio Inspector).

## Integração com o ChatGPT

Conectores MCP próprios ficam no modo desenvolvedor do ChatGPT (web). A documentação da OpenAI lista os
planos Plus, Pro, Business, Enterprise e Edu; os nomes de menu mudam com frequência, então confira a ajuda
da OpenAI se algo abaixo estiver diferente.

1. ChatGPT web → **Configurações → Apps e conectores → Configurações avançadas** → ativar **Modo desenvolvedor**
   (em contas onde o passo não existe mais, pule).
2. **Criar** conector: nome "Bot-Anúncios", URL `https://picareta-bot.felss.dev/mcp`, autenticação **OAuth**.
   Deixe client ID/secret em branco (registro dinâmico).
3. Na janela que abrir, informe a `MCP_ACCESS_KEY` e clique em **Autorizar**.
4. Em uma conversa, ative o conector (menu **+ → Mais → Bot-Anúncios** ou modo desenvolvedor) e envie, por exemplo:
   - foto da peça + "acha essa peça usada perto de Curitiba até R$ 500";
   - "pesquisa no Marketplace farol gol g5 esquerdo, raio 80 km";
   - "tem Onix 2019 em leilão no PR abaixo de 70% da FIPE?".

O ChatGPT interpreta a foto (peça, lado, carro, código visível) e chama as ferramentas com texto; a imagem
não é enviada ao bot. Relatos indicam que em contas pessoais (Plus/Pro) só ferramentas de leitura são
liberadas — todas as deste servidor são de leitura.

### Opção ChatGPT Sites (plano Plus)

O ChatGPT Sites (beta, disponível para Plus, Pro, Business, Enterprise e Edu) cria e hospeda sites e apps leves
dentro do ChatGPT. Pelo que a OpenAI publica, um Site **não executa código de servidor, não guarda segredos e
não hospeda servidor MCP**; o acesso de um Site a ferramentas conectadas é de leitura, com a conta de quem
visita, e anunciado para workspaces Business/Enterprise. Portanto:

- **O conector continua sendo este `/mcp` no Railway.** Não há como mover o servidor MCP para o Sites sem
  expor as credenciais (Mercado Livre, Brave, chave do MCP) no navegador, o que este projeto proíbe.
- Um Site pode servir como **painel visual** (ex.: formulário de peça e lista de resultados) para uso no Plus,
  desde que chame um backend próprio. Isso exigiria uma API pública com autenticação por usuário (por
  exemplo, "Sign in with ChatGPT"), que não faz parte deste MVP.
- Para conversar com foto no Plus, use o conector do modo desenvolvedor descrito acima.

Revalide essas limitações na central de ajuda da OpenAI antes de investir no Sites: o produto está em beta e
os recursos por plano mudam.

## Segurança e escopo

- Somente leitura: o worker roda as buscas do MCP com Z-API desligada (mesmo caminho da tela `/marketplace`);
  nenhuma ferramenta favorita, envia, arquiva ou altera veículos.
- Credenciais só no backend; tokens do ML ficam no Mongo de dados, nunca nas respostas.
- Login do Facebook continua manual no PC do worker; o MCP não automatiza login, CAPTCHA nem contato com
  vendedores.
- O parâmetro `radius` da URL do Marketplace é aplicado pelo Facebook quando reconhecido; se a cidade
  informada não tiver slug no Facebook, ele pode usar a localização do perfil. Use o ID numérico da cidade
  (visível na URL do Marketplace) quando precisar de precisão.
- Leilões vêm da última coleta (`scraped_vehicles`); o MCP não dispara scraping.

## Validação

```bash
pnpm install                    # atualiza node_modules e pnpm-lock.yaml com o SDK MCP e zod
pnpm test:mcp                   # OAuth, normalização de resultados e opções do Marketplace
npx nuxi typecheck              # tipos do servidor Nitro
pnpm build                      # bundle usado no Docker
```

Validação manual após publicar: `tools/list` via curl, fluxo OAuth pelo ChatGPT, `search_parts` com worker
ligado e desligado, `get_search_job` até `done: true`, e a tela `/marketplace` continuando a iniciar, acompanhar
e cancelar buscas próprias enquanto uma busca do MCP está na fila.
