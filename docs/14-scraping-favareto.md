# Coleta Favareto — 0.44.5

## Diagnóstico de 26/10/2026

O problema relatado foi `Favareto: 0 novos · 0 encontrados`. A página pública não estava vazia:

- `/leiloes/` anunciava os editais 1651 e 1652 por links relativos `edital/<id>` dentro de `ul#info-leilao`.
- `/edital/1651/` entregou 244 linhas com `tela_lance(1651, seq)`; `/edital/1652/`, outras 69.
- O coletor CLI/cloud existente na versão local 0.44.4 concluiu com **313 lotes**, sem MongoDB nem envio de mensagens. O catálogo inclui veículos e equipamentos agrícolas.
- O `/health` informado pelo solicitante retornou `ok`, `service`, `activeRunId` e `host`, mas **não retornou `version`**. O código local de `src/cloud-service.ts` inclui esse campo desde 0.44.3. Isso aponta para imagem/processo antigo ou endpoint de outra instância, e impede atribuir o zero de produção ao parser atual.

### Log de produção recebido depois da coleta local

O solicitante enviou o erro `HTTP direto falhou (... HTTP 403 ... bloqueio anti-bot) e o navegador também falhou: Desafio anti-bot não foi concluído pelo navegador`. Esse log confirma que o caminho com fallback já está em execução e que o acesso do serviço é recusado nas duas tentativas: o HTTP recebe 403 e o Chromium não conclui o desafio. Portanto, a hipótese anterior de versão antiga, baseada somente no `/health` sem versão, não explica sozinha a execução mais recente.

O bloqueio anti-bot nesse ambiente está confirmado; o motivo específico da decisão do WAF (IP, rede de datacenter, fingerprint ou combinação) não está. A coleta local de 313 lotes comprova o funcionamento da leitura nessa rede, sem garantir o acesso pela rede do serviço.

A correção operacional pendente é obter uma origem de acesso aceita: liberação do serviço/IP com a Favareto ou execução da coleta em uma máquina/rede autorizada que consiga acessar o site. Um eventual proxy também precisa ser validado nessa origem antes de ser incorporado. Nenhuma dessas alternativas foi configurada nesta implementação. A versão 0.44.5 melhora a consistência dos coletores, os dados e os diagnósticos; **não demonstra que o bloqueio de produção foi resolvido**.

## Falhas confirmadas no código

A implementação Nuxt ainda aceitava HTML com título Favareto e nenhum link de edital como lista vazia legítima. Ela também não tinha a recuperação pelo navegador da implementação CLI/cloud. Os dois coletores aceitavam editais sem linhas reconhecidas quando não encontravam o padrão `tela_lance`, podendo encerrar sem diagnóstico. O bot/cloud descartava campos disponíveis como número do lote, combustível e comitente.

## Implementação

`layers/scrapers/server/utils/sources/favareto.ts` passa a concentrar a coleta HTTP e a recuperação Chromium, exportando `favaretoSource` e `runFavaretoScraper`. `src/scrapers/favareto.ts` adapta o resultado para `AuctionVehicle`, seguindo o padrão das fontes Pestana/Vardana. Não existe coleta no cliente.

1. Buscar `/leiloes/`, normalizar links relativos/absolutos do mesmo domínio e deduplicar por edital.
2. Ler todos os editais descobertos; não limitar aos três primeiros. Recuperar as linhas da tabela mesmo com o HTML malformado do site e associar o cabeçalho `td.grupo` aos lotes seguintes.
3. Consultar `POST /classes/json_lance.php` com `ordem=<seq>&leilao=<editalId>` e Referer `/lance/<editalId>/<seq>/`.
4. Consultar `POST /classes/json_historico.php` com `seq`, `data=<editalId>` e `dataleilao=<data pública>`.
5. Selecionar preço do histórico (`top_lance`, `lance_atual`, `of1`), depois tabela do edital, depois `minimo`. Falha somente do histórico não descarta o lote. Campo `grupo` do detalhe fornece comitente, com fallback para o cabeçalho do edital.
6. Emitir `auctionId`, `auctionUrl`, `lot`, `consignor` e `fuel`, além dos dados já coletados. Deduplicar pela URL individual do lote. Aceitar anos de fabricação anteriores a 2000.

HTML é decodificado como windows-1252. reCAPTCHA e o script passivo JSD do Cloudflare não identificam por si só uma página de bloqueio. Rede, HTTP não 2xx, desafio, ausência de editais ou nenhum edital legível acionam a nova tentativa pelo navegador; falha dos dois caminhos lança erro contendo os dois diagnósticos. O navegador é encerrado no `finally` e respeita cancelamento. Não há login, envio de lance, alteração de credenciais ou instalação de dependências.

## Validação e publicação

Testes com fixtures públicas reduzidas e transporte simulado cobrem as entradas CLI/cloud e Nuxt: descoberta e deduplicação, campos do lote/comitente, preço, fotos, encoding, script JSD, recuperação pelo navegador, fechamento da sessão, cancelamento e falhas explícitas.

```bash
pnpm exec tsx --test tests/favareto-scraper.test.ts
pnpm build
```

Os 18 testes passaram. A coleta real após a alteração também trouxe 313 lotes, com número de lote, comitente e combustível preenchidos no primeiro registro conferido. O `tsx` Linux deste workspace não executa porque `node_modules` contém esbuild de Windows. Os testes e a coleta real foram executados com o Node 22 e as dependências Windows já instaladas, sem modificar `node_modules`. A verificação TypeScript dos arquivos alterados não encontrou erros nesses arquivos; as dependências importadas produziram 30 diagnósticos em outros arquivos, portanto não representa um typecheck global aprovado. Build completo não executado.

Após publicar a imagem do **bot-anuncios**, conferir `GET /health`: deve retornar `version: "0.44.5"`. Executar somente Favareto em `/scraping-cloud` e verificar os logs por edital e o total encontrado. Esse teste em produção ainda é necessário; a validação local não prova que o IP de saída do serviço recebe a mesma resposta. A versão é patch, sem entrada em `APP_UPDATE_RELEASES`.

## Teste gráfico no Railway — 0.45.0

O solicitante confirmou que o serviço usa Docker no Railway. O diagnóstico opcional passa a permitir ver e operar manualmente o navegador no mesmo container e reutilizar essa sessão na coleta, com perfil em volume e acesso remoto autenticado. Ativação e limitações em [15-favareto-navegador-railway.md](15-favareto-navegador-railway.md). A disponibilidade em produção ainda depende do teste no Railway.
