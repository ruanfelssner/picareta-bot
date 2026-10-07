# 02 - Worker Windows de leilões com favoritos

Entrega bot-anuncios 0.35.0 integrada ao Picareta 0.168.0. O agendador usa a API existente `/api/v1/auction-schedules` com a sessão individual de `/api/v1/auth/me`, sem acesso direto às collections de favoritos nem chave compartilhada. Roda a cada minuto, em paralelo ao Marketplace, e também pode ser executado sozinho.

## Teste antes de ativar

No Windows, abrir `scripts/windows/test-auction-worker.cmd` com o worker parado ou a automação desativada. O script executa regras, teste isolado de Chromium/extensão, login na agenda do Picareta e prévia da agenda real. O teste isolado intercepta as páginas e usa uma API localhost; não acessa salas reais nem envia eventos. O setup mantém `enabled=false`; a prévia não abre salas.

```sh
pnpm worker:auctions:test
pnpm worker:auctions:smoke
pnpm worker:auctions:setup
pnpm worker:auctions:preview
```

O setup abre o Picareta em Chromium do Playwright. Entre na própria conta; a validação ocorre automaticamente e fecha o navegador após confirmar a agenda. A prévia mostra leilão, favoritos, início em Brasília, link e motivo. `ABRIRIA` só aparece na janela atual de trinta minutos; um leilão favorito amanhã ainda fica aguardando. Horário desconhecido, favoritos indisponíveis, sala ausente, VIP sem PR e encerrados não liberam abertura. Não é possível garantir abertura de uma sala Copart cujo link real ainda não foi coletado.

O padrão é `https://felssner.com.br`. Para outro ambiente:

```sh
pnpm worker:auctions:setup --app-url http://localhost:3000
```

Playwright e Chromium precisam estar disponíveis no PC. Se o executável Chromium ainda não foi instalado, o usuário pode executar `pnpm exec playwright install chromium`. O agente não instala/recria `node_modules`. Chromium é usado porque Chrome e Edge removeram o suporte aos flags de carregamento local de extensões ([documentação oficial](https://playwright.dev/docs/chrome-extensions)).

## Ativação e uso

Depois de conferir a prévia:

```sh
pnpm worker:auctions:enable
```

Manter `scripts/windows/start-worker.cmd` ou `pnpm worker` rodando. O atalho de inicialização já instalado continua válido. O processo abre ao entrar na conta Windows, e o agendador reconcilia se a máquina iniciou durante/depois do começo. Para executar apenas leilões sem configurar Mongo/WhatsApp:

```sh
pnpm worker:auctions
```

Para desativar:

```sh
pnpm worker:auctions:disable
```

A desativação encerra o navegador da automação na próxima consulta; a inicialização do Marketplace/WhatsApp permanece. Para repetir setup/prévia, desativar e aguardar o perfil ser liberado, ou parar o worker. A prévia, setup e worker compartilham um lock local para evitar disputa. Não usar dois comandos simultaneamente no mesmo perfil.

## Sessões e coleta

`data/auction-worker/config.json` contém apenas `appUrl` e `enabled`; `state.json` registra os jobs. `data/auction-worker/browser` é um perfil persistente exclusivo, separado de Facebook/scrapers. Toda a pasta `data/` é ignorada pelo Git. Sessões de Picareta, extensão e cada leiloeiro são independentes e ficam no navegador; senha não entra em configuração, API, Mongo ou logs. O login do Picareta tem a validade já definida pelo aplicativo (atualmente sete dias); quando expirar, o worker abre a agenda e exige novo login antes de abrir novas salas.

O navegador carrega a extensão local `.extension/copart-live-collector`. Na primeira sala, entre no leiloeiro e no painel da extensão usando a mesma conta do Picareta. O worker valida a identidade da extensão a cada consulta e limpa uma sessão de outra conta. Usuários comuns usam a coleta automática já existente. Para admin, o worker aciona o botão existente após o horário de início e somente em uma sala oficial. Senha, CAPTCHA, MFA e bloqueios do leiloeiro ainda exigem intervenção manual. O estado `collector_active` confirma apenas que o painel ligou a coleta; confira sincronização e persistência dos eventos na própria extensão e no Histórico. O worker não inventa eventos nem marca IN LIVE por ter aberto uma aba.

## Regras e recuperação

- Prioridade Copart → Sodré → VIP; VIP exige PR na agenda oficial, incluindo eventos multirregionais.
- Links estritos de salas específicas, horários UTC confirmados e favoritos conhecidos maiores que zero. Nenhum ID/link é deduzido de lote ou pátio.
- Leilões de dias anteriores sem `live` confirmado ficam ignorados; encerramento explícito/fim conhecido sempre prevalece.
- Usuário/ID/dia brasileiro identifica o job. Consulta duplicada não cria aba; alteração de horário no mesmo dia preserva a aba, outro dia reprograma e alteração de link navega a mesma página. Fechar manualmente não reabre na mesma execução; reiniciar reconcilia as salas ainda elegíveis.
- Até seis salas abertas; próximas aguardam vaga. Falha de navegação fecha a tentativa e permite nova tentativa após cinco minutos. Estado é gravado atomicamente e os jobs antigos são limpos após oito dias quando inativos.
- Fim conhecido/encerramento fecha apenas a aba própria. Falha de API, resposta antiga, agenda vazia ou truncada não interrompe salas já abertas nem utiliza cache para abrir salas novas.
- `worker.lock` contém PID e nonce; um processo vivo impede outra instância. Reinícios concorrentes recuperam lock de processo morto com um único vencedor. Lock incompleto/corrompido ou cuja morte não pode ser confirmada é conservado; se houver bloqueio permanente, parar todas as instâncias e conferir os arquivos de lock locais antes de removê-los. Não apagar locks enquanto houver worker/navegador em uso.

## Validação da entrega

16 testes novos de regras/engine/lock/configuração + cinco existentes de datas/salas + um teste Chromium com extensão passaram (22). O teste de navegador cobre três fontes, login ausente/expirado, simulação sem salas, deduplicação, rede/resposta antiga, fim, troca de conta, identidade da extensão, controle de coleta antes/depois do início e persistência de cookies no reinício. Páginas e controle de coleta são simulados; não há login ou entrega de eventos reais.

Os cinco testes existentes de atualização PWA do Picareta também passaram, somando 27 verificações. TypeScript estrito dos módulos/testes novos passou. Neste Linux, `tsx`/esbuild local contém binário Windows, então a execução usou um registrador TypeScript temporário fora do repositório e Chromium já disponível. Nenhuma dependência foi instalada. Execução do `.cmd`, logins reais e captura durável de leilão continuam para o Windows do usuário. Não houve commit, deploy ou ativação real.

Credenciais DPAPI/Windows Credential Manager, adaptadores de login e confirmação de entrega pelo worker continuam planejadas. A implementação atual permite validar o agendamento antes dessas etapas.
