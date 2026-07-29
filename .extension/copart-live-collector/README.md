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
2. Abra um arquivo em `.extension/copart-live-collector/exemples/`, `.extension/copart-live-collector/vip/`, `.extension/sodre/`, um leilao da Copart, um evento online da VIP Leiloes ou o telao da Sodre Santoro (`leilao.sodresantoro.com.br/app/telao/`).
3. O painel `Live Auction Collector` aparece automaticamente.
4. Use `Atualizar` para reler a pagina.
5. Use `Ativar` para observar mudancas e salvar quando o status virar `sold`, `conditional` ou `not_sold`.

O painel começa no modo `Banco`. Nesse modo, o envio vai para `POST http://localhost:3000/api/vehicles/ingest` e salva direto no MongoDB, aplicando as regras automáticas (ver `⚙️ Config` abaixo).

Use o botão `🗄️ Modo: Banco` no painel para alternar para `📄 Modo: Documento`, que manda o envio para `POST http://localhost:3000/api/vehicles/ingest-text` e acrescenta cada resultado final ao arquivo `data/live-auction-AAAA-MM-DD.txt`, sem tocar no MongoDB e sem aplicar filtro de categoria/estado/monta.

O caminho do arquivo do modo Documento pode ser alterado no backend com `LIVE_AUCTION_TEXT_FILE`. Um caminho relativo é resolvido a partir da raiz do projeto.
Enquanto o lote estiver em lance aberto, a extensao apenas atualiza o preview.
O estado `Ativar` fica salvo por fonte; se a pagina recarregar, o coletor volta ativo sozinho. Use `⏹ Desativar` para desligar de forma persistente.

## Configurar regras automáticas

O botão `⚙️ Config` abre um painel para editar, sem precisar mexer no código:

- **Estados para salvar automático** — clique nas UFs para incluir/excluir da lista (nenhuma
  UF selecionada é diferente de "aceita todas": significa que nenhum estado passa).
- **Bloquear lote quando não detectar estado** — desligue se quiser aceitar lotes cujo endereço
  não deixou claro a UF (comum em Sodré/VIP quando o texto não menciona o estado).
- **Categorias Copart permitidas** — lista separada por vírgula; só vale para lotes da Copart.

Clique em `✓ Salvar config` para persistir (fica em `localStorage`, sobrevive a reload e a
reinício do Chrome) ou `↺ Padrão` para voltar ao padrão de fábrica (`PR`, categorias originais,
estado obrigatório).

Se o backend estiver com `LIVE_AUCTION_EXTENSION_TOKEN` ou `COPART_EXTENSION_TOKEN`, defina o mesmo token no storage do site:

```js
localStorage.setItem("liveAuctionExtensionToken", "seu-token")
```

O token antigo `copartExtensionToken` ainda e aceito para compatibilidade.
