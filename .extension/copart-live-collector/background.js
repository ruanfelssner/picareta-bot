chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "COPART_INGEST_EVENT") return false;

  postIngestEvent(message)
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

async function postIngestEvent(message) {
  const endpoint = typeof message.endpoint === "string"
    ? message.endpoint
    : "http://localhost:3000/api/vehicles/ingest";
  const headers = normalizeHeaders(message.headers);
  const context = getEventContext(message.event);

  console.info("[copart-collector:bg] post", {
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

  console.info("[copart-collector:bg] resposta", {
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
      imageUrl: null,
      saleStatus: null,
      manualDecision: null,
    };
  }

  return {
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
    imageUrl: event.imageUrl ?? null,
    saleStatus: event.saleStatus ?? null,
    manualDecision: event.manualDecision ?? null,
  };
}
