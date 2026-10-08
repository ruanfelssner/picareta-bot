# Dependências dos testes da extensão no CI — bot 0.40.1

O workflow `.github/workflows/chrome-web-store.yml` preparava o Node.js e executava a suíte sem instalar módulos. Os testes mais recentes de FIPE usam `typescript` para transpilar regras e rotas reais do backend; os de lote Sodré usam `cheerio` para ler o HTML da fixture. Ambos já estão declarados no `package.json` e resolvidos em `pnpm-lock.yaml`.

O job `validate_package` agora prepara pnpm pela versão de `packageManager` e executa `pnpm install --frozen-lockfile --ignore-scripts --prod=false` antes da suíte. Isso inclui dependências de desenvolvimento, mantém o lockfile e evita `nuxt prepare`/scripts de instalação. A instalação acontece apenas no runner GitHub Actions; nenhuma instalação local é necessária para aplicar esta correção.

Os filtros de pull request/push incluem também `package.json`, `pnpm-lock.yaml` e a fixture `tests/fixtures/sodre-public-detail.html`. Mudanças dessas entradas passam pela validação e empacotamento já existentes. O ZIP continua sendo gerado somente a partir de `.extension/copart-live-collector`, sem dependências do servidor ou dos testes.

O fluxo de publicação e suas condições permanecem os existentes. A correção do job não muda o manifesto da extensão: bot 0.40.1, extensão 0.27.0. Para usar a correção, executar o workflow no commit que contém a mudança; repetir um job de um commit anterior usa a configuração anterior.

Validação local com dependências já disponíveis: `node --test tests/*extension*.test.mjs tests/live-auction-financial-race.test.mjs`. A suíte inclui uma verificação de que a preparação/instalação ocorre antes dos testes, com as dependências de desenvolvimento presentes. A execução real do GitHub Actions e a publicação na loja são verificadas no runner após enviar o commit.
