# Copart Live Collector

Extensao privada para mapear campos visiveis do leilao ao vivo da Copart e enviar snapshots normalizados para o endpoint do projeto.

## Instalar no Chrome

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `.extension/copart-live-collector`.
5. Abra a sala do leilao ao vivo da Copart.
6. Use o botao `Copart Coletor` no canto inferior direito.

## Uso

1. Inicie o app com `pnpm dev`.
2. Confirme que o MongoDB esta conectado.
3. Confirme o endpoint: `http://localhost:3000/api/copart-live/events`.
4. Para cada campo, clique em `Selecionar` e depois clique no elemento da pagina.
5. Use `Preview` para ver o evento montado.
6. Clique em `Iniciar`.
7. A aba `Logs` mostra cada snapshot salvo e cada envio para a API.

## Token opcional

Se o backend tiver `COPART_EXTENSION_TOKEN` configurado, informe o mesmo valor no campo `Token opcional`.

## Observacoes

- A extensao apenas observa a pagina aberta na sua sessao.
- Ela nao automatiza login, captcha, clique ou lance.
- Os seletores ficam salvos em `chrome.storage.local`.
- Use `Exportar` para baixar o contrato de mapeamento.
