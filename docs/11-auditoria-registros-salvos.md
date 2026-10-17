# 11 - Pesquisa de lotes e registros preservados

## Comportamento (0.43.0)

`/live-audit` abre na aba **Registros salvos**, ao lado de **Lotes comparados** e **Mensagens do log**. A pesquisa considera todo o histórico ainda armazenado por padrão e aceita lote, código, número do leilão, modelo, texto e URL. Números coincidem integralmente; `lote 61`, `código 1162845` e `leilão 112097` restringem o campo correspondente. Também há filtros por leiloeiro, últimos sete/trinta dias e intervalo personalizado no fuso de Brasília.

A consulta pagina no servidor: 25 sessões/registros sem sessão por página e 50 evidências no detalhe. Busca, sessão e datas personalizadas ficam na URL. Exemplo: `/live-audit?q=1162845&sessionKey=copart%3A112097`. Registros sem sessão comprovada permanecem isolados por origem/ID, sem associar veículos apenas pelo número do lote.

Cada evidência apresenta origem, horário, valor, FIPE e mensagem existente. Log no Picareta, log no Bot, último estado da extensão, cadastro no Bot, resultado consolidado e coleta do catálogo são fontes distintas. O aviso de log indisponível considera toda a sessão, independentemente do filtro do detalhe. Snapshots não são convertidos em mensagens nem reconstituem a conversa completa. O acesso ao catálogo usa o mesmo anúncio e origem dos veículos da sessão.

As abas anteriores mantêm a reconciliação, ponte local, importação e exportação JSON. Selecionar uma sessão na pesquisa fixa essa identidade para as comparações. O polling da comparação fica suspenso na aba de registros salvos; a pesquisa tem atualização explícita e não perde filtros a cada três segundos. Um tamanho `lg` no `UiSelect` garante toque de 44 px e texto de 16 px no celular, preservando os tamanhos anteriores do componente.

## Arquitetura

- `app/components/LiveAuctionArchive.vue`: busca, seleção de sessão, filtros e paginação com o design system existente.
- `GET /api/vehicles/live-audit/archive`: valida filtros e datas, usando o mesmo acesso e a mesma conexão de dados da auditoria existente.
- `layers/cars/server/utils/live-auction-archive.ts`: consultas de leitura no Mongo configurado pelo `useDb()`.
- `layers/cars/server/utils/live-auction-archive-query.ts`: projeção explícita, busca literal e união das fontes. Exclui usuários, dispositivos, tokens e imagens das respostas.
- `shared/types/live-auction-archive.ts`: contrato entre API e interface.

As consultas combinam `auction_sessions`, `auction_live_events`, `live_auction_event_outbox`, `live_auction_capture_observations`, `scraped_vehicles` e `auction_lot_results`; o detalhe relaciona `auction_results` pelo anúncio/origem. Timeout e limites ficam fixos no código, sem env vars nem dependências novas. Não há alteração em mensagens, valores, TTLs, capturas ou resultados.

A implementação inicialmente colocada no Picareta foi retirada em 0.175.1, restaurando a página anterior e removendo a API duplicada. O histórico Git permanece intacto; nenhum commit foi criado durante a migração.

## Validação

- 32 testes de busca/reconciliação e 41 testes de regressão da extensão passaram; o executor TypeScript usou transpilação temporária fora dos repositórios, sem instalar dependências.
- Validações da API verificadas com dependências simuladas: datas, leiloeiro e origem inválidos; consulta livre e detalhe de sessão.
- A leitura real pelo módulo do Bot encontrou `copart:112097`, lote `61`, código `1162845`: captura e cadastro com R$ 32.300 às 15h09min03s de 06/10/2026 e coleta anterior do catálogo com R$ 24.300 às 12h02min25s. Nenhum dado foi alterado.
- A página e os componentes reais foram compilados e renderizados em Chromium com transporte simulado, em 390 e 1.440 px. Conferidos: valores/FIPE, URL, abas comparativas e de mensagens, filtro de origem, vazio, datas inválidas, erro, paginação, foco e ausência de overflow.
- Typecheck do Bot apresentou 152 diagnósticos em outros arquivos, nenhum nos módulos novos. Build Nuxt completo permanece para o ambiente configurado: o agente usa Node 18, enquanto o projeto exige Node >=20.19; as dependências locais não foram reinstaladas nem modificadas. Cinco testes PWA do Picareta passaram após a retirada da implementação duplicada.

Comandos recomendados no Bot: `pnpm exec tsx --test tests/live-auction-archive.test.ts tests/live-auction-reconciliation.test.ts`, `node --test tests/live-auction-extension.test.mjs` e `pnpm build`. No Picareta: `pnpm exec tsx --test tests/app-update.test.ts` e `pnpm build`.
