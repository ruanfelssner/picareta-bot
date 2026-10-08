# FIPE manual na extensão — bot 0.38.0 / extensão 0.26.0

O resumo agora calcula margem e percentual do total com a FIPE digitada enquanto o histórico é consultado. As taxas vêm do próprio backend, pelo modo autenticado `feesOnly: true` de `/api/vehicles/live-assistant`; não há segunda tabela de taxas no cliente. O histórico continua sendo necessário para médias/recomendação, mas não para `margem = FIPE − lance − taxas` e `% = total / FIPE × 100`.

Digitar é apenas simulação. `Salvar FIPE`, exibido ao lado da simulação, ou o disquete `Salvar lote` confirma a FIPE pela ingestão existente e sincroniza o lote com Picareta. O lance digitado para comparação continua sendo apenas simulação: o salvamento sempre usa o lance real da leitura atual. A mensagem de salvamento diferencia aceite no Bot, sincronização pendente no Picareta e falha; a simulação só é encerrada quando o Bot aceita o lote.

Após salvar, a FIPE confirmada segue nas capturas de resultado da mesma identidade. O marcador local `fipeManual` restaura esse valor da captura confirmada ao reabrir a página; a troca de veículo e o descarte da lista local não transfere essa edição para outros lotes. O valor salvo no banco continua no campo `fipe`, pela ingestão normal, sem adicionar esquema ou credenciais.

Salvar um lote ainda aberto não envia mensagem de resultado. Ao finalizar, o WhatsApp usa a FIPE persistida, taxas, total, margem e percentuais, respeitando o opt-in daquele lote e o fluxo já existente para favoritos. Uma mensagem já enviada não é reenviada automaticamente apenas por editar FIPE. O cálculo do resumo/resultado não inclui transferência ou reparos cadastrados separadamente no Picareta.

No exemplo de lance de R$ 197.500 e FIPE de R$ 336.000 para automóvel Sodré, com as taxas estimadas existentes (5%, DSAL, operacionais e logística), total = R$ 212.635, margem = R$ 123.365, percentual do total = 63% e percentual do lance = 59%.

Atualizar backend e extensão; o Picareta passa para 0.170.2 para registrar o requisito. A release do Picareta é patch silenciosa, sem nova entrada em `APP_UPDATE_RELEASES`; bot e extensão recebem releases minor por acrescentar o salvamento explícito da FIPE. Validação usa serviços externos simulados; nenhum lote real ou mensagem ao grupo é criado pelo teste.
