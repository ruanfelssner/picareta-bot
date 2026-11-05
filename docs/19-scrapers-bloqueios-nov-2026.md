# Falhas de Palácio, Pestana, VIP e Favareto — 0.47.4

## Diagnóstico de 05/11/2026

Execução manual com quatro fontes em erro. Cada site foi consultado a partir de uma rede residencial brasileira (Paraná, AS8167) para separar bloqueio da rede do serviço de mudança no site.

| Fonte | Erro em produção | Resposta da rede residencial | Causa |
| --- | --- | --- | --- |
| Palácio | `HTTP 429` em `coluna_esquerda_m_home.php` | 200; listagem com 311 lotes | Limite de requisições. A coleta faz cerca de 660 consultas (listagem + 2 por lote) a cada 250 ms e não tinha nova tentativa para 429. |
| Pestana | CAPTCHA/anti-bot | HTML **e** APIs JSON (`/api/v2/leilao`, `/search-api/lote/filtrar`) redirecionam para `validate.perfdrive.com` (Radware Captcha Page) | Radware Bot Manager barra qualquer cliente HTTP sem navegador, de qualquer rede. |
| VIP | "Bloqueio anti-bot persistente" | 200 após obter o cookie `__CBCanal`; busca AJAX `/pesquisa?handler=pesquisar` com 1491 resultados | Desafio Cloudflare na rede do serviço. O site também passou a exigir o cookie de canal (`/canal`) e `/Veiculos/Home` responde 404. |
| Favareto | HTTP 403 + desafio não concluído pelo navegador | 200 com editais | Cloudflare recusa a rede do serviço (já registrado em [14](14-scraping-favareto.md)). |

## Correções no código

- **Palácio** (`sources/palacio.ts`, `public-auction-http.ts`): HTTP 429 deixa de abortar. Até 4 esperas (15 s, 30 s, 60 s, 120 s, ou o `Retry-After` do site, se maior) e o ritmo dobra a cada 429, de 400 ms até 1,5 s. 429 persistente continua erro explícito, com parcial preservado. `PublicAuctionHttpError` expõe `status` e `retryAfterMs`, mantendo a mensagem `HTTP <status> em <url>`.
- **Pestana** (`sources/pestana.ts`): HTTP direto primeiro; se o Radware bloquear (inclusive no meio da coleta), repete a coleta dentro de Chromium pelo `browser-transport`. Lotes já entregues ao consumidor não são reemitidos. Falha nos dois caminhos gera erro com os dois diagnósticos.
- **browser-transport**: quando o aquecimento termina em outro domínio (desvio do Radware para a página de CAPTCHA, que responde 200), falha com o host e o título, em vez de prosseguir com uma sessão inválida. Favareto e PH Batidos permanecem no próprio domínio.
- **VIP** (`src/scrapers/vipleiloes.ts`): User-Agent derivado da versão real do Chromium e do SO do processo (antes: "Windows/Chrome 124" fixo num container Linux), fuso `America/Sao_Paulo` e viewport fixa; espera até 30 s pelo desafio Cloudflare sem recarregar a página; fallbacks passam por `/canal?returnUrl=%2Fpesquisa`; mensagem de erro deixa de pedir um "perfil configurado" inexistente nesse caminho.

## O que continua dependendo de infraestrutura

Favareto e VIP funcionam por HTTP simples na rede residencial e falham na rede do serviço: a recusa é da origem, não do parser. As correções acima reduzem sinais de automação, mas **não garantem** a liberação no Railway. Pestana depende de navegador real em qualquer rede; o Chromium headless pode ainda ser desafiado.

Saídas possíveis, não implementadas aqui:

1. Executar essas fontes no worker Windows (rede residencial) e enviar o resultado pela mesma ingestão do Picareta.
2. Proxy de saída brasileiro/residencial para as fontes bloqueadas (HTTP e Playwright).
3. Pedir liberação do IP do serviço às leiloeiras.

## Validação

```bash
pnpm exec tsx --test tests/palacio-scraper.test.ts tests/pestana-scraper.test.ts tests/favareto-scraper.test.ts tests/vipleiloes-protection.test.ts tests/vipleiloes-search.test.ts
```

59 testes passaram localmente (Node 22, dependências existentes, sem instalação). Build não executado. Após publicar, conferir `GET /health` com `version: "0.47.4"` e rodar em `/scraping-cloud` somente Palácio, Pestana e VIP, uma por vez, lendo o erro completo de cada uma.
