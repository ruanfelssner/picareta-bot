# Requisitos

## Worker Windows de leilões com favoritos (0.35.0)

- O `pnpm worker` deve consultar a agenda autenticada do Picareta a cada minuto quando a configuração local estiver ativada, sem misturar com o cron de busca diária. Oferecer `pnpm worker:auctions` independente de Mongo/Marketplace/WhatsApp.
- Abrir apenas salas oficiais HTTPS com favoritos da própria conta, horário confirmado e dentro da janela de trinta minutos antes; reconciliar sessões ainda ativas quando o Windows iniciar tarde. Prioridade Copart, Sodré e VIP com PR confirmado. Não abrir lotes, eventos encerrados, horários ausentes ou contagens desconhecidas.
- Disponibilizar teste de regras, teste de Chromium/extensão isolado, setup de login e prévia da agenda real sem abrir salas. O setup deixa a automação desativada; ativação/desativação são explícitas. `scripts/windows/test-auction-worker.cmd` encadeia os testes antes da ativação.
- Perfil Chromium exclusivo local, extensão existente carregada, configuração sem senhas e cookies restritos ao navegador. Logins no app, extensão e leiloeiro são distintos e manuais quando necessários. CAPTCHA/MFA não podem ser contornados pelo worker. Não publicar tokens/cookies em logs.
- Lock local evita disputa entre instâncias/setup; consultas não duplicam abas, reinícios reconciliam elegibilidade, alterações de horário/link reprogramam a sala e fechamento manual não reabre a mesma sala na mesma execução. Até seis salas simultâneas; falha de navegação retenta após cinco minutos. Agenda ausente/truncada não interrompe abas abertas; fim conhecido/encerramento fecha apenas salas próprias.
- O coletor deve pertencer à conta da agenda. Usuário comum mantém coleta automática existente; para admin, usar Ativar coleta somente após o início na sala oficial. O status de coleta ativa no painel não equivale a entrega confirmada; conferir persistência na extensão. Login automático com senha protegida e confirmação durável pelo worker ficam para a etapa seguinte.
- Operação e validação: `docs/02-worker-favoritos-leiloes.md`.
- Correção 0.35.1: quando a sala Copart ainda não foi liberada, consultar as listagens oficiais desde uma hora antes, relacionar somente catálogo/sala do mesmo card e salvar na agenda do Picareta pelo endpoint autenticado de capturas. Continuar buscando a cada minuto, abrir somente a partir de trinta minutos antes e evitar associação por pátio ou ID de sala deduzido. A prévia descobre sem POST; login/CAPTCHA externo pausa para intervenção manual.

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
- Na Copart, o resultado de um lote nunca pode ser usado como status ou lance de outro lote: na abertura do lote, sem status no painel, a mensagem `Lote anterior não foi vendido` não encerra o lote novo.
- Um novo `Próximo lote N` depois de um resultado do lote N indica reabertura pelo leiloeiro: o resultado anterior deixa de valer, o lote volta a ser tratado como aberto até a próxima mensagem final, e lances de outro lote anunciado no intervalo não são atribuídos a ele.
- A deduplicação do log do chat deve contar ocorrências por lote, porque o chat recomeça a cada lote e textos iguais (lances, incrementos) se repetem entre lotes.
- Um lote `Não vendido` cuja mensagem final não traz valor deve registrar o último `Novo lance … recebido` do mesmo lote no log; `Lance inicial` é preço de abertura e não conta como lance.
- A sessão exibida em `/live-audit` deve ser escolhida automaticamente uma única vez (URL, primeira resposta da ponte ou seletor) e permanecer fixa; abas de leilões diferentes abertas ao mesmo tempo não podem alternar a tela entre as sessões.
- Códigos de lote ou leilão compostos só de zeros (`0`, `000`) são placeholders da página e devem ser tratados como ausentes na extensão e no Bot, sem gerar chave local, URL de veículo ou identidade de observação.
- Na Sodré, uma leitura cujo código já pertença a outro lote da mesma sessão, ou cujo lote já tenha outro código, deve ser tratada como transição: o lote é identificado apenas por leilão + lote, sem código, foto ou link, e nunca atualiza o lote anterior.
- Nas colunas de log da auditoria, `Não vendido` sem valor na mensagem deve exibir o último `Novo lance … recebido` do mesmo lote; um novo anúncio do lote reabre a evidência, e a ordem dos eventos segue o horário observado (a sequência reinicia quando a extensão recarrega).
- Etapa de lote finalizado sem valor, quando as demais informam valor, deve aparecer como divergente (`Valor ausente em alguma etapa`); FIPE e monta só são exigidas das etapas detalhadas, e as colunas de log devem informar que o chat não publica esses campos.
- Quando o log de um lote não tiver resultado, a etapa deve mostrar o último evento (`Lote anunciado` ou `Último lance no chat`) em vez de um rótulo genérico.
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

