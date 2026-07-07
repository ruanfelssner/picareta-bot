# Copart Collector

Extensao simples para ler o lote renderizado na Copart, mostrar um preview e salvar resultados finais no backend local.

A versao antiga completa ficou em `.extension/copart-live-collector-backup`.

## Instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `.extension/copart-live-collector`.
5. Nos detalhes da extensao, ative `Permitir acesso a URLs de arquivo`.

## Usar

1. Rode o app local em `http://localhost:3000`.
2. Abra um arquivo em `.extension/copart-live-collector/exemples/` ou um leilao da Copart.
3. O painel `Copart Collector` aparece automaticamente.
4. Use `Atualizar` para reler a pagina.
5. Use `Ativar` para observar mudancas e salvar quando o status virar `sold`, `conditional` ou `not_sold`.

O envio vai para `POST http://localhost:3000/api/vehicles/ingest`.
Enquanto o lote estiver em lance aberto, a extensao apenas atualiza o preview.

Se o backend estiver com `COPART_EXTENSION_TOKEN`, defina o mesmo token no storage do site Copart:

```js
localStorage.setItem("copartExtensionToken", "seu-token")
```
