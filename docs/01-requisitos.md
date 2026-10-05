# Requisitos

## Busca local no Facebook Marketplace

- A tela `/marketplace` deve permitir iniciar uma busca local no Facebook Marketplace.
- Os últimos 8 termos iniciados pelo usuário devem ser salvos somente no armazenamento do navegador.
- Termos repetidos devem voltar para o início do histórico sem criar duplicatas.
- O usuário deve poder reutilizar um termo, removê-lo individualmente ou limpar todo o histórico.
- Resultados da busca, sessão do Facebook e credenciais não devem ser salvos nesse histórico.
- Anúncios que passam no filtro estrito devem aparecer em tempo real durante a coleta, marcados como "Prévia"; ao final, a lista validada (enriquecida e filtrada) substitui as prévias daquele termo.
- O histórico deve oferecer "Procurar tudo", que executa todos os termos salvos em sequência e junta os resultados numa lista única, sem duplicar anúncios, ordenada por relevância (alta, média, baixa) e depois por score, indicando em cada card os termos que o encontraram.
- A última lista de resultados deve ficar em cache no navegador (sem o texto bruto dos anúncios) e ser restaurada ao reabrir `/marketplace`, com indicação da data do cache; uma nova busca ou "Limpar lista" substitui o cache.
- Cada anúncio pode ser arquivado. O arquivamento fica no MongoDB (campo `archivedAt` na collection `listings`), o anúncio sai da lista e deixa de ser coletado nas próximas buscas (não entra em prévias, enriquecimento nem lista final).
- A tela deve listar os arquivados e permitir restaurá-los; sem MongoDB configurado, arquivar informa o erro e as buscas seguem sem filtro.
- A busca é executada somente pelo `pnpm worker` (não há mais execução do Playwright pelo servidor web nem pelo `pnpm dev`). A tela deve ser pensada primeiro para celular: campo de busca com botão na mesma linha, pesquisas recentes em chips (toque busca direto; modo "Editar" remove), filtro por relevância, cards compactos com preço em destaque, arquivar por ícone e log técnico recolhido.
- A tela grava a busca (um ou vários termos) na collection `marketplace_web_searches`; o `pnpm worker`, rodando na máquina com o perfil do Facebook, executa os termos em sequência e grava no mesmo documento os logs, as prévias e a lista final de cada termo. A tela acompanha por polling a cada 2 segundos, com o mesmo comportamento de prévias, mescla e ordenação descrito acima.
- Buscas da tela web têm prioridade sobre os comandos do WhatsApp na fila do worker, não publicam no WhatsApp e respeitam os anúncios arquivados.
- Só pode existir uma busca web na fila ou em andamento por vez. Ao abrir a tela em qualquer aparelho, uma busca ativa é retomada automaticamente; sair da tela não cancela a busca no PC.
- "Parar" cancela na hora se a busca ainda estiver na fila, ou pede o cancelamento ao worker se já estiver rodando.
- A tela deve indicar se o worker do PC está online (heartbeat nos últimos 90 segundos) e avisar quando a busca vai ficar na fila. Busca sem atualização por 5 minutos é tratada como travada, e buscas deixadas em execução por um worker reiniciado são marcadas como falha na inicialização.

## Extensão de leilão ao vivo

- A extensão deve exigir login com telefone e senha de uma conta existente do Picareta antes de liberar análise ou persistência.
- Quando não houver sessão, o próprio painel injetado deve exibir a máscara de login e ocultar resumo, análise IA, play, atualização, salvamento, configurações e histórico de capturas.
- O clique no ícone da extensão deve reabrir o painel na página atual, sem navegar para a tela de opções do Chrome.
- Depois do login, o painel deve carregar o lote e liberar a análise baseada no histórico da IA, os controles e o histórico de capturas.
- Usuários comuns autenticados devem manter a coleta ativa automaticamente e não devem visualizar a barra inferior; somente administradores podem ver e operar play, atualização, salvamento manual, configurações e histórico de capturas.
- A extensão publicada deve usar a mesma identidade visual do aplicativo, com ícones PNG próprios nos tamanhos 16, 32, 48 e 128 pixels declarados no manifesto.
- A senha não deve ser armazenada; somente o token individual e limitado da extensão pode permanecer no `chrome.storage.local`.
- Toda análise de lote identificável deve primeiro registrar uma observação no banco com usuário, dispositivo e instante da captura.
- O resultado final deve preservar todos os usuários contribuidores do lote e identificar separadamente a última captura.
- A captura local deve acompanhar os lotes mesmo antes do resultado final e antes de chamadas de rede para reconciliar lotes anteriores.
- O histórico deve eliminar a duplicação de valores entre resumo e último evento no armazenamento, preservando todos os campos e a exportação completa; o formato anterior deve continuar legível.
- Falhas de gravação não podem marcar uma leitura como persistida nem impedir nova tentativa; lotes ainda não persistidos devem continuar disponíveis na aba para reconciliação e exportação, com aviso visível que não seja substituído pela mensagem de espera do resultado final.
- A ponte entre frames deve enviar JSON textual compatível com os listeners da Copart e aceitar também objetos das versões anteriores.

