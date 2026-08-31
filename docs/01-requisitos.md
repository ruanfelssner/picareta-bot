# Requisitos

## Busca local no Facebook Marketplace

- A tela `/marketplace` deve permitir iniciar uma busca local no Facebook Marketplace.
- Os últimos 8 termos iniciados pelo usuário devem ser salvos somente no armazenamento do navegador.
- Termos repetidos devem voltar para o início do histórico sem criar duplicatas.
- O usuário deve poder reutilizar um termo, removê-lo individualmente ou limpar todo o histórico.
- Resultados da busca, sessão do Facebook e credenciais não devem ser salvos nesse histórico.

## Extensão de leilão ao vivo

- A extensão deve manter disponível o salvamento manual mesmo quando a ação de atualizar/recapturar estiver presente.
- O usuário deve poder salvar um lote ainda sem resultado final; quando o resultado for capturado, o mesmo lote deve ser atualizado automaticamente.
- A lista de lotes capturados deve oferecer busca por veículo/lote/código, filtros por situação e por divergência entre o valor da mensagem e o lance, além de ações compactas para dados, atualizar novamente, salvar, excluir, abrir o link do veículo e reprocessar somente os itens exibidos.
- A ação de reprocessamento deve ficar visível e informar a quantidade de lotes que será atualizada conforme os filtros ativos.
- O filtro de lotes capturados deve informar a quantidade de itens atualmente exibidos após busca e filtros.
- Salvamentos, atualizações e recarregamentos da lista não devem alterar a posição atual do scroll.
- O painel da extensão deve poder ser reposicionado por arraste e preservar sua posição por fonte.
- O espaço reservado da análise IA e a caixa de lotes capturados devem permanecer compactos e estáveis para evitar mudanças constantes de layout.
