# Teste da Favareto com navegador gráfico no Railway — 0.45.1

## Objetivo

Conferir e, quando possível, concluir manualmente a verificação da Favareto no mesmo container e navegador que executarão a coleta. Não transferir cookies de um PC para o servidor. O modo é ativado explicitamente para o teste. Isso não garante que o Cloudflare aceitará o acesso do Railway nem que uma sessão continuará válida indefinidamente.

## Ativar no serviço existente do bot

1. Publicar este código do **bot-anuncios** usando o `Dockerfile` da raiz e o comando padrão `pnpm start:combined`. Não usar somente `pnpm start:scraper`: o gateway público e o navegador são iniciados pelo comando combinado.
2. No Railway, definir `FAVARETO_BROWSER_DEBUG=1` para o teste. A senha da tela será a `SCRAPER_SERVICE_KEY` já configurada. Se essa chave não existir ou estiver vazia, a tela aceitará a senha padrão **`favareto-debug`**, conforme solicitado. Não colocar senhas em links. Como o fallback é conhecido, o diagnóstico permanece desligado por padrão; desligar após o teste ou configurar uma chave própria.
3. Anexar um **Volume** ao mesmo serviço, com mount path `/data`. Se já existir um volume em outro caminho, ele pode ser mantido: o runtime lê `RAILWAY_VOLUME_MOUNT_PATH` automaticamente e grava na subpasta `favareto-browser`. Sem volume, o teste funciona, mas o perfil pode ser perdido no redeploy. Não copiar o perfil para o Git ou a imagem Docker.
4. Aplicar as alterações/redeploy. Conferir `GET /health`, que deve informar `version: "0.45.1"`. Nos logs, aguardar `[browser-debug] Navegador gráfico iniciado`.
5. Abrir **`https://picareta-bot.felss.dev/internal/browser/`**, ou o domínio HTTPS que aponta para esse mesmo serviço. Na autenticação do navegador, usar usuário **`favareto`** e senha igual ao valor de **`SCRAPER_SERVICE_KEY`**, ou **`favareto-debug`** se a chave não estiver configurada. A conexão do noVNC será iniciada automaticamente. A senha é solicitada pela autenticação HTTP, não pelo formulário de senha VNC.
6. Na tela remota, conferir a página `/leiloes/`. Se o site solicitar uma ação humana, concluí-la manualmente. Deixar essa página aberta com os links `VISITAR LOTES` visíveis. Se mudou de página, voltar para `https://www.favaretoleiloes.com.br/leiloes/` pela barra do navegador remoto.
7. Na tela `/scraping-cloud` do Picareta, executar somente **Favareto**. O log deve informar `Diagnóstico gráfico ativado` e `Usando navegador gráfico do container`; a coleta consulta detalhes e histórico na própria sessão exibida, sem tentar o HTTP direto primeiro.
8. Registrar o resultado: quantidade de editais/lotes, erro completo, título e código de navegação. O status autenticado fica em **`/internal/browser/status`** no domínio do bot. Na investigação anterior, a coleta local trouxe 244 lotes do edital 1651 e 69 do 1652; os totais podem mudar conforme o catálogo.

O volume preserva dados locais do navegador, mas não garante que o site aceitará a sessão após mudar a instância/IP ou depois da expiração. Para desligar o navegador/acesso remoto e voltar ao transporte anterior, remover `FAVARETO_BROWSER_DEBUG` ou definir `0` e fazer redeploy. O Docker tem padrão `0`. O perfil permanece no volume, mas não é utilizado pelo modo normal. A tela remota é administrativa e não deve ser anunciada a usuários comuns.

A senha padrão vale somente para a tela de diagnóstico: não preenche `SCRAPER_SERVICE_KEY` nem habilita chamadas à API do bot. A integração Picareta → bot continua exigindo a chave correta configurada nos dois lados. O controle local do navegador usa um token aleatório gerado pelo processo combinado e transmitido aos subprocessos automaticamente em `FAVARETO_BROWSER_CONTROL_KEY`; essa variável interna não precisa ser cadastrada no Railway.

## Como interpretar o teste

| Resultado | Interpretação e ação |
| --- | --- |
| A listagem abre e a coleta termina com lotes | O ambiente gráfico é utilizável nessa instância. Repetir a coleta na mesma sessão e, em outra etapa, após reinício para verificar duração/persistência. |
| A janela continua no desafio mesmo com ação manual | O teste não resolveu o acesso do Railway. Guardar o erro/Ray ID exibido pelo site e tratar liberação de acesso com a Favareto. |
| A página retorna 401 antes da tela remota | Usar `favareto` e a chave atual de serviço; sem chave, usar `favareto-debug`. Se existe chave configurada, a senha padrão não será aceita. Não é o login da Favareto ou do Picareta. |
| A rota retorna 404 | Flag desativada, código antigo ou domínio apontando para serviço diferente. |
| A rota retorna 503/tela não conecta | Conferir logs de Xvfb, x11vnc e noVNC, recursos do container e comando de inicialização combinado. |
| Status tem `browserReady: false` após fechar a janela | Reiniciar o deployment para reabrir o navegador; não fechar a última janela durante o teste. |
| A coleta informa navegador ocupado | Aguardar a outra coleta. Cancelamento/finalização libera o uso; uma reserva abandonada expira em até sete minutos. |
| A coleta pede verificação manual | Aguardar a listagem ficar acessível na janela e repetir a coleta. Há até dois minutos de espera pela liberação do catálogo em cada tentativa. |

