# 12 - Desativação da Pampa Sul Leilões

## Decisão e escopo

Desativação operacional solicitada em 16/10/2026. Versões: Bot Anúncios **0.43.1** e Picareta **0.175.2**. A alteração preserva metadados, aliases, parsers de arquivos já obtidos, histórico e valores existentes. Nenhum documento é removido ou reclassificado.

## Bloqueios no Bot

- A política central em `shared/constants/sources.ts` remove `pampasul` de `ACTIVE_AUCTION_SOURCES`. Os seletores Nuxt e o runner deixam de oferecer/executar a fonte.
- Cloud, CLI e registro Express filtram a fonte, mesmo quando recebida explicitamente de uma seleção antiga. Somente fontes desativadas resultam em nenhuma fonte válida, sem trocar silenciosamente para outras fontes.
- O wrapper e o coletor Pampa Sul rejeitam chamadas diretas antes de consultar lotes pendentes no Mongo ou acessar HTTP. Os parsers de fixtures/arquivos históricos permanecem disponíveis.
- Envios Nuxt, Express, CLI e notificações de venda pelo Express recusam a fonte. O botão de envio do card fica desabilitado para registros antigos dessa origem. As outras fontes conservam suas regras anteriores de envio.
- Os dois seletores da interface Express deixam de apresentar a opção, mantendo seus rótulos históricos.

## Bloqueios no Picareta

`SCRAPED_SOURCE_VALUES` e aliases continuam reconhecendo a origem para ingestão/histórico legados. `SCRAPING_SOURCE_VALUES` e `ACTIVE_SCRAPED_SOURCE_VALUES` excluem Pampa Sul. O início de uma coleta revalida os IDs ativos, inclusive quando chamado por outro módulo. A saúde de scraping ignora resultados atrasados de fontes que já não estejam habilitadas.

O seletor e as consultas de oportunidades usam apenas fontes ativas; uma consulta explícita restrita à Pampa Sul retorna vazia. A busca individual também não oferece o registro como oportunidade. O Histórico continua consultável, mas seu envio manual é recusado. A elegibilidade da fila verifica a origem novamente e cancela um item Pampa Sul já enfileirado antes de criar legenda ou chamar o transporte.

As referências de preço e FIPE das oportunidades também deixam de usar a Pampa Sul como amostra; os dados continuam disponíveis no histórico para consulta.

Não há env vars, dependências novas ou exclusão de dados. Os patches não adicionam entrada em `APP_UPDATE_RELEASES`.

## Validação e aplicação

Testes do Bot cobrem fonte fora da seleção, aliases históricos, bloqueio de envio para resultados ativos/terminais e rejeição de coleta/reconsulta com zero chamadas HTTP. Testes do Picareta cobrem histórico reconhecido, seleção ativa removida, bloqueio por origem, cancelamento de item já enfileirado e regressões financeiras/PWA. As funções reais de seleção cloud, registro Express e CLI foram exercitadas em isolamento, sem iniciar serviços externos ou enviar mensagens.

Comandos recomendados no Bot: `pnpm exec tsx --test tests/disabled-auction-sources.test.ts tests/vardana-pampasul-scraper.test.ts tests/pampasul-fees.test.ts` e `pnpm build`. No Picareta: `pnpm exec tsx --test tests/pampasul-source.test.ts tests/opportunity-whatsapp-queue.test.ts tests/auction-opportunity-financials.test.ts tests/auction-opportunity-market-analysis.test.ts tests/app-update.test.ts`, `pnpm lint` e `pnpm build`.

O agente usou transpilação temporária para os testes, sem modificar `node_modules`. O ambiente local usa Node 18 e possui dependências de outra plataforma; o build completo deve ser validado no ambiente configurado (Bot exige Node >=20.19). Passaram 17 testes no Bot e 34 no Picareta (51 no total). Lint dos módulos alterados do Picareta passou; os SFCs alterados compilaram e os seletores legados foram conferidos em 390 e 1.440 px, sem a opção desativada e sem extrapolar o viewport. O typecheck do Bot manteve 152 diagnósticos anteriores (incluindo Express ausente neste ambiente); o Picareta manteve 37, sem diagnósticos novos. Os typechecks globais continuam com essas pendências anteriores.

Para aplicar em produção, publicar **ambos os projetos** e reiniciar os processos do Bot (web, cloud/CLI e workers que estejam carregados). Processos antigos conservam o código anterior até serem substituídos. Nenhuma publicação ou alteração direta nos registros de produção foi realizada nesta implementação.
