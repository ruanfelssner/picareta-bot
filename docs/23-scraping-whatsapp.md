# Continuidade do scraping e oportunidades WhatsApp

Bot `0.48.1`, consumidor Picareta `0.181.1`. Diagnóstico, evidências e plano de publicação em [24-diagnostico-scraping-whatsapp.md](../../picareta/docs/24-diagnostico-scraping-whatsapp.md).

Os dados recentes reproduziram falha de ingestão por ano Sodré igual a zero e galerias Leilo maiores que 40 fotos. A fila do Picareta estava vazia, sem pausa, com último aceite em 02/11/2026. Corrigir a coleta/ingestão não comprova entrega WhatsApp nem liberação do anti-bot de Favareto/VIP.

- `shared/utils/vehicle-year.ts`: ano desconhecido/zero vira nulo; aplicado em Sodré CLI/layer e no serializer cloud.
- `layers/scrapers/server/utils/cloud-ingest.ts`: serializer extraído sem alterar fórmula de identidade, preservando galeria e contratos.
- `runAuctionSearch.onSourceResult`: consumidor assíncrono por fonte, com deduplicação/geografia, isolamento de falha de persistência e `complete=false` para parcial. CLI sem consumidor preservada.
- Cloud salva cada fonte conforme termina, confirma `persisted` depois de todos os batches e só fornece IDs de fontes completas para análise adicional. Salvamento serial evita rajadas de ingestão. Fonte parcial nunca fecha snapshot.
- `cloud-progress.ts`: snapshots imutáveis, callbacks em ordem e três tentativas. Logs mostram elegíveis/enfileirados e caminhos de validação; callback terminal aguardado. Webhook opcional de análise deriva da origem da ingestão quando ausente.

Testes de persistência/progresso e Leilo aprovados, typecheck estrito dos sete arquivos de implementação sem diagnósticos. Testes com transporte/coleta mockados e replay local sem Mongo write, ingestão real ou Z-API. `tsx`/build normal dependem de ambiente com esbuild compatível; nenhuma dependência foi instalada no WSL.

```sh
pnpm exec tsx --test tests/cloud-source-persistence.test.ts tests/leilo-scraper.test.ts
pnpm build
```

Publicar o Picareta primeiro, depois o bot; confirmar `/health` em `0.48.1`. Reexecutar as fontes desejadas em `/scraping-cloud` e acompanhar `/admin?tab=whatsapp`. Não reabrir aceites antigos nem itens incertos. Favareto/VIP ainda exigem acesso aceito pela origem; nenhum proxy, worker residencial ou solução automática de CAPTCHA foi configurado.