## Arquitetura

- `Dockerfile`: inclui Xvfb, x11vnc, noVNC e websockify como pacotes do sistema e define `FAVARETO_BROWSER_DEBUG=0` como padrão, sobrescrevível no Railway. Nenhum pacote npm novo. `data/` fica fora do contexto de build para não incorporar perfis locais.
- `scripts/start-combined.mjs`: inicia o subprocesso gráfico somente com a flag ativada e encaminha HTTP/WebSocket na mesma porta pública do bot.
- Falha do subprocesso de diagnóstico é registrada e deixa a tela gráfica indisponível, sem encerrar Nuxt e as outras fontes do serviço. A coleta Favareto gráfica informa falha; reiniciar o deployment reabre a sessão.
- `scripts/browser-debug-gateway.mjs`: autentica página, arquivos e WebSocket antes de encaminhar. Credenciais não são repassadas ao noVNC; WebSocket de origem diferente é recusado. Não há senha em query string.
- `scripts/start-favareto-browser-debug.mjs`: entrada mínima para o runtime server-side em `layers/scrapers/server/utils/favareto-browser-debug-runtime.mjs`.
- Runtime: Xvfb `:99`, VNC somente em loopback `5900`, noVNC em `127.0.0.1:6080`, controle em `127.0.0.1:6081`. Apenas a porta pública já existente é exposta no Railway. Chromium com janela e perfil persistente, `pt-BR`, fuso São Paulo e recursos visuais liberados. Não altera User-Agent nem simula a resolução de desafios.
- `favareto-debug-transport.ts`: adquire a sessão por canal interno autenticado, consulta pelo navegador e libera a coleta sem encerrar o browser. Cancelamento e timeout são propagados; acesso ao perfil é exclusivo por coleta.
- `favareto-debug-policy.mjs`: restringe o canal de automação a GET de listagem/editais e POST de leitura dos dois endpoints públicos. Impede consultas arbitrárias, parâmetros extras ou duplicados e endpoints de lance/login.
- `sources/favareto.ts`: seleciona o transporte gráfico quando a flag está ativada. CLI/cloud e Nuxt usam a mesma sessão externa ao processo, evitando disputa do lock do perfil entre os dois servidores.

O navegador usa recursos adicionais enquanto o diagnóstico está ligado. Se o container encerrar por falta de memória, consultar as métricas do Railway antes de repetir o teste.

## Validação realizada e limitações

- 23 testes passaram para o scraper e o transporte gráfico, incluindo separação da chave de controle interno e da senha de acesso.
- 10 testes passaram para autenticação HTTP/WebSocket, fallback de senha, prioridade da chave configurada, proxy, desativação e política de leitura. Incluem Chromium real verificando autenticação da página e do WebSocket.
- TypeScript: nenhum erro nos quatro arquivos TS alterados/verificados. As dependências importadas continuam produzindo 30 diagnósticos fora desses arquivos; não é um typecheck global aprovado.
- Verificação sintática dos novos módulos Node e do comando combinado passou.
- Docker Desktop não estava em execução/acessível no ambiente do agente; build da imagem e execução de Xvfb/noVNC no Linux **não foram executados**. Não houve instalação ou alteração de `node_modules`. Testes TS e Chromium real usaram Node 22 e dependências Windows já existentes.
- O teste decisivo no Railway ainda precisa ser realizado pelo operador. Nenhuma liberação da Favareto em produção foi presumida.

Comandos para validação no ambiente do solicitante:

```bash
node --test tests/browser-debug-gateway.test.mjs
pnpm exec tsx --test tests/favareto-scraper.test.ts tests/favareto-debug-transport.test.ts
node --input-type=module -e 'process.env.FAVARETO_BROWSER_SMOKE="1"; await import("./tests/browser-debug-gateway.test.mjs")'
pnpm build
```

O terceiro comando requer um Chromium do Playwright já disponível. Para conferir o build Linux isolado, o operador pode executar `docker build -t bot-anuncios:0.45.1 .`; a instalação de dependências ocorre somente dentro da imagem. A publicação no Railway faz esse mesmo build pelo Dockerfile.

## Referências

- [Playwright: modo com janela em Linux/Xvfb](https://playwright.dev/docs/ci#running-headed).
- [noVNC: cliente VNC no navegador](https://github.com/novnc/noVNC).
- [Railway: volumes e variável do mount path](https://docs.railway.com/volumes).
- [Railway: WebSockets na rede pública](https://docs.railway.com/networking/public-networking/specs-and-limits).
