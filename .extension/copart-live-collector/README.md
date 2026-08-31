# Picareta Smart Assistant

Extensao simples para ler o lote renderizado em leiloes ao vivo, mostrar um preview e salvar resultados finais no backend remoto.

A versao antiga completa ficou em `.extension/copart-live-collector-backup`.

Documentacao tecnica e plano multi-site: `docs/live-auction-extension.md`.

## Instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `.extension/copart-live-collector`.
5. Nos detalhes da extensao, ative `Permitir acesso a URLs de arquivo`.

## Usar

1. Deixe o backend acessível em `https://picareta-bot.felss.dev`.
2. Abra um arquivo em `.extension/copart-live-collector/exemples/`, `.extension/copart-live-collector/vip/`, `.extension/sodre/`, um leilao da Copart, um evento online da VIP Leiloes ou o telao da Sodre Santoro (`leilao.sodresantoro.com.br/app/telao/`).
3. O painel `Picareta Smart Assistant` aparece automaticamente.
4. Use `🔄` para reler a pagina. Em uma pagina individual Copart, o mesmo botao aparece como recaptura e atualiza o lote existente no banco e no Picareta; o salvamento continua disponível no botão `💾`.
5. Use `▶` para observar mudancas e salvar quando o status virar `sold`, `conditional` ou `not_sold`.

Os controles usam apenas ícones; passe o mouse para ver a função:

- `▶`/`⏹` — ativar ou desativar a coleta.
- `🔄` — atualizar a leitura do lote.
- `💾` — salvar o lote atual, inclusive antes do resultado final; quando o resultado aparecer, o mesmo registro é atualizado automaticamente.
- `⚙️` — abrir ou fechar a configuração.
- `🗂️` — consultar os lotes ignorados e reprocessar um item depois de liberar a categoria ou filtro.

O painel pode ser reposicionado arrastando o cabeçalho. A posição fica salva por fonte. Em
`Lotes capturados`, o filtro `Não salvos` facilita encontrar pendências; cada linha usa ícones para
abrir os dados, salvar, excluir e abrir o link do veículo. Atualizações da lista preservam a posição
do scroll. O contador ao lado de `Exibir` mostra quantos lotes estão visíveis após os filtros. O campo
de busca ao lado do filtro localiza rapidamente por veículo, lote, código,
categoria, pátio ou comitente.
O filtro `Mensagem ≠ lance` mostra lotes cujo valor final exibido na mensagem é diferente do lance
salvo. O botão `Atualizar exibidos` reprocessa somente os lotes atualmente exibidos e atualiza os
registros existentes.
Na modal de dados, `Atualizar novamente` recaptura o lote da página atual; para um lote de outra
página, abre o link em uma nova aba para a recaptura.

O painel usa exclusivamente o modo Banco. O envio vai para `POST https://picareta-bot.felss.dev/api/vehicles/ingest`
e salva direto no MongoDB, aplicando as regras automáticas (ver `⚙️` abaixo). Enquanto o lote estiver
aberto, o topo do painel sinaliza que ele será salvo quando o resultado final for identificado.

Ao ler um lote, o painel consulta `scraped_vehicles` e, quando encontra o mesmo veículo, reaproveita
marca, modelo, ano e FIPE. Com lance e FIPE disponíveis, mostra:

- percentual atual da FIPE;
- total estimado com taxas;
- lance máximo da `Análise IA`;
- média histórica e tamanho da amostra.

Enquanto o lote estiver em lance aberto, a extensao apenas atualiza o preview.
O estado ativo fica salvo por fonte; se a pagina recarregar, o coletor volta ativo sozinho. Use `⏹` para desligar de forma persistente.

No modo Banco, os itens bloqueados por categoria, estado ou monta são registrados
no backend. A lista `🗂️` mostra as pendências da fonte atual e o botão `Reprocessar` envia o último
evento capturado novamente, sem exigir que o lote ainda esteja na tela.
Cada item também exibe o diagnóstico do salvamento. Quando a Copart ainda não informa o resultado,
o lote fica identificado como `Não salvo · aguardando resultado`; se for salvo manualmente antes do
resultado final, aparece como `Salvo · sem resultado final`. O botão `Dados` abre o log completo,
com motivo, decisão, resultado capturado e horário da última ação. Se o leilão avançar antes do
status visual, a extensão usa as mensagens finais do chat para reconciliar automaticamente os lotes pendentes.

## Configurar regras automáticas

O botão `⚙️` abre um painel para editar, sem precisar mexer no código:

- **Estados para salvar automático** — clique nas UFs para incluir/excluir da lista (nenhuma
  UF selecionada é diferente de "aceita todas": significa que nenhum estado passa).
- **Bloquear lote quando não detectar estado** — desligue se quiser aceitar lotes cujo endereço
  não deixou claro a UF (comum em Sodré/VIP quando o texto não menciona o estado).
- **Ignorar grande monta e sucata** — quando ligado, lotes classificados como grande monta,
  sucata, perda total ou irrecuperável ficam pendentes e não são salvos automaticamente.
- **Ignorar categorias da Copart** — use os botões para bloquear categorias específicas, como
  SUV Grandes ou Picapes Grandes. Os botões de caminhões e motos continuam controlando esses
  grupos mesmo quando a lista de categorias permitidas estiver vazia.
- **Categorias Copart permitidas** — lista separada por vírgula para uma restrição adicional;
  deixe vazia para aceitar todas as categorias que não foram ignoradas.

Clique em `✓` para persistir (fica em `localStorage`, sobrevive a reload e a
reinício do Chrome) ou `↺` para voltar ao padrão de fábrica (estados `PR`, `SC`, `RS` e `SP`,
categorias e montas liberadas, estado obrigatório).

O backend e a extensao compartilham uma credencial padrao, portanto nenhuma configuracao e
necessaria para autenticar. O service worker envia automaticamente o header
`x-live-auction-extension-token` em todas as chamadas.

Para rotacionar a credencial, configure `LIVE_AUCTION_EXTENSION_TOKEN` no servidor, clique no
icone da extensao, informe o mesmo valor e use **Salvar e testar**. A substituicao fica no
`chrome.storage.local` da extensao; nao e necessario configurar cada site de leilao.

O token antigo salvo como `copartExtensionToken` no `localStorage` do site ainda e aceito apenas
como fallback de compatibilidade.