## Pestana Leilões

- Disponibilizar `pestana` no catálogo de fontes, no scraper Nuxt, CLI, serviço cloud e painel local, com uma implementação compartilhada no servidor.
- Consultar todos os IDs da categoria Veículos pelo endpoint público usado pelo portal e detalhes em blocos de 24. Paginação de 12 cards é somente visual e não limita a coleta. Deduplicar IDs antes de consultar/emitir; campos desconhecidos permanecem nulos.
- Preservar fotos, marca/modelo/ano-modelo, monta, condição, características, localização do bem, comitente, identidade do lote/leilão e horário brasileiro. Não atribuir a localização da sede do leiloeiro aos veículos.
- Transmitir à ingestão Picareta o status observado, condicional/não vendido e preço final confirmado, sem substituir arremate por lance inicial, sem presumir venda no repasse e sem tratar avaliação como FIPE.
- Salas `/:id/aovivo` precisam estar publicadas no HTML oficial; não converter URL de lote/catálogo em sala. Automação Windows e extensão não passam a acompanhar Pestana nesta implementação.
- CAPTCHA inclusive com HTTP 200, schema inválido, detalhe ausente e cancelamento devem falhar explicitamente. Nuxt preserva dados parciais pelo contrato existente; CLI/cloud mantém a fonte como falha e não publica snapshot completo dessa coleta. Outras fontes continuam normalmente.

## Vardana e Pampa Sul (0.37.0)

- Renovar Vardana com uma única implementação no servidor para Nuxt e CLI/cloud. Descobrir IDs atuais, ler galeria e detalhes públicos, lance exibido e situação sem simular oferta ou autenticação. Corrigir ano-modelo, abreviações Mercedes e horário Brasília. Não inventar preço enquanto constar aguardando avaliação.
- Completar FIPE ausente de Vardana no fluxo CLI/cloud usando provider existente, cache persistente `fipe_cache` por 30 dias quando Mongo estiver configurado, cache em memória e correspondência de ano-modelo exato. Preservar FIPE já publicada e registrar referência/modelo escolhido. Falha FIPE não descarta lote.
- Disponibilizar Pampa Sul (`pampasul`) nos catálogos, filtros, painel Nuxt, painel local, CLI e cloud. Seguir todas as páginas numeradas da categoria Veículos (`cate[]=3`), consultar detalhes e endpoint público de atualização.
- Distinguir lance atual, lance inicial e próximo lance mínimo. Guardar FIPE publicada, galeria, ano-modelo, endereço de exposição, comitente e URL oficial do evento. Somente arrematado confirma vendido; não usar lance inicial como arremate.
- Preservar resultados parciais com erro explícito se uma página/lote não puder ser coletada, sem fingir snapshot completo. Cancelamento não continua emitindo veículos.
- Não interpretar encerramento da Pampa Sul como início de transmissão nem ampliar automaticamente as fontes do worker Windows/extensão.

## Taxas Pampa Sul (0.37.1)

- Estimar comissão de 5% do lance considerado e pátio de R$ 800 para `pampasul`, sem DSAL, logística ou taxas operacionais de outras fontes. Usar preço atual, simulado ou vendido, preservando centavos; não usar o próximo lance mínimo exibido pelo portal.
- Exibir o total com taxas no card e nas mensagens; discriminar comissão/pátio nos resultados de favoritos. Sem preço válido não gerar estimativa. Manter as regras das demais fontes e os critérios históricos de envio ao grupo.

## FIPE manual na extensão (0.38.0 / extensão 0.26.0)

- Calcular margem e percentual do total com FIPE digitada mesmo sem FIPE original ou histórico disponível. O assistente aceita `feesOnly: true` para estimativa autenticada pela regra compartilhada, sem consultar veículos/histórico nem registrar captura nessa consulta financeira.
- Digitar simula; `Salvar FIPE` ou o disquete confirma a FIPE no lote, usando a ingestão e sincronização existentes. Não salvar o lance simulado. Resultados posteriores usam a FIPE confirmada e preservam as regras de opt-in/favoritos do WhatsApp.
- Vincular taxas e FIPE manual à identidade completa do veículo. Restaurar a edição confirmada da captura local ao reabrir; cancelar salvamento quando o veículo mudar durante a leitura. Impedir duplo clique, indicar progresso/falha e distinguir aceite do Bot de sincronização com Picareta.
