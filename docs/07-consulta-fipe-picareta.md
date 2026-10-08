# Consulta FIPE do Picareta — bot 0.40.0

`POST /api/internal/fipe` consulta versões FIPE e o valor de uma seleção usando a infraestrutura existente. Exige `x-scraper-service-key` igual a `SCRAPER_SERVICE_KEY`, com comparação em tempo constante. Sem chave válida, não acessa Mongo/provider. A rota é atendida pelo Nuxt e encaminhada pelo `start-combined`.

`action: suggestions` recebe `brand`, `model`, `year` e retorna até 12 sugestões pelo `suggestFipe` existente. `action: quote` recebe os seis campos de `FipeApplyInput` e retorna a referência oficial por `applyFipeSelection`. Não escreve lotes/favoritos e não envia mensagens. Picareta identifica seu lote e persiste a referência no mesmo documento canônico.

Ambas as ações consultam primeiro `fipe_cache`, com chave por provider, tipo de veículo, referência mensal, ação e consulta/seleção. Resultados válidos são reutilizados por até 30 dias; a mudança do mês separa consultas quando a referência é a mais recente. Falhas/valores ausentes ou zero não são armazenados como referências válidas. Tokens continuam no backend.

O scraper preserva `fipe` e `fipeCheckedAt` quando há `fipeSelectedAt` e FIPE válida, mantendo a escolha do Picareta durante novas coletas. Lance e regras de venda futura seguem o fluxo normal. A ingestão Picareta preserva os demais metadados da referência. Nenhum histórico `FavoriteRecord.priceAtSend`, `fipeAtSend` ou `fipePercent` é modificado.

A consulta não transforma encerramento em arremate e não recupera automaticamente vendas Sodré que saíram da busca; o resultado depende de evidência final. Publicar junto com Picareta 0.171.0. Extensão permanece 0.27.0.

Validação: `pnpm exec tsx --test tests/opportunity-fipe-service.test.ts`. Cobertura de autorização, cache, entradas inválidas, falhas/ausência de preço e preservação da FIPE durante coletas; sem provider ou WhatsApp real.
