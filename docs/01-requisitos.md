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
- A tela deve oferecer dois modos de execução: "Worker do PC" (padrão quando acessada por domínio publicado) e "Este servidor" (padrão em localhost/rede local). A escolha fica salva no navegador.
- No modo "Worker do PC", a tela grava a busca (um ou vários termos) na collection `marketplace_web_searches`; o `pnpm worker`, rodando na máquina com o perfil do Facebook, executa os termos em sequência e grava no mesmo documento os logs, as prévias e a lista final de cada termo. A tela acompanha por polling a cada 2 segundos, com o mesmo comportamento de prévias, mescla e ordenação do modo local.
- Buscas da tela web têm prioridade sobre os comandos do WhatsApp na fila do worker, não publicam no WhatsApp e respeitam os anúncios arquivados.
- Só pode existir uma busca web na fila ou em andamento por vez. Ao abrir a tela em qualquer aparelho, uma busca ativa é retomada automaticamente; sair da tela não cancela a busca no PC.
- "Parar busca" no modo worker cancela na hora se a busca ainda estiver na fila, ou pede o cancelamento ao worker se já estiver rodando.
- A tela deve indicar se o worker do PC está online (heartbeat nos últimos 90 segundos) e avisar quando a busca vai ficar na fila. Busca sem atualização por 5 minutos é tratada como travada, e buscas deixadas em execução por um worker reiniciado são marcadas como falha na inicialização.

## Extensão de leilão ao vivo

- A captura local deve acompanhar os lotes mesmo antes do resultado final e antes de chamadas de rede para reconciliar lotes anteriores.
- O histórico deve eliminar a duplicação de valores entre resumo e último evento no armazenamento, preservando todos os campos e a exportação completa; o formato anterior deve continuar legível.
- Falhas de gravação não podem marcar uma leitura como persistida nem impedir nova tentativa; lotes ainda não persistidos devem continuar disponíveis na aba para reconciliação e exportação, com aviso visível que não seja substituído pela mensagem de espera do resultado final.
- A ponte entre frames deve enviar JSON textual compatível com os listeners da Copart e aceitar também objetos das versões anteriores.

- A extensão deve manter disponível o salvamento manual mesmo quando a ação de atualizar/recapturar estiver presente.
- O usuário deve poder salvar um lote ainda sem resultado final; quando o resultado for capturado, o mesmo lote deve ser atualizado automaticamente.
- A lista de lotes capturados deve oferecer busca por veículo/lote/código, filtros por situação e por divergência entre o valor da mensagem e o lance, além de ações compactas para dados, atualizar novamente, salvar, excluir, abrir o link do veículo e reprocessar somente os itens exibidos.
- A ação de reprocessamento deve ficar visível e informar a quantidade de lotes que será atualizada conforme os filtros ativos.
- O filtro de lotes capturados deve informar a quantidade de itens atualmente exibidos após busca e filtros.
- Salvamentos, atualizações e recarregamentos da lista não devem alterar a posição atual do scroll.
- O painel da extensão deve poder ser reposicionado por arraste e preservar sua posição por fonte.
- O espaço reservado da análise IA e a caixa de lotes capturados devem permanecer compactos e estáveis para evitar mudanças constantes de layout.

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
