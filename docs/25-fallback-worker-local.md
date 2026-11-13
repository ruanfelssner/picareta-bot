# Saída auxiliar: fontes bloqueadas no Docker coletadas pelo worker local

Bot **0.50.0**. Implementa a saída 1 de [19-scrapers-bloqueios-nov-2026.md](19-scrapers-bloqueios-nov-2026.md): o Docker (Railway) continua sendo o caminho principal e, quando uma fonte falha lá, a mesma coleta é repetida no `pnpm worker` da máquina Windows, que usa a rede residencial e abre o navegador local (`HEADLESS=false`).

## Fluxo

1. Picareta cria o run (`POST /internal/scraping/runs`) como antes.
2. `cloud-service.ts` executa as fontes. Se uma fonte termina em erro (exceto falha de ingestão no Picareta), procura worker com heartbeat em `marketplace_worker_heartbeats` nos últimos 2 min.
   - Sem worker online: a fonte fica com a falha do Docker e o log registra `sem saída auxiliar`.
   - Com worker: cria um job em `scraping_local_fallback_jobs` e a fonte volta para `searching` com a mensagem "repassado ao worker local".
3. O worker, no loop principal (depois das buscas da tela `/marketplace` e antes dos comandos WhatsApp), assume o job, roda `runAuctionSearch` só daquela fonte, com Z-API desligada, e toca o job a cada 15 s com a última linha de log.
4. Ao terminar, o worker grava os veículos em blocos de 100 em `scraping_local_fallback_chunks` e fecha o job (`completed` ou `failed` com parciais).
5. O cloud lê os blocos e ingere pelo mesmo `ingestVehicles`, na mesma fila de ingestão do run. Coleta completa fecha o snapshot e entra na análise de oportunidades/WhatsApp. Parcial é salva sem fechar snapshot. Depois da ingestão os blocos são apagados (TTL de 7 dias cobre sobras).

O worker não fala com o Picareta: não precisa de `PICARETA_INGEST_URL/KEY` nem de nova env var. Picareta não muda — os status reportados são os mesmos (`searching`, `saving`, `completed`, `failed`).

## Limites (fixos no código)

| Situação | Ação |
| --- | --- |
| Job na fila e worker sem heartbeat por 2 min | Abandona: "worker local ficou offline antes de assumir a coleta" |
| Job na fila por mais de 2 h (fila longa com várias fontes) | Abandona |
| Job em execução sem toque por 3 min | Abandona: "worker local parou de responder" |
| Job em execução por mais de 75 min | Abandona |
| Worker reinicia com job `running` | Marcado como falha na subida |

Abandono só vale se o job ainda estiver `queued`/`running`; se o worker concluir no mesmo instante, o resultado dele vence. Resultado entregue depois do abandono é descartado pelo worker.

Enquanto houver fonte aguardando, o run fica `running` (e o serviço responde 409 para novo run). Fonte que falha nos dois lados mostra `Docker: <erro> | Worker local: <erro>`.

## Operação

- Manter `pnpm worker` aberto na máquina Windows (ou `scripts/windows/install-worker-startup.cmd`), com o mesmo Mongo de dados do serviço.
- Pestana continua exigindo navegador real; com `HEADLESS=false` o Chromium abre na máquina e é o melhor cenário para o Radware. CAPTCHA não é resolvido automaticamente.
- O worker processa um job por vez; com várias fontes bloqueadas, o run espera a fila inteira.

## Validação

```sh
pnpm exec tsx --test tests/local-scraping-fallback.test.ts tests/cloud-source-persistence.test.ts
```

Os testes cobrem worker offline, conclusão com progresso, falha nos dois caminhos com parciais, worker caindo antes/durante a coleta e corrida entre abandono e conclusão. Teste real: publicar o bot, conferir `GET /health` com `version: "0.50.0"`, deixar `pnpm worker` rodando e iniciar em `/scraping-cloud` (ou no Picareta) só VIP ou Favareto.

## Primeira execução real: VIP (13/11/2026, 0.50.1)

O fallback funcionou: o Docker falhou no desafio do Cloudflare e o worker local assumiu. Na rede residencial **não houve desafio** na 1ª tentativa, mas a coleta falhou por motivos do próprio scraper:

1. **Limite fixo de 40 páginas.** PR reportou 529 lotes (~12 por página) e parou em 472/529 com "Paginação incompleta". Agora o limite por escopo é `max(configurado, ceil(total/8) + 2)`, até 160 páginas.
2. **Parciais descartadas.** O scraper lançava `Error` comum e os 472 lotes se perdiam. Agora qualquer falha depois de ler lotes vira `PartialScraperResultError`, que o retry preserva e o cloud salva sem fechar o snapshot.
3. **Rajada de 429 → desafio.** Quase toda página recebia 429 com 1,5 s de intervalo, e a 2ª tentativa, iniciada 3 s depois, caiu no desafio do Cloudflare. Agora cada 429 multiplica o intervalo por 1,5 (até 6 s) e a nova tentativa espera 60 s.
4. **Desafio com janela aberta.** Com `HEADLESS=false`, a espera pelo desafio sobe de 30 s para 3 min e o log pede para concluir a verificação na janela. Nada é resolvido automaticamente.

Tempo por tentativa da VIP: 25 min. Teto do job local: 75 min.
