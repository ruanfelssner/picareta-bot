# Análise única por lote na extensão

Correção: bot-anuncios **0.47.2**, Picareta Smart Assistant **0.28.2**. Picareta **0.178.2** recebe documentação/versionamento, sem nova entrada no modal PWA.

## Problema e comportamento

Na troca de lote, a Pestana carregava a análise, limpava o painel e carregava outra vez. O problema também podia ocorrer nas demais fontes da extensão: a assinatura da análise incluía lance presente/ausente, FIPE, código, URL e taxas. Esses campos chegam em momentos diferentes. Na Pestana, a resolução do ID oficial também reiniciava a estabilização. Havia ainda um cancelamento do timer antes de verificar se a consulta daquele lote já estava agendada, deixando a análise pendente sem timer ativo.

Agora a consulta completa de histórico/FIPE/análise é identificada por **fonte + leilão + número do lote** na sala ao vivo. Código ou URL identificam páginas/leituras sem esse par. Leituras em transição (`captureReady: false`) ou sem marca/modelo aguardam os dados do lote. O preview acompanha a mudança de estado de estabilização mesmo quando ainda não há lance.

Depois de carregar com sucesso, a análise permanece durante o acompanhamento daquele lote. Chegada do ID global/link, FIPE, foto, situação, taxas ou novo lance não limpa o histórico nem repete a consulta completa. Lance atual, FIPE publicada/de referência/simulada e condições de taxas alimentam os cálculos reativos existentes de margem, total, percentual e comparação com a média. O último lance efetivo observado é preservado quando o portal remove o histórico ao mostrar o resultado, sem voltar ao valor inicial retornado pelo assistente.

## Consultas, cache e isolamento

- Leituras repetidas compartilham a consulta já agendada ou em andamento. O timer lê o snapshot mais recente, sem reiniciar a cada mutação.
- Um cache em memória conserva até **200 análises** bem-sucedidas na aba. Retornar a um lote reaproveita o resultado; retornar com a consulta ainda pendente compartilha a requisição original. Após expulsão do cache, recarregar a página ou sair da conta, uma nova análise pode ser necessária.
- Fonte, leilão e lote são isolados. Respostas atrasadas podem preencher o cache do lote correspondente, mas nunca substituir o lote atualmente aberto.
- Sair da conta limpa cache/pendências e invalida respostas em trânsito. A recaptura explícita Copart pode forçar uma análise nova após atualizar a base.
- Falhas não viram análises bem-sucedidas no cache: a coleta pode tentar novamente após quinze segundos, preservando a mensagem de erro entre as leituras.

As taxas usam uma assinatura separada da análise. A consulta rápida `feesOnly` pode ocorrer no primeiro lance válido ou quando mudam as características/condições usadas nas taxas. Ela não consulta o histórico nem reinicia a análise. Na Pestana, a consulta rápida aguarda uma cotação publicada; comissão/despesas são as descritas em [17-extensao-pestana-ao-vivo.md](17-extensao-pestana-ao-vivo.md). Cada lance posterior usa cálculo local, sem nova requisição por mudança de valor. A assinatura das taxas da resposta completa é conferida para impedir o reaparecimento de despesas antigas enquanto a consulta rápida é atualizada.

O cache trata os dados de análise como um snapshot da consulta. Alterações posteriores da base/histórico não são sincronizadas continuamente nessa aba; recaptura explícita ou uma nova sessão permite obter dados novos. Captura local, auditoria, salvamento e sincronização final continuam pelos fluxos existentes.

## Validação

`tests/extension-analysis-lifecycle.test.mjs` exercita o código real com relógio e transporte simulados: Pestana, Copart, Sodré e VIP, transição sem lance, eventos duplicados antes e durante a consulta, metadados tardios, retorno ao lote, respostas fora de ordem, isolamento por fonte/leilão, recaptura explícita, logout e retry de erro. Os testes de Pestana verificam o renderer, taxas reativas e o último lance no fechamento. Não há requisições reais, gravação na base ou envio de mensagens.

Com dependências já disponíveis: `node --test tests/*extension*.test.mjs tests/live-auction-financial-race.test.mjs`.

Para usar, atualizar/recarregar a extensão **0.28.2** em `chrome://extensions` e recarregar a sala. Prints da versão **0.28.0** não incluem esta correção nem a correção anterior das taxas (**0.28.1**). A revisão visual e o teste autenticado na sala real continuam pendentes neste ambiente, cujo Chromium não inicia por falta de `libnspr4.so`.

Validação local: **112 testes aprovados** na suíte da extensão/fluxo financeiro, incluindo os doze cenários novos de ciclo da análise; checagem de sintaxe do content script e dos testes aprovada. Não houve deploy, instalação de dependências, gravação em produção ou envio de mensagens.
