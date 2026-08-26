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
4. Use `🔄` para reler a pagina.
5. Use `▶` para observar mudancas e salvar quando o status virar `sold`, `conditional` ou `not_sold`.

Os controles usam apenas ícones; passe o mouse para ver a função:

- `▶`/`⏹` — ativar ou desativar a coleta.
- `💾`/`🚫` — forçar o salvamento ou ignorar o lote atual.
- `↺` — remover a decisão manual e voltar às regras automáticas.
- `🗄️`/`📄` — alternar entre os modos Banco e Documento.
- `🔄` — atualizar a leitura do lote.
- `💰` — consultar versões FIPE ou informar um valor manual.
- `🔔`/`🔕` — ativar ou desativar os avisos sonoros.
- `⚙️` — abrir ou fechar a configuração.
- `🗂️` — consultar os lotes ignorados e reprocessar um item depois de liberar a categoria ou filtro.

O painel começa no modo Banco (`🗄️`). Nesse modo, o envio vai para `POST https://picareta-bot.felss.dev/api/vehicles/ingest` e salva direto no MongoDB, aplicando as regras automáticas (ver `⚙️` abaixo).

Ao ler um lote, o painel consulta `scraped_vehicles` e, quando encontra o mesmo veículo, reaproveita
marca, modelo, ano e FIPE. Com lance e FIPE disponíveis, mostra:

- percentual atual da FIPE;
- total estimado com taxas;
- lance máximo da `Análise IA`;
- média histórica e tamanho da amostra.

Use `💰` para pesquisar versões por marca/modelo/ano. Ao escolher uma opção, a FIPE é salva no
registro encontrado na base e aplicada ao lote atual. Se não houver correspondência na base, o
valor fica no lote atual e será enviado junto quando o resultado final for salvo. O mesmo vale
para a FIPE preenchida manualmente.

## Avisos sonoros

Os sons são gerados pela própria extensão, sem arquivos de áudio:

- novo lance acima do anterior — campainha curta de duas notas;
- mudança do lote para `Vendido` — sequência de confirmação diferente.
- mudança para `Condicional` — sequência intermediária de três notas;
- mudança para `Não vendido` — duas notas graves descendentes.

O som fica habilitado por padrão e a preferência é salva por fonte. O Chrome exige uma interação
do usuário antes de liberar áudio; clicar em qualquer controle do painel, como `▶` ou `🔔`, libera
os avisos naquela página.

Use `🗄️` para alternar para o modo Documento (`📄`), que manda o envio para `POST https://picareta-bot.felss.dev/api/vehicles/ingest-text` e acrescenta cada resultado final ao arquivo `data/live-auction-AAAA-MM-DD.txt`, sem tocar no MongoDB e sem aplicar filtro de categoria/estado/monta.

O caminho do arquivo do modo Documento pode ser alterado no backend com `LIVE_AUCTION_TEXT_FILE`. Um caminho relativo é resolvido a partir da raiz do projeto.
Enquanto o lote estiver em lance aberto, a extensao apenas atualiza o preview.
O estado ativo fica salvo por fonte; se a pagina recarregar, o coletor volta ativo sozinho. Use `⏹` para desligar de forma persistente.

No modo Banco, os itens bloqueados por categoria, estado, monta ou decisão manual são registrados
no backend. A lista `🗂️` mostra as pendências da fonte atual e o botão `Reprocessar` envia o último
evento capturado novamente, sem exigir que o lote ainda esteja na tela.

## Configurar regras automáticas

O botão `⚙️` abre um painel para editar, sem precisar mexer no código:

- **Estados para salvar automático** — clique nas UFs para incluir/excluir da lista (nenhuma
  UF selecionada é diferente de "aceita todas": significa que nenhum estado passa).
- **Bloquear lote quando não detectar estado** — desligue se quiser aceitar lotes cujo endereço
  não deixou claro a UF (comum em Sodré/VIP quando o texto não menciona o estado).
- **Categorias Copart permitidas** — lista separada por vírgula; só vale para lotes da Copart.

Clique em `✓` para persistir (fica em `localStorage`, sobrevive a reload e a
reinício do Chrome) ou `↺` para voltar ao padrão de fábrica (`PR`, categorias originais,
estado obrigatório).

O backend e a extensao compartilham uma credencial padrao, portanto nenhuma configuracao e
necessaria para autenticar. O service worker envia automaticamente o header
`x-live-auction-extension-token` em todas as chamadas.

Para rotacionar a credencial, configure `LIVE_AUCTION_EXTENSION_TOKEN` no servidor, clique no
icone da extensao, informe o mesmo valor e use **Salvar e testar**. A substituicao fica no
`chrome.storage.local` da extensao; nao e necessario configurar cada site de leilao.

O token antigo salvo como `copartExtensionToken` no `localStorage` do site ainda e aceito apenas
como fallback de compatibilidade.
