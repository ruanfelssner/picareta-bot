# Rastreio de monta e validação por chassi

Bot Anúncios 0.47.8 integra-se ao Picareta 0.180.1. Implantar o Picareta primeiro, pois a API antiga descarta campos de evidência que a fila nova precisa confirmar.

## Captura e identidade

A extensão envia os dados existentes a `/api/vehicles/ingest`, incluindo `chassisRaw` e `chassisNormalized`. Não é necessária uma nova versão da extensão. Na Copart, alterações só são confirmadas no Histórico público/PDF quando há chassi completo igual nas duas evidências. Máscaras, parciais, placeholders e chassis conflitantes não estabelecem vínculo. O código localiza o anúncio, mas não substitui essa validação. Chassi igual também permite rastrear mudanças com códigos diferentes, sem expor a identificação no DTO público.

`shared/utils/live-vehicle-history.ts` identifica uma ocorrência por origem, URL, dia em Brasília, número do lote e ID do pregão. Um novo pregão não atualiza o registro de um leilão anterior, nem herda seu resultado final. Uma classificação diferente no mesmo pregão recebe novo `damageObservedAt`; recapturas equivalentes mantêm o instante original. `liveObservedAt` permite rejeitar atualizações antigas.

## Preservação e sincronização

`scraped_vehicles.damageHistory` mantém os pontos anteriores/atuais por `$addToSet`, sem renovar `expiresAt`. Cada ponto contém identificação e classificação, sem dados do usuário/coletor. A outbox persistente recebe o payload completo antes do overwrite. Se não puder gravar na fila, a operação aborta sem substituir os campos correntes.

A identidade de `live_vehicle_sync_outbox` inclui ocorrência, chassi, monta, instante da classificação e resultado/valor: uma nova monta ou outro pregão não substitui a pendência anterior. Pendências não expiram. Após confirmação da API, a fila conserva sua retenção técnica de oito dias; as evidências já estão no arquivo permanente `marketplace.auction_damage_observations` do Picareta, sem TTL. Reinícios e falhas de rede reutilizam a fila existente.

A API do Picareta aceita os pontos em `damageHistory` (até 5.000), além de `damageObservedAt` e `liveObservedAt`. Arquiva antes de confirmar com `damageHistoryArchived: true` e protege o registro corrente contra tentativas atrasadas ou concorrentes. O bot exige essa confirmação para payloads com evidências; um servidor antigo mantém o envio pendente, sem descartar seu histórico. O array embutido não é substituído pelo payload de uma captura mais antiga e o Picareta não renova `expiresAt` em atualizações. Campos desconhecidos/transitórios de monta não geram mudança.

A recaptura manual Copart usa a mesma fila e acrescenta evidências antes de alterar o registro. A busca seleciona a ocorrência mais recente disponível e a recaptura recusa um chassi completo diferente. Leituras passivas e regras de resultado continuam no fluxo existente.

## Limitações e validação

O rastreio depende das capturas recebidas e do chassi que a página disponibiliza. Não consulta um órgão oficial nem recupera capturas já perdidas antes da preservação. Escritas diretas externas que ignoram o fluxo não são cobertas.

Testes focados: `node --import tsx --test tests/live-vehicle-history*.test.ts tests/extension-save-integrity.test.mjs tests/pestana-live-extension.test.mjs tests/live-auction-extension.test.mjs`. Os testes de ingestão e fila usam armazenamento simulado e não enviam mensagens, não consultam a Copart e não acessam banco de produção.