- A extensão deve manter disponível o salvamento manual mesmo quando a ação de atualizar/recapturar estiver presente.
- O usuário deve poder salvar um lote ainda sem resultado final; quando o resultado for capturado, o mesmo lote deve ser atualizado automaticamente.
- A extensão só deve informar que um lote está salvo na base pública quando o Bot confirmar `accepted > 0` e `picaretaSynced = true`; falhas parciais devem aparecer como `Salvo no Bot · aguardando Picareta` e permanecer reprocessáveis.
- Códigos de veículo diferentes não podem ser consolidados apenas por compartilharem temporariamente o mesmo número de lote; na reconciliação do chat, a captura original mais antiga do lote deve prevalecer sobre identidades transitórias da troca de tela.
- Valores monetários digitados sem separador de milhar, como `29343`, devem preservar todos os dígitos tanto na FIPE quanto no lance.
- Na modal de dados, `Salvar alterações` deve atualizar somente o JSON local, sem chamada ao backend, e sinalizar claramente que o lote aguarda `Sync`.
- A lista de lotes capturados deve oferecer busca por veículo/lote/código, filtros por situação e por divergência entre o valor da mensagem e o lance, além de ações compactas para dados, excluir, abrir o link e um único `Sync` por lote; a ação de check/save separada não deve ser exibida.
- A ação de reprocessamento deve ficar visível e informar a quantidade de lotes que será atualizada conforme os filtros ativos.
- O Sync individual e o reprocessamento em massa da lista devem ser tratados como decisão manual explícita, inclusive para lotes ainda abertos, e o resultado em massa deve oferecer logs expansíveis por lote.
- Os botões de ação do cabeçalho da lista de capturas devem manter espaçamento visual suficiente para evitar aparência agrupada.
- O filtro de lotes capturados deve informar a quantidade de itens atualmente exibidos após busca e filtros.
- Salvamentos, atualizações e recarregamentos da lista não devem alterar a posição atual do scroll.
- O painel da extensão deve poder ser reposicionado por arraste e preservar sua posição por fonte.
- O espaço reservado da análise IA e a caixa de lotes capturados devem permanecer compactos e estáveis para evitar mudanças constantes de layout.
- O valor FIPE deve ser editável diretamente no resumo do lote, seguindo a simulação local do lance: margem, percentuais e comparação histórica devem reagir imediatamente, sem alterar a FIPE capturada ou persistida. Ao trocar de veículo, a extensão deve zerar imediatamente a FIPE exibida, o retorno do assistente e as simulações anteriores, permitindo preencher somente a FIPE correspondente ao novo veículo.
- Quando a FIPE for obtida antes do primeiro lance, a chegada do lance deve renovar os dados de taxas e calcular imediatamente total, margem e percentual da FIPE; mudanças posteriores de valor devem continuar sendo recalculadas localmente.
- Quando o lote lido estiver favoritado em `/oportunidades` do Picareta (por qualquer usuário), a extensão deve destacá-lo visualmente e tocar um aviso sonoro uma única vez ao entrar no lote.
- Um lote favorito deve ser salvo no resultado final mesmo fora dos filtros fracos (estado, categoria, monta), e o resultado vendido ou condicional deve ser enviado ao mesmo grupo do WhatsApp com lance, taxas detalhadas, total com taxas, % da FIPE, margem e comparação com o histórico, uma única vez por resultado.
- Mudanças da extensão devem ser validadas e empacotadas pelo GitHub Actions; uma tag `extension-vX.Y.Z` correspondente ao `manifest.json` deve enviar o ZIP à Chrome Web Store e solicitar publicação pela API V2, usando credenciais temporárias sem segredo permanente no repositório.
- A rota `/live-audit` deve comparar, por sessão e lote, as mensagens exportadas do IndexedDB da extensão, o outbox recebido pelo Bot, os lotes persistidos no Bot, os lotes visíveis no Histórico público do Picareta e a exportação local de lotes capturados.
- A importação dos JSONs locais na auditoria deve acontecer somente na memória do navegador, sem upload ou correção automática, e deve aceitar tanto a exportação do Log quanto `lotes-capturados-*.json`.
- A auditoria deve destacar mensagens que não chegaram ao servidor, lotes sem captura, lotes ausentes no Histórico público e divergências de status ou valor, além de permitir exportar o relatório da comparação.
- Com a extensão atualizada e uma aba de leilão aberta, `/live-audit` deve receber automaticamente os lotes e logs locais pela ponte da extensão, sem upload, atualizar servidor e ponte em intervalos curtos e manter a importação JSON como contingência.
- Quando a ponte da extensão falhar ou deixar de responder por três consultas seguidas, `/live-audit` deve exibir o motivo (por exemplo, recarregar a página após atualizar a extensão) e tratar `Log da extensão` e `Lote local` como `Sem dados locais`, sem usar o último snapshot recebido para afirmar ausência de lotes novos.
- Em lotes com resultado final, cada etapa da auditoria deve ser destacada em verde quando status, valor, FIPE e monta coincidirem com o consenso das demais etapas e em âmbar quando divergir; lotes ainda abertos permanecem neutros, e a linha inteira fica verde quando todas as etapas presentes conferem.
- A sincronização Bot → Picareta só é confirmada quando o Picareta informar ao menos um registro persistido (`matched` + `upserted`), aceitando tanto inserção quanto atualização de lote já existente.
- IDs de sessão devem ser comparados sem diferença entre maiúsculas e minúsculas, evitando que o mesmo leilão VIP/Copart apareça duplicado; lotes ainda abertos não devem ser marcados como ausentes no resultado final ou Histórico público.
- A comparação de lotes da auditoria deve ordenar pela evidência mais recente, exibindo primeiro os lotes que acabaram de ser observados ou atualizados.
- A auditoria deve exibir, por etapa detalhada, o lance/resultado, o valor FIPE e o tipo de monta, destacando quando FIPE ou monta estiverem ausentes ou divergirem entre extensão local, observação recebida, captura persistida e Histórico público.
- Na auditoria, `Log da extensão` representa os eventos do IndexedDB da própria extensão, lidos automaticamente pela ponte; mensagens históricas devem ser reconciliadas por sessão e lote sem herdar o código do veículo atualmente exibido na sala.
- O resultado final enviado pela extensão deve atualizar também a observação do lote, evitando que a auditoria preserve `Em aberto` depois de o Bot receber `Vendido`, `Condicional` ou `Não vendido`.
- Os snapshots de sessões locais devem permanecer no armazenamento da extensão entre reinícios e ser listados com origem, leilão, data e quantidade de lotes para permitir comparar coletas de dias anteriores.
- Valores ausentes nos eventos da auditoria não podem ser convertidos em `R$ 0`; o evento terminal de um lote deve prevalecer sobre mensagens genéricas posteriores e a tela deve alertar quando uma captura final não tiver resultado correspondente no log da extensão ou no log do Bot.
- O log do leilão deve guardar exclusivamente as mensagens reais do chat cujo texto começa com `Sistema:`, descartando rótulos da interface, valores isolados e eventos sintéticos; tanto o painel da extensão quanto `Mensagens do log` devem listar primeiro as mensagens mais recentes.

