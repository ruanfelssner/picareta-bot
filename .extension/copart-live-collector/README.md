# Copart Preview Only

Extensao simples para abrir os HTML de exemplo da Copart e mostrar um preview JSON do lote renderizado na pagina.

A versao antiga completa ficou em `.extension/copart-live-collector-backup`.

## Instalar

1. Abra `chrome://extensions`.
2. Ative `Modo do desenvolvedor`.
3. Clique em `Carregar sem compactacao`.
4. Selecione a pasta `.extension/copart-live-collector`.
5. Nos detalhes da extensao, ative `Permitir acesso a URLs de arquivo`.

## Usar

1. Abra um arquivo em `.extension/copart-live-collector/exemples/`.
2. O painel `Copart Preview` aparece automaticamente.
3. Use `Atualizar` para reler a pagina.
4. Use `Copiar JSON` para copiar o preview.

Esta versao nao inicia worker, nao observa mutacoes, nao usa storage e nao envia nada para a API.
