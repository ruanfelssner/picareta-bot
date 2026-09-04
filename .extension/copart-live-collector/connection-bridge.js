(() => {
  if (window.__picaretaConditionalConnectionBridge) return;
  window.__picaretaConditionalConnectionBridge = true;

  const PAGE_SOURCE = "picareta-history-page";
  const EXTENSION_SOURCE = "picareta-conditional-extension";
  const allowedMessages = new Set([
    "PICARETA_CONDITIONAL_CONNECTION_REQUEST",
    "PICARETA_CONDITIONAL_CONNECTION_STATUS",
    "PICARETA_CONDITIONAL_WORKER_START",
  ]);

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== PAGE_SOURCE || !allowedMessages.has(message.type)) return;

    chrome.runtime.sendMessage({
      type: message.type,
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      window.postMessage({
        source: EXTENSION_SOURCE,
        type: `${message.type}_RESULT`,
        ok: !runtimeError && response?.ok !== false,
        body: runtimeError ? { message: runtimeError.message } : response?.body ?? null,
      }, window.location.origin);
    });
  });
})();
