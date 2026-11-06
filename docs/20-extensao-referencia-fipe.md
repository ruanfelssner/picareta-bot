# Referência FIPE e média real ao vivo

Bot 0.47.5 / extensão 0.28.4, 06/11/2026. Correção do caso Sodré Gol 1.0 2010 com FIPE vazia apesar de evidência na Copart. O plano de alertas antecipados não integra esta entrega.

## Correspondência

`live-assistant.post.ts` inclui versão, título, descrição, fonte e URL na consulta de referência. A identidade semântica em `shared/utils/vehicle-reference-identity.ts` separa família, motor, combustível, câmbio, geração, carroceria/portas e acabamento. Distingue Gol de Golf, 1.0 de 1.6, versões comerciais e códigos como Atego 2430/1726. Repetição de cilindrada não altera o motor. BMW Série 3/320i têm alias controlado e motorização explícita 330e/328i continua distinta.

O seletor descarta inconsistências e o próprio anúncio; campos desconhecidos reduzem preferência. Prioriza a configuração mais próxima, depois a captura mais recente dessa configuração; entre configurações igualmente próximas, usa a menor referência. A FIPE inferida continua apenas na análise, com `fipeOrigin: database_reference`, ícone e tooltip incluindo modelo, ano, origem, data da observação e URLs compatíveis. Informação ausente não comprova a versão exata. O valor manual/publicado/exato conserva prioridade; não há chamada externa nem gravação automática da referência.

O Gol auditado retorna R$ 25.741 da Copart (observação 04/11/2026, 14 URLs da configuração `Gol 1.0 1.0 Total Flex`). Trata-se de referência capturada; código/mês oficial ausentes não são inventados.

## Contrato de análise ao vivo

`loadMarketHistory(true)` inclui vendidos e condicionais sem exigir FIPE. O novo `buildLiveVehicleMarketAnalysis` usa preço real `soldPrice ?? price`, a partir de uma venda, com identidade compatível, prioridade ano/fonte/monta e deduplicação URL/ocorrência. Retorna `comparisonMode: value`, `averageValue`, `conditionalAverageValue`, percentuais nulos quando não há FIPE, quantidade e base. Não usa grupos genéricos de outros modelos. O analisador legado das outras telas permanece com o contrato anterior.

O renderer prefere os valores reais quando recebidos e aceita respostas antigas por percentual como fallback. Mudar FIPE simulada recalcula apenas percentuais/margem, sem mover a média histórica em reais. Uma venda recebe o rótulo Última R$ e a quantidade é explícita. Taxas, prioridade de FIPE manual, isolamento entre lotes e fluxos de captura/favorito seguem existentes.

## Validação e publicação

Testes: seletor e conflitos em `tests/live-assistant-fipe-reference.test.ts`; API e médias sem FIPE em `tests/live-reference-analysis.test.mjs`; renderer, simulação e informação de origem em `tests/pestana-live-extension.test.mjs`; regressão das suítes de extensão/conta/captura/taxas/favoritos. O teste da API usa a rota real com banco, autenticação e captura simulados; não escreve em produção nem envia mensagens.

Comandos recomendados no ambiente configurado:

```sh
pnpm exec tsx --test tests/live-assistant-fipe-reference.test.ts
node --test tests/*extension*.test.mjs tests/live-auction-financial-race.test.mjs tests/favorite-lot-result.test.mjs tests/live-reference-analysis.test.mjs
```

Publicar Bot e atualizar a extensão em chrome://extensions/loja; recarregar a sala ou recapturar explicitamente para renovar cache local do lote. Não houve deploy nesta execução. O Picareta acompanha documentação/requisitos em 0.179.4, patch silenciosa.

Resultado: 137 testes aprovados (128 da extensão/API/renderer e nove do seletor); typecheck estrito focado nos três módulos de identidade/referência/análise sem erros. Prévia do renderer real validada em Chromium a 390 e 1440 px sem overflow, com valor FIPE completo. Node 18 do agente exigiu `--experimental-global-webcrypto` nas suítes e transpilation com TypeScript já instalado para o teste `.ts`; não houve instalação/alteração de node_modules. Build completo e pregão autenticado dependem do ambiente configurado com Node compatível.

Auditoria retrospectiva, sem escrita: de 300 veículos Copart versionados, 241 receberam referência, excluindo o próprio URL e observações futuras. Dessas referências, 212 ficaram em ±5% e 227 em ±10% do valor capturado conhecido, com mediana de erro 0,69% e percentil 90 6,99%. Os dados capturados não substituem conferência oficial por código/mês; o teste não garante precisão em todo veículo nem representa toda a base.


## Aliases de acabamento Virtus — Bot 0.47.6

O comparador por características reconhece HL/Highline, CL/Comfortline e TL/Trendline no Virtus e ignora os sufixos cadastrais AC/AD/AB na comparação do acabamento, sem usá-los para inferir motor ou câmbio. Exige o mesmo ano-modelo e continua recusando versões conhecidas conflitantes. O teste do seletor cobre HL AC 2026 contra versão Highline Copart, recusa Comfortline e recusa 2025. Esta correção é no backend; manifesto da extensão permanece 0.28.4. Picareta acompanha as mudanças de Oportunidades em 0.179.5. Sem publicação nesta execução.