## POC de leilão público integrado ao WhatsApp

- O painel `/admin/leiloes` deve permitir criar rascunhos vinculados a veículos existentes, definir valor inicial, incremento e aprovação automática.
- Um leilão deve possuir os estados `draft`, `available` e `finished`, URL pública não sequencial e bloqueio de novos lances após a finalização.
- A página `/lance/:slug` deve ser pública, exibir veículo, maior lance, próximo lance, histórico com nomes mascarados e permitir lance informando somente o nome.
- A página pública `/lance/:slug` deve ocultar o cabeçalho/navegação administrativa global.
- A página pública deve atualizar os lances por polling a cada cinco segundos e informar quando o participante estiver vencendo.
- Enquanto o participante estiver vencendo, o botão de novo lance deve permanecer bloqueado.
- O nome preenchido para dar lance deve ser mantido na sessão da guia para evitar redigitação durante a participação.
- O servidor deve recalcular o valor do lance com base no estado atual e nunca confiar em valor enviado pelo navegador.
- Lances manuais devem permanecer `pending` até aprovação; lances obsoletos devem ser recusados como `SUPERSEDED`.
- A aceitação de lances deve ser serializada por leilão e a atualização do maior lance deve ser condicional no MongoDB para evitar perda em concorrência.
- Eventos `AUCTION_PUBLISHED`, `BID_ACCEPTED` e `AUCTION_FINISHED` devem ser persistidos em `whatsapp_events`; falha na Z-API não pode desfazer o lance.
- O aviso `BID_ACCEPTED` deve ser curto, informar valor, veículo, nome mascarado e conter somente o link público para dar lance.
- A comunidade principal e o grupo de avisos devem ser persistidos em `whatsapp_communities`; a criação deve usar a Z-API quando os IDs não forem informados.
- A rota pública deve limitar tentativas por IP e a proteção administrativa opcional deve usar `AUCTION_ADMIN_TOKEN` no header `x-auction-admin-token`.
