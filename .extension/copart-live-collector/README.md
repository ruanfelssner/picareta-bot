# Live Auction Collector

Extensao simples para ler o lote renderizado em leiloes ao vivo, mostrar um preview e salvar resultados finais no backend local.

A versao antiga completa ficou em `.extension/copart-live-collector-backup`.

Documentacao tecnica e plano multi-site: `docs/live-auction-extension.md`.

## Instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `.extension/copart-live-collector`.
5. Nos detalhes da extensao, ative `Permitir acesso a URLs de arquivo`.

## Usar

1. Rode o app local em `http://localhost:3000`.
2. Abra um arquivo em `.extension/copart-live-collector/exemples/`, `.extension/copart-live-collector/vip/`, um leilao da Copart ou um evento online da VIP Leiloes.
3. O painel `Live Auction Collector` aparece automaticamente.
4. Use `Atualizar` para reler a pagina.
5. Use `Ativar` para observar mudancas e salvar quando o status virar `sold`, `conditional` ou `not_sold`.

O painel começa no modo `Documento`. Nesse modo, o envio vai para `POST http://localhost:3000/api/vehicles/ingest-text` e acrescenta cada resultado final ao arquivo `data/live-auction-AAAA-MM-DD.txt`, sem salvar no MongoDB.

Use o botão `Modo: Documento` no painel para alternar entre `Documento` e `Banco`. O modo `Banco` volta a usar `POST http://localhost:3000/api/vehicles/ingest` e as regras automáticas originais.

No modo `Documento`, os filtros automáticos de categoria, estado e monta ficam desligados: todo resultado final identificado é acrescentado ao documento. Lances ainda abertos continuam aguardando o resultado final.

O caminho do arquivo pode ser alterado no backend com `LIVE_AUCTION_TEXT_FILE`. Um caminho relativo é resolvido a partir da raiz do projeto.
Enquanto o lote estiver em lance aberto, a extensao apenas atualiza o preview.
O estado `Ativar` fica salvo por fonte; se a pagina recarregar, o coletor volta ativo sozinho. Use `Desativar` para desligar de forma persistente.

Se o backend estiver com `LIVE_AUCTION_EXTENSION_TOKEN` ou `COPART_EXTENSION_TOKEN`, defina o mesmo token no storage do site:

```js
localStorage.setItem("liveAuctionExtensionToken", "seu-token")
```

O token antigo `copartExtensionToken` ainda e aceito para compatibilidade.
