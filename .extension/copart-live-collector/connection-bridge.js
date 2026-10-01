(() => {
  if (window.__picaretaConditionalConnectionBridge) return;
  window.__picaretaConditionalConnectionBridge = true;

  const PAGE_SOURCE = "picareta-history-page";
  const EXTENSION_SOURCE = "picareta-conditional-extension";
  const allowedMessages = new Set([
    "PICARETA_CONDITIONAL_CONNECTION_REQUEST",
    "PICARETA_CONDITIONAL_CONNECTION_STATUS",
    "PICARETA_CONDITIONAL_WORKER_START",
    "PICARETA_CONDITIONAL_WORKER_STOP",
    "PICARETA_LIVE_AUCTION_LOCAL_STATE",
  ]);

  function postResult(type, ok, body) {
    window.postMessage({
      source: EXTENSION_SOURCE,
      type: `${type}_RESULT`,
      ok,
      body,
    }, window.location.origin);
  }

  function handleMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || message.source !== PAGE_SOURCE || !allowedMessages.has(message.type)) return;

    const runtime = globalThis.chrome?.runtime;
    if (!runtime?.id) {
      window.removeEventListener("message", handleMessage);
      postResult(message.type, false, { message: "Extensão atualizada. Recarregue esta página." });
      return;
    }

    try {
      runtime.sendMessage({
        type: message.type,
        sessionKey: typeof message.sessionKey === "string" ? message.sessionKey : null,
        sessionKeys: Array.isArray(message.sessionKeys)
          ? message.sessionKeys.filter((item) => typeof item === "string")
          : [],
      }, (response) => {
        let runtimeError = null;
        try {
          runtimeError = runtime.lastError;
        }
        catch {
          window.removeEventListener("message", handleMessage);
          postResult(message.type, false, { message: "Extensão atualizada. Recarregue esta página." });
          return;
        }
        postResult(
          message.type,
          !runtimeError && response?.ok !== false,
          runtimeError ? { message: runtimeError.message } : response?.body ?? null,
        );
      });
    }
    catch {
      window.removeEventListener("message", handleMessage);
      postResult(message.type, false, { message: "Extensão atualizada. Recarregue esta página." });
    }
  }

  window.addEventListener("message", handleMessage);
})();
