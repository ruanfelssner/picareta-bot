# 09 - POC de leilões públicos integrados ao WhatsApp

## Escopo entregue

O MVP usa os veículos já cadastrados em `scraped_vehicles` e adiciona um leilão público por
veículo. O administrador acessa `/admin/leiloes` para criar rascunhos, configurar valor inicial,
incremento, aprovação automática, publicar, acompanhar/aprovar/recusar lances e finalizar. O
visitante acessa `/lance/:slug` sem login.

O visitante informa somente o nome. O servidor calcula o lance no momento da requisição:

```text
sem lance aceito: startingBid
com lance aceito: currentBid + increment
```

O valor enviado pelo navegador é ignorado. A página pública atualiza os dados a cada dez segundos
e exibe somente nomes mascarados no histórico.

## WhatsApp

Os eventos de publicação, lance aceito e finalização são persistidos em `whatsapp_events` antes da
tentativa de envio. O evento de publicação envia a primeira imagem utilizável do veículo pelo
endpoint `send-image`, com a mensagem como legenda; se a imagem falhar, o sistema preserva o aviso
enviando o texto como fallback. Assim, uma falha na Z-API não desfaz a operação do leilão. A
comunidade e o grupo de avisos ficam em `whatsapp_communities`.

O aviso de novo lance usa o formato curto `Novo lance de 💰R$... recebido para ... de 👤 ...`,
seguido apenas pelo link público do leilão.

Na tela administrativa, informe os IDs existentes para apenas salvar uma comunidade. Se os IDs
ficarem vazios, o servidor chama a criação de comunidade da Z-API e captura o grupo de avisos
retornado. A API documenta a criação em `POST /instances/{instanceId}/token/{token}/communities`;
o grupo de avisos é criado junto com a comunidade.

O link de convite não vem no retorno da criação. Depois de salvar a comunidade, use “Gerar link de
convite” no painel. A ação chama o endpoint de redefinição de convite da comunidade, salva o
`invitationLink` e oferece cópia/abertura do link. Gerar novamente invalida o link anterior.

## Configuração

São reutilizadas as variáveis existentes `ZAPI_BASE_URL`, `ZAPI_INSTANCE_ID`, `ZAPI_TOKEN`,
`ZAPI_CLIENT_TOKEN` e `ZAPI_ENABLED`. Para proteger o painel em ambiente compartilhado, configure
`AUCTION_ADMIN_TOKEN`; as rotas administrativas exigirão esse valor no header
`x-auction-admin-token`. Sem essa variável, o comportamento permanece aberto para a POC local,
seguindo o padrão atual do bot.

## Limites conhecidos da POC

- O rate limit público é em memória, por processo: cinco tentativas por IP e leilão a cada minuto.
- A serialização de lances usa uma fila por leilão no processo e uma atualização condicional no
  MongoDB. Para múltiplas réplicas, o próximo passo é mover a operação para transação MongoDB ou
  lock distribuído.
- Eventos `failed` ficam disponíveis para reenvio posterior, mas ainda não há worker automático de
  retry; anúncios publicados podem ser reenviados pelo painel.
- Não há cadastro, login, OTP, pagamento, cronômetro, anti-sniping, websocket ou lance pelo próprio
  WhatsApp.
