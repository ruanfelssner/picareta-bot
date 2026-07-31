chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  const request = message.type === "LIVE_AUCTION_API_REQUEST"
    ? requestLocalApi(message)
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

async function requestLocalApi(message) {
  const endpoint = assertAllowedEndpoint(message.endpoint);
  const method = normalizeMethod(message.method);
  const headers = normalizeHeaders(message.headers);
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
  const endpoint = typeof message.endpoint === "string"
    ? message.endpoint
    : "http://localhost:3000/api/vehicles/ingest";
  const headers = normalizeHeaders(message.headers);
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

function assertAllowedEndpoint(value) {
  const endpoint = typeof value === "string" ? value : "";
  const url = new URL(endpoint);
  const allowedOrigin = url.origin === "http://localhost:3000" || url.origin === "http://127.0.0.1:3000";
  if (!allowedOrigin || !url.pathname.startsWith("/api/vehicles/")) {
    throw new Error("Endpoint local não permitido.");
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
