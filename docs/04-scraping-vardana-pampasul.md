# Vardana e Pampa Sul — 0.37.0

## Vardana

Descoberta: `https://www.vardanaleiloes.com.br/vardana/index`, extraindo links `veiculos.php?lei=...`. O override existente `VARDANA_LEILAO_IDS` permanece opcional; não há fallback para leilões antigos. A lista “Relação em breve” é um vazio legítimo.

Lotes: `/vardana/veiculos.php?lei=:id`. Identidade: argumentos de `openWindow(lei, lote, cov)` e URL pública `https://vardana.com.br/veiculo-detalhes-logado?lei=:id&_id=:lote&cov=:veiculo`.

Consultas públicas somente leitura: POST `controller/lote/lote.controller?acao=atualizaInformacoesLote` com `codigo`/`leilao`; POST `botoes_lance.php` com `codigo_veiculo`/`leilao`. Galeria: campos `img1` a `img12`. O lance é `#teste`, não o input para ofertar. “Aguardando avaliação” não é um resultado e mantém preço nulo. Nenhum endpoint de oferta/login é usado.

FIPE: adapter CLI/cloud chama helper backend para ler cache de 30 dias e consultar o provider configurado. Exige o ano-modelo exato, não preenche por ano vizinho. Dados/modelo escolhidos ficam registrados; falhas não descartam o lote. Nuxt reutiliza o enriquecimento já existente do runner.

## Pampa Sul

Descoberta: `https://leiloespampasul.com/lotes/?cate[]=3`; o parâmetro `pag` começa em 1 para a segunda página. Seguir todos os links numerados, pois “Próximo” pode pular páginas. IDs são deduplicados.

Detalhes: `/lote/:slug/:id`. Características: `.ls-info-item`, galeria `.ls-lote-gallery` e endereço `.box__11`. Evento: link “Voltar ao leilão” em `.ls-lote-rodape__btn`. Não usar fotos/preços de cards relacionados.

Consulta pública POST `/app/Ajax/Leiloes/atualizar_leiloes.php`, com `leiloes`, `lotes` (IDs separados por hífen), `lote` e `pg`. Exige Referer, Origin e X-Requested-With. Retorno `item/:id`: `box_id` confirma identidade, `lance.atual` é atual, `lance.ini` é inicial e `situacao` informa resultado. Não consultar endpoints de ofertas.

Encerramento é capturado em Brasília em `auctionEndsAt`; não constitui início confirmado de transmissão. Monta ausente continua desconhecida. Não atribuir à Pampa Sul taxas DSAL de outro leiloeiro.

## Validação

Em 08/10/2026, a coleta pública de leitura retornou 68 veículos Vardana com imagens (sem avaliação publicada) e 130 veículos Pampa Sul em cinco páginas, todos com fotos, lance, FIPE e localização do bem. FIPE pública de amostras Vardana correspondeu a GLA 200 ano 2018, Sprinter 416 ano 2022 e Bora ano 2001. Testes usam fixtures públicas reduzidas e simulação de falhas; não persistem lotes nem enviam mensagens.

## Estimativa de taxas — 0.37.1

Regra pública conferida em 08/10/2026 no [lote BMW 2878](https://leiloespampasul.com/lote/BMW-SERIE-3-21-21-Pampa-sul-Leiloes/2878/): comissão de 5% e pátio de R$ 800. Para lance atual de R$ 88.900, taxas = R$ 5.245 e lance + taxas = R$ 94.145. A comissão de R$ 4.495 na simulação informada corresponde ao próximo lance mínimo de R$ 89.900, não ao lance atual.

`shared/utils/auction-fees.ts` centraliza o cálculo para cards, formatters e análise de mercado. `VehicleFeeEstimate.yardFee` é opcional e preenchido para Pampa Sul; os campos DSAL, logística e operacionais são zero para essa fonte. Resultados de favoritos discriminam comissão e pátio. Não há alteração na coleta, persistência ou critérios de envio automático ao grupo.
