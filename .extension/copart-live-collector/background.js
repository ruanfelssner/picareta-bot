chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "COPART_LIVE_SEND_EVENTS") return false;

  void sendEvents(message)
    .then((payload) => sendResponse(payload))
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });

  return true;
});

async function sendEvents(message) {
  const apiUrl = typeof message.apiUrl === "string" ? message.apiUrl.trim() : "";
  const apiToken = typeof message.apiToken === "string" ? message.apiToken.trim() : "";
  const events = Array.isArray(message.events) ? message.events : [];

  if (!apiUrl) throw new Error("Endpoint nao configurado.");
  if (events.length === 0) return { ok: true, inserted: 0, matched: 0 };

  const headers = {
    "Content-Type": "application/json",
  };

  if (apiToken) headers["x-copart-extension-token"] = apiToken;

  const response = await fetch(apiUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ events }),
  });

  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    }
    catch {
      body = { message: text };
    }
  }

  if (!response.ok) {
    const messageText =
      body && typeof body.message === "string"
        ? body.message
        : `HTTP ${response.status}`;

    throw new Error(messageText);
  }

  return {
    ok: true,
    status: response.status,
    body,
  };
}
