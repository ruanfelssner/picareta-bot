# Extensão Pestana ao vivo

Versões: bot-anuncios **0.47.0**, Picareta **0.178.0**, extensão **0.28.0**.

## Uso e contrato

Após publicar os dois backends, atualizar/recarregar `.extension/copart-live-collector` e abrir uma sala oficial `https://www.pestanaleiloes.com.br/agenda-de-leiloes/:id/aovivo`, o painel existente oferece login e acompanhamento do lote. A extensão observa a página aberta; não envia lances, não percorre a lista lateral e não recupera eventos anteriores à coleta. Usuários comuns autenticados seguem a coleta automática; administradores podem ativá-la pelo painel.

`#loteHeader` fornece número, título, UF e comitente; `.carateristica-item` fornece marca/modelo/versão, ano/modelo, monta, condição e categoria. A galeria central fornece a foto. O lance é o valor da linha `.numeroLanceVencedor`, não a próxima oferta, o inicial nem o total com taxas. Na amostra Audi: lote 1, SC, 2013/2014, **R$ 43.900,00**; a oferta de R$ 44.400,00 e o total de R$ 48.970,00 são ignorados como preço. FIPE só é lida quando explicitamente identificada; o enriquecimento existente continua disponível.

O DOM não publica o ID global. `pestana-live-identity.ts` consulta por GET público `/api/v2/lote/por-leilao?idLeilao=:id` e valida número, leilão, visibilidade, tipo automotivo e título. O lote 1 do leilão 6262 resolve para 443168, com link `/agenda-de-leiloes/6262/443168`. Cache de dois minutos, máximo vinte leilões, timeout de quinze segundos. Não reutilizar o número do lote como ID global. Indisponibilidade/ambiguidade bloqueia a ingestão com `identidade_pestana_indisponivel`, mantendo a captura local para nova tentativa de Sync. Identidades já confirmadas são memorizadas por leilão/lote/título sem trocar a chave local.

Somente resultados explícitos da área atual confirmam fechamento: `Este lote foi vendido!`, `Este lote está pendente de homologação!` (condicional) e `Este lote não foi vendido!`. O rótulo `Lance atual` não é resultado. Repasse, encerramento, cancelamento e retirada não confirmam arremate. Na tela final sem histórico o parser retorna lance nulo; o merge local mantém a observação anterior, sem converter inicial/oferta em preço final. Mudanças de título/características e identidade passam pelos controles de estabilização.

Observações de abertura/lance/resultado vão pelo protocolo `LIVE_AUCTION_LOG_EVENTS` ao IndexedDB/outbox existente, com deduplicação e confirmação local antes de avançar a sequência. Não coletar nomes de licitantes. Ingestão, análise, histórico, arquivo, auditoria, ignorados e sincronização aceitam `pestana`; filtros de UF/categoria/monta continuam aplicados. O arquivo `data/.aovivo-pestana.html` é somente referência local: não inventa ID de leilão e, sozinho, não libera captura final.

## Validação

As fixtures `tests/fixtures/pestana-public-live.html` e `pestana-live-identities.json` são recortes sanitizados do HTML fornecido e do catálogo público. As mensagens finais foram conferidas no bundle público do portal e testadas com mutações sintéticas: a amostra original está em andamento. Testes cobrem lotes laterais, preço, ausência de preço, transições, filtros, identidade/URLs, HTTP/JSON inválido, ambiguidade e retry da auditoria. Nenhum teste escreve em produção ou envia WhatsApp.

Com dependências já disponíveis:

- `node --test tests/*extension*.test.mjs tests/live-auction-financial-race.test.mjs`
- `pnpm exec tsx --test tests/pestana-live-identity.test.ts tests/pestana-scraper.test.ts tests/pestana-url.test.ts tests/live-auction-reconciliation.test.ts tests/live-auction-archive.test.ts tests/auction-schedule.test.ts tests/live-assistant-lot-identity.test.ts`

