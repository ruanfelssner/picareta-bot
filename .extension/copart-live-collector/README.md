# Picareta Smart Assistant

Extensao simples para ler o lote renderizado em leiloes ao vivo, mostrar um preview e salvar resultados finais no backend remoto.

A versao antiga completa ficou em `.extension/copart-live-collector-backup`.

Documentacao tecnica e plano multi-site: `docs/live-auction-extension.md`.

Os icones da extensao reutilizam a identidade visual azul da Felssner Garage nos tamanhos exigidos
pelo Chrome. Para publicar, envie o ZIP com `manifest.json` diretamente na raiz do pacote.

## Publicação automática

O GitHub Actions valida e empacota a extensão em pull requests e alterações na `main`. Para enviar
uma versão à Chrome Web Store, basta subir `version` no `manifest.json` e levar a mudança para a `main`.

O workflow compara a versão do manifesto com a publicada e a em análise na loja. Se for maior, envia o
pacote, solicita revisão e publica automaticamente depois da aprovação da Google. Se a versão não
mudou, ou já foi enviada manualmente pelo painel, o envio é ignorado sem erro.
A configuração inicial das variáveis e da service account está em `docs/live-auction-extension.md`.

## Instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `.extension/copart-live-collector`.
5. Nos detalhes da extensao, ative `Permitir acesso a URLs de arquivo`.

## Usar

1. Deixe o backend acessível em `https://picareta-bot.felss.dev`.
2. Abra um arquivo em `.extension/copart-live-collector/exemples/`, `.extension/copart-live-collector/vip/`, `.extension/sodre/`, um leilao da Copart, um evento online da VIP Leiloes ou o telao da Sodre Santoro (`leilao.sodresantoro.com.br/app/telao/`).
3. O painel `Picareta Smart Assistant` aparece automaticamente com a mascara de login.
4. Entre no proprio painel com o mesmo telefone e senha do Picareta. Antes do login, nenhum controle ou dado do lote fica visivel.
5. Use `🔄` para reler a pagina. Em uma pagina individual Copart, o mesmo botao aparece como recaptura e atualiza o lote existente no banco e no Picareta; o salvamento continua disponível no botão `💾`.
6. Use `▶` para observar mudancas e salvar quando o status virar `sold`, `conditional` ou `not_sold`.

Ao fechar o painel, clique no icone da extensao para reabri-lo na pagina atual. Esse clique nao abre
a pagina de opcoes do Chrome.

Os controles usam apenas ícones; passe o mouse para ver a função:

Essa barra aparece somente para administradores. Para usuarios comuns autenticados, a coleta fica
sempre ativa automaticamente e fechar o painel nao interrompe o acompanhamento dos lotes.

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
Quando o lote ainda está em andamento, ele fica marcado como salvo e aguardando resultado final;
assim que a mensagem final aparecer na página aberta do leilão, a extensão atualiza o mesmo registro
automaticamente.
Se o Bot aceitar o lote mas a sincronização com o Picareta falhar, o painel mostra
`Salvo no Bot · aguardando Picareta` e mantém o item disponível para nova tentativa, sem informar
incorretamente que ele já está na listagem pública.
O filtro `Salvos manuais` mostra os lotes enviados manualmente ou reprocessados pela lista.
Recapturas sem imagem nova preservam a imagem já cadastrada no Bot e no Picareta.
Na modal `Dados`, `Salvar alterações` modifica somente o JSON local e sinaliza o lote como
`Sync pendente`; nenhum envio é feito nessa ação. O botão `Sync` envia explicitamente a versão local
ao Bot e ao Picareta. A FIPE aceita tanto valores simples, como `29343`, quanto formatados, como
`R$ 29.343,00`, sem truncar dígitos.

O painel usa exclusivamente o modo Banco. O envio vai para `POST https://picareta-bot.felss.dev/api/vehicles/ingest`
e salva direto no MongoDB, aplicando as regras automáticas (ver `⚙️` abaixo). Enquanto o lote estiver
aberto, o topo do painel sinaliza que ele será salvo quando o resultado final for identificado.

Para consultar condicionais, abra `/historico-leiloes-publico?admin=true` no Picareta e clique em
`Conectar extensão`. Depois abra a Copart, clique em `Conectar este navegador` no painel da extensão
e aguarde o Histórico iniciar a fila. O service worker reutiliza a própria aba em que a conexão foi
confirmada e redireciona um lote por vez, usando a sessão já aberta no Chrome. Cookies e tokens não são salvos no banco;
se a Copart exibir Incapsula/Captcha, o job fica como erro para ser reprocessado após a resolução manual.

Ao ler um lote, o painel consulta `scraped_vehicles` e, quando encontra o mesmo veículo, reaproveita
marca, modelo, ano e FIPE. Com lance e FIPE disponíveis, mostra:

- percentual atual da FIPE;
- total estimado com taxas;
- lance máximo da `Análise IA`;
- média histórica e tamanho da amostra.

Enquanto o lote estiver em lance aberto, a extensao apenas atualiza o preview.
O estado ativo fica salvo por fonte; se a pagina recarregar, o coletor volta ativo sozinho. Use `⏹` para desligar de forma persistente.

No modo Banco, os itens bloqueados por categoria, estado ou monta são registrados
no backend. A lista `🗂️` mostra as pendências da fonte atual e oferece um único botão `Sync` por lote,
que envia o JSON local novamente sem exigir que o lote ainda esteja na tela.
Cada item também exibe o diagnóstico do salvamento. Quando a Copart ainda não informa o resultado,
o lote fica identificado como `Não salvo · aguardando resultado`; se for salvo manualmente antes do
resultado final, aparece como `Salvo · aguardando resultado final`. O botão `Dados` abre o log completo,
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

Antes de usar os controles, entre na mascara exibida dentro do proprio painel com o mesmo telefone e senha da conta
do Picareta. A senha e usada somente na requisicao de login e nao fica armazenada. O token de sessao
individual fica no `chrome.storage.local`, e o service worker o envia como `Bearer` para identificar
o usuario responsavel por cada observacao e salvamento. A faixa da conta conectada permite desconectar.
