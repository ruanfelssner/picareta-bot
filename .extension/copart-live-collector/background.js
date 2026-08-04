const API_ORIGIN = "https://picareta-bot.felss.dev";
const EXTENSION_TOKEN_STORAGE_KEY = "liveAuctionExtensionToken";
const DEFAULT_EXTENSION_TOKEN = "7d7c05e46b7d60e29a77dbe62def6dfa389b53e73db15be41dcd83d61bf73b11";

chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  const request = message.type === "LIVE_AUCTION_API_REQUEST"
    ? requestApi(message)
    : message.type === "LIVE_AUCTION_INGEST_EVENT" || message.type === "COPART_INGEST_EVENT"
      ? postIngestEvent(message)
      : null;

  if (!request) return false;

  request
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        ok: false,
        status: 0,
        body: { message: error instanceof Error ? error.message : "Falha ao salvar" },
      });
    });

  return true;
});

async function requestApi(message) {
  const endpoint = assertAllowedEndpoint(message.endpoint);
  const method = normalizeMethod(message.method);
  const headers = await withExtensionToken(normalizeHeaders(message.headers));
  const response = await fetch(endpoint, {
    method,
    headers,
    body: method === "GET" ? undefined : JSON.stringify(message.body ?? null),
  });
  const body = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

async function postIngestEvent(message) {
  const endpoint = assertAllowedEndpoint(typeof message.endpoint === "string"
    ? message.endpoint
    : `${API_ORIGIN}/api/vehicles/ingest`);
  const headers = await withExtensionToken(normalizeHeaders(message.headers));
  const context = getEventContext(message.event);

  console.info("[live-auction-collector:bg] post", {
    at: new Date().toISOString(),
    endpoint,
    ...context,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(message.event ?? null),
  });
  const body = await response.json().catch(() => null);

  console.info("[live-auction-collector:bg] resposta", {
    at: new Date().toISOString(),
    status: response.status,
    ok: response.ok,
    accepted: body && typeof body === "object" ? body.accepted ?? null : null,
    inserted: body && typeof body === "object" ? body.inserted ?? null : null,
    updated: body && typeof body === "object" ? body.updated ?? null : null,
    ...context,
  });

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function normalizeHeaders(value) {
  const headers = { "Content-Type": "application/json" };
  if (!value || typeof value !== "object" || Array.isArray(value)) return headers;

  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && item.trim()) headers[key] = item;
  }

  return headers;
}

function normalizeMethod(value) {
  return value === "GET" || value === "PATCH" || value === "POST" ? value : "POST";
}

async function withExtensionToken(headers) {
  const stored = await chrome.storage.local.get(EXTENSION_TOKEN_STORAGE_KEY);
  const configuredToken = typeof stored[EXTENSION_TOKEN_STORAGE_KEY] === "string"
    ? stored[EXTENSION_TOKEN_STORAGE_KEY].trim()
    : "";
  const legacyToken = typeof headers["x-live-auction-extension-token"] === "string"
    ? headers["x-live-auction-extension-token"].trim()
    : "";
  const token = configuredToken || legacyToken || DEFAULT_EXTENSION_TOKEN;

  if (token) {
    headers["x-live-auction-extension-token"] = token;
    headers["x-copart-extension-token"] = token;
  }

  return headers;
}

function assertAllowedEndpoint(value) {
  const endpoint = typeof value === "string" ? value : "";
  const url = new URL(endpoint);
  const allowedOrigin = url.origin === API_ORIGIN;
  if (!allowedOrigin || !url.pathname.startsWith("/api/vehicles/")) {
    throw new Error("Endpoint da API não permitido.");
  }
  return url.toString();
}

function getEventContext(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return {
      auctionId: null,
      lot: null,
      code: null,
      brand: null,
      model: null,
      category: null,
      yearModel: null,
      damage: null,
      condition: null,
      yard: null,
      consignor: null,
      imageUrl: null,
      saleStatus: null,
      manualDecision: null,
      source: null,
    };
  }

  return {
    source: event.source ?? null,
    auctionId: event.auctionId ?? null,
    lot: event.lot ?? null,
    code: event.code ?? null,
    brand: event.brand ?? null,
    model: event.model ?? null,
    category: event.category ?? null,
    yearModel: event.yearModel ?? null,
    damage: event.damage ?? null,
    condition: event.condition ?? null,
    yard: event.yard ?? null,
    consignor: event.consignor ?? null,
    imageUrl: event.imageUrl ?? null,
    saleStatus: event.saleStatus ?? null,
    manualDecision: event.manualDecision ?? null,
  };
}