O teste real de login, troca de lote e arremate de ponta a ponta permanece necessário após publicar/recarregar a extensão. A implantação exige os contratos Pestana também no Picareta. Consulte `/historico-leiloes-publico?tab=extraction&sources=pestana`. Não houve alteração da automação Windows para abrir esta fonte.

Nesta implementação passaram 97 testes da extensão/fluxo financeiro e 61 do backend; o Picareta passou outros 26 testes. Typechecks isolados dos helpers, tipos, scraper e testes direcionados passaram. A ingestão foi exercitada em memória com o normalizador real e catálogo simulado, conferindo ID, URL, hash estável, preço, ausência de preço e filtros, sem Mongo/WhatsApp. O Chromium disponível não inicia por falta de `libnspr4.so`; a revisão visual da integração e a validação autenticada no pregão real continuam pendentes. Não houve instalação ou substituição de dependências locais.

## Correção de taxas e margem — bot 0.47.1 / extensão 0.28.1

A Pestana não tinha estimativa de taxas e por isso o painel deixava margem e total indisponíveis. `readPestanaPublishedFees` agora lê a cotação de `#content-leilao-live .right .valor-total-taxas` e suas linhas irmãs, sem depender dos nomes de classes gerados. Confere Lance + Comissão + Despesas Operacionais = Valor a ser pago e extrai `publishedFees: { commissionRate, operationalExpenses }`. A comissão é proporcional à cotação do formulário, que pode representar a próxima oferta; o preço continua vindo do histórico vencedor. Despesas não são fixadas em R$ 2.350 para todos os lotes.

O endpoint `live-assistant` valida esses termos e os usa tanto em `feesOnly` quanto na análise completa. A regra compartilhada calcula somente comissão e despesas publicadas; não usa DSAL, logística ou outros custos presumidos. A simulação da extensão conserva os termos do lote e recalcula comissão e total ao variar o lance. Mudança de termos invalida assinaturas de preview/análise/taxas/captura local, impedindo reapresentar resposta antiga. Termos observados ficam na sessão por pregão/lote/descrição e no evento local; não há nova persistência de condições financeiras no cadastro global nem mudança dos custos personalizados do Picareta.

R$ 15.300 + comissão 5% (R$ 765) + despesas R$ 2.350 = **R$ 18.415**. Para o print com lance R$ 18.000 e FIPE R$ 35.944: comissão R$ 900, total **R$ 21.250**, margem **R$ 14.694**. Sem FIPE, a margem permanece indisponível; sem termos completos e válidos, as taxas permanecem indisponíveis. Margem negativa continua visível. O tooltip de Valor total mostra comissão e despesas.

Validar também com `pnpm exec tsx --test tests/pestana-fees.test.ts tests/pampasul-fees.test.ts`, além da suíte da extensão acima. Publicar o bot e recarregar/atualizar a extensão; não basta atualizar só o manifesto. O teste autenticado na sala real continua pendente.

Validação desta correção: **107 testes aprovados** (100 da extensão/fluxo financeiro e 7 das taxas Pestana/Pampa Sul), sintaxe do content script e TypeScript isolado do cálculo compartilhado/testes. O teste do renderer confirma total R$ 21.250 e margem R$ 14.694 com FIPE de referência e impede reapresentar taxas antigas após mudar as despesas. Não houve deploy, consulta à base real, envio de WhatsApp ou instalação de dependências. A validação visual em Chrome real continua pendente pela limitação de Chromium já descrita acima.

Na extensão **0.28.2**, mudanças de código/FIPE/taxas não invalidam mais a análise completa: somente a consulta rápida das taxas acompanha alterações de seus termos. A análise usa uma identidade estável do lote, aguarda a estabilização e compartilha consultas repetidas. Consulte [18-extensao-analise-por-lote.md](18-extensao-analise-por-lote.md).
