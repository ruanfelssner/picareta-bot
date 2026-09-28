const API_ORIGIN = "https://picareta-bot.felss.dev";
const PICARETA_ORIGIN = "https://picareta.felss.dev";
const EXTENSION_ACCESS_TOKEN_STORAGE_KEY = "picaretaExtensionAccessToken";
const EXTENSION_USER_STORAGE_KEY = "picaretaExtensionUser";
const EXTENSION_EXPIRES_AT_STORAGE_KEY = "picaretaExtensionExpiresAt";
const EXTENSION_DEVICE_ID_STORAGE_KEY = "picaretaExtensionDeviceId";
const CONDITIONAL_WORKER_ID_STORAGE_KEY = "conditionalCheckWorkerId";
const CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY = "conditionalConnectionRequested";
const CONDITIONAL_CONNECTED_STORAGE_KEY = "conditionalConnected";
const CONDITIONAL_RUN_ACTIVE_STORAGE_KEY = "conditionalRunActive";
const CONDITIONAL_WORKER_ALARM = "copartConditionalWorker";
let activeConditionalJob = null;
let conditionalTabId = null;

chrome.action.onClicked.addListener((tab) => {
  if (typeof tab?.id !== "number") return;
  void chrome.tabs.sendMessage(tab.id, { type: "PICARETA_EXTENSION_SHOW_PANEL" }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureConditionalWorker();
});

chrome.runtime.onInstalled.addListener(() => {
  void ensureConditionalWorker();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CONDITIONAL_WORKER_ALARM) void pollConditionalJobIfActive();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete" || activeConditionalJob?.tabId !== tabId) return;
  const job = activeConditionalJob;
  void notifyConditionalTab(tabId, job.jobId, job.originalAuctionDate).then((delivered) => {
    if (delivered || activeConditionalJob?.jobId !== job.jobId) return;
    void failUndeliveredConditionalJob(job);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (conditionalTabId === tabId) conditionalTabId = null;
  if (activeConditionalJob?.tabId !== tabId) return;
  const jobId = activeConditionalJob.jobId;
  activeConditionalJob = null;
  void postConditionalJobResult(jobId, {
    status: "blocked",
    statusRaw: "A aba de consulta foi encerrada antes do resultado",
    nextAuctionDate: null,
    currentBid: null,
    error: "A aba da Copart foi encerrada antes da consulta terminar.",
    source: "extension",
  });
});

void ensureConditionalWorker();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) return false;

  const request = message.type === "LIVE_AUCTION_API_REQUEST"
    ? requestApi(message)
    : message.type === "LIVE_AUCTION_INGEST_EVENT" || message.type === "COPART_INGEST_EVENT"
      ? postIngestEvent(message)
      : message.type === "COPART_CONDITIONAL_JOB_FINISHED"
        ? finishConditionalJobFromTab(message)
      : message.type === "PICARETA_CONDITIONAL_CONNECTION_REQUEST"
        ? requestConditionalConnection()
      : message.type === "PICARETA_CONDITIONAL_CONNECTION_STATUS" || message.type === "COPART_CONDITIONAL_CONNECTION_STATUS"
        ? conditionalConnectionStatusResponse()
      : message.type === "COPART_CONDITIONAL_CONNECT"
        ? connectConditionalBrowser(_sender)
      : message.type === "PICARETA_CONDITIONAL_WORKER_START"
        ? startConditionalWorker()
      : message.type === "PICARETA_CONDITIONAL_WORKER_STOP"
        ? stopConditionalWorker()
      : message.type === "COPART_CONDITIONAL_DISCONNECT"
        ? disconnectConditionalBrowser()
      : message.type === "PICARETA_EXTENSION_LOGIN"
        ? loginPicaretaExtension(message)
      : message.type === "PICARETA_EXTENSION_LOGOUT"
        ? logoutPicaretaExtension()
      : message.type === "PICARETA_EXTENSION_SESSION"
        ? getPicaretaExtensionSession({ validate: message.validate === true })
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

async function loginPicaretaExtension(message) {
  const phone = typeof message.phone === "string" ? message.phone.trim() : "";
  const password = typeof message.password === "string" ? message.password : "";
  if (!phone || !password) return { ok: false, status: 400, body: { message: "Informe telefone e senha." } };

  const deviceId = await getExtensionDeviceId();
  const response = await fetch(`${PICARETA_ORIGIN}/api/v1/auth/extension/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, password, deviceId }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || typeof body?.accessToken !== "string" || !body?.user) {
    return { ok: false, status: response.status, body };
  }

  await chrome.storage.local.set({
    [EXTENSION_ACCESS_TOKEN_STORAGE_KEY]: body.accessToken,
    [EXTENSION_USER_STORAGE_KEY]: body.user,
    [EXTENSION_EXPIRES_AT_STORAGE_KEY]: typeof body.expiresAt === "string" ? body.expiresAt : null,
  });
  return { ok: true, status: response.status, body: { user: body.user, expiresAt: body.expiresAt ?? null } };
}

async function logoutPicaretaExtension() {
  await chrome.storage.local.remove([
    EXTENSION_ACCESS_TOKEN_STORAGE_KEY,
    EXTENSION_USER_STORAGE_KEY,
    EXTENSION_EXPIRES_AT_STORAGE_KEY,
  ]);
  activeConditionalJob = null;
  await chrome.storage.session.set({
    [CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY]: false,
    [CONDITIONAL_CONNECTED_STORAGE_KEY]: false,
    [CONDITIONAL_RUN_ACTIVE_STORAGE_KEY]: false,
  });
  return { ok: true, status: 200, body: { authenticated: false } };
}

async function getPicaretaExtensionSession(options = {}) {
  const stored = await chrome.storage.local.get([
    EXTENSION_ACCESS_TOKEN_STORAGE_KEY,
    EXTENSION_USER_STORAGE_KEY,
    EXTENSION_EXPIRES_AT_STORAGE_KEY,
  ]);
  const token = typeof stored[EXTENSION_ACCESS_TOKEN_STORAGE_KEY] === "string"
    ? stored[EXTENSION_ACCESS_TOKEN_STORAGE_KEY].trim()
    : "";
  if (!token) return { ok: true, status: 200, body: { authenticated: false } };
  if (!options.validate) {
    return {
      ok: true,
      status: 200,
      body: {
        authenticated: true,
        user: stored[EXTENSION_USER_STORAGE_KEY] ?? null,
        expiresAt: stored[EXTENSION_EXPIRES_AT_STORAGE_KEY] ?? null,
      },
    };
  }

  const response = await fetch(`${PICARETA_ORIGIN}/api/v1/auth/extension/session`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    await logoutPicaretaExtension();
    return { ok: false, status: response.status, body };
  }
  await chrome.storage.local.set({ [EXTENSION_USER_STORAGE_KEY]: body.user });
  return {
    ok: true,
    status: 200,
    body: {
      authenticated: true,
      user: body.user,
      expiresAt: stored[EXTENSION_EXPIRES_AT_STORAGE_KEY] ?? null,
    },
  };
}

async function getExtensionDeviceId() {
  const stored = await chrome.storage.local.get(EXTENSION_DEVICE_ID_STORAGE_KEY);
  const current = stored[EXTENSION_DEVICE_ID_STORAGE_KEY];
  if (typeof current === "string" && current.trim()) return current.trim();
  const deviceId = crypto.randomUUID();
  await chrome.storage.local.set({ [EXTENSION_DEVICE_ID_STORAGE_KEY]: deviceId });
  return deviceId;
}

async function ensureConditionalWorker() {
  await chrome.alarms.create(CONDITIONAL_WORKER_ALARM, { periodInMinutes: 0.5 });
  if (!(await isConditionalRunActive())) return;
  const connection = await getConditionalConnectionState();
  if (!connection.connected) return;
  await pollConditionalJob();
}

async function isConditionalRunActive() {
  const stored = await chrome.storage.session.get(CONDITIONAL_RUN_ACTIVE_STORAGE_KEY);
  return stored[CONDITIONAL_RUN_ACTIVE_STORAGE_KEY] === true;
}

async function pollConditionalJobIfActive() {
  if (await isConditionalRunActive()) await pollConditionalJob();
}

async function pollConditionalJob(options = {}) {
  if (activeConditionalJob) return;
  try {
    const connection = await getConditionalConnectionState();
    if (!connection.connected) return;
    const workerId = await getConditionalWorkerId();
    const jobsEndpoint = new URL(`${API_ORIGIN}/api/vehicles/conditional-check/jobs`);
    if (options.recover === true) jobsEndpoint.searchParams.set("recover", "true");
    const response = await requestApi({
      endpoint: jobsEndpoint.toString(),
      method: "GET",
      headers: { "x-live-auction-worker-id": workerId },
    });
    const job = response?.body?.job;
    if (!response.ok) return;
    if (!job || typeof job.jobId !== "string" || typeof job.url !== "string") {
      await chrome.storage.session.set({ [CONDITIONAL_RUN_ACTIVE_STORAGE_KEY]: false });
      return;
    }

    const target = buildConditionalTarget(job);
    let tabId = conditionalTabId;
    if (typeof tabId === "number") {
      try {
        await chrome.tabs.get(tabId);
      }
      catch {
        conditionalTabId = null;
        tabId = null;
      }
    }
    if (typeof tabId !== "number") {
      const tab = await chrome.tabs.create({ url: target.toString(), active: false });
      if (typeof tab.id !== "number") throw new Error("Não foi possível abrir a aba de consulta.");
      tabId = tab.id;
      conditionalTabId = tabId;
    }
    else {
      await chrome.tabs.update(tabId, { url: target.toString(), active: false });
    }
    activeConditionalJob = {
      jobId: job.jobId,
      tabId,
      originalAuctionDate: typeof job.originalAuctionDate === "string" ? job.originalAuctionDate : null,
    };
  }
  catch (error) {
    console.warn("[live-auction-collector:bg] fila condicional indisponível", error);
  }
}

async function getConditionalConnectionState() {
  const stored = await chrome.storage.session.get([
    CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY,
    CONDITIONAL_CONNECTED_STORAGE_KEY,
  ]);
  return {
    requested: stored[CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY] === true,
    connected: stored[CONDITIONAL_CONNECTED_STORAGE_KEY] === true,
    workerId: await getConditionalWorkerId(),
  };
}

async function conditionalConnectionStatusResponse() {
  return { ok: true, status: 200, body: await getConditionalConnectionState() };
}

async function requestConditionalConnection() {
  await chrome.storage.session.set({
    [CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY]: true,
    [CONDITIONAL_CONNECTED_STORAGE_KEY]: false,
  });
  return conditionalConnectionStatusResponse();
}

async function connectConditionalBrowser(sender) {
  await chrome.storage.session.set({
    [CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY]: false,
    [CONDITIONAL_CONNECTED_STORAGE_KEY]: true,
  });
  if (typeof sender?.tab?.id === "number") conditionalTabId = sender.tab.id;
  return conditionalConnectionStatusResponse();
}

async function startConditionalWorker() {
  const connection = await getConditionalConnectionState();
  if (!connection.connected) return conditionalConnectionStatusResponse();
  activeConditionalJob = null;
  await chrome.storage.session.set({ [CONDITIONAL_RUN_ACTIVE_STORAGE_KEY]: true });
  await ensureConditionalWorker();
  await pollConditionalJob({ recover: true });
  return conditionalConnectionStatusResponse();
}

async function stopConditionalWorker() {
  activeConditionalJob = null;
  await chrome.storage.session.set({ [CONDITIONAL_RUN_ACTIVE_STORAGE_KEY]: false });
  return conditionalConnectionStatusResponse();
}

async function disconnectConditionalBrowser() {
  await chrome.storage.session.set({
    [CONDITIONAL_CONNECTION_REQUESTED_STORAGE_KEY]: false,
    [CONDITIONAL_CONNECTED_STORAGE_KEY]: false,
    [CONDITIONAL_RUN_ACTIVE_STORAGE_KEY]: false,
  });
  await chrome.alarms.clear(CONDITIONAL_WORKER_ALARM);
  return conditionalConnectionStatusResponse();
}

function buildConditionalTarget(job) {
  const target = new URL(job.url);
  target.searchParams.set("picareta_conditional_job", job.jobId);
  if (typeof job.originalAuctionDate === "string" && job.originalAuctionDate) {
    target.searchParams.set("picareta_conditional_original_date", job.originalAuctionDate);
  }
  return target;
}

async function notifyConditionalTab(tabId, jobId, originalAuctionDate) {
  const attempts = [0, 800, 1800];
  for (const delay of attempts) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "COPART_CONDITIONAL_JOB_START",
        jobId,
        originalAuctionDate,
      });
      return true;
    }
    catch (error) {
      if (delay === attempts.at(-1)) {
        console.warn("[live-auction-collector:bg] content script não respondeu ao job condicional", error);
      }
    }
  }
  return false;
}

async function failUndeliveredConditionalJob(job) {
  if (activeConditionalJob?.jobId !== job.jobId) return;
  const result = {
    status: "blocked",
    statusRaw: "A extensão não conseguiu iniciar a consulta nesta página",
    nextAuctionDate: null,
    currentBid: null,
    error: "A extensão não respondeu na página do lote após três tentativas.",
    source: "extension",
  };
  await postConditionalJobResult(job.jobId, result);
  activeConditionalJob = null;
  conditionalTabId = job.tabId;
  void pollConditionalJob();
}

async function finishConditionalJobFromTab(message) {
  const jobId = typeof message.jobId === "string" ? message.jobId : "";
  if (!jobId) return { ok: false, status: 400, body: { message: "Job não informado." } };
  const isActiveJob = activeConditionalJob?.jobId === jobId;
  const tabId = isActiveJob ? activeConditionalJob.tabId : null;
  const keepTab = message.keepTab === true;
  let ignored = false;
  let persisted = false;
  if (message.result && typeof message.result === "object" && !Array.isArray(message.result)) {
    const response = await postConditionalJobResult(jobId, message.result);
    if (!response.ok) return response;
    ignored = response.body?.ignored === true;
    persisted = Boolean(response.body?.job?.vehicleId);
  }
  if (isActiveJob) activeConditionalJob = null;
  if (isActiveJob && !ignored && typeof tabId === "number" && !keepTab) {
    conditionalTabId = tabId;
    void pollConditionalJob();
  }
  return { ok: true, status: 200, body: { jobId, ignored, persisted } };
}

async function postConditionalJobResult(jobId, result) {
  try {
    const response = await requestApi({
      endpoint: `${API_ORIGIN}/api/vehicles/conditional-check/jobs/${encodeURIComponent(jobId)}/result`,
      method: "POST",
      headers: { "x-live-auction-worker-id": await getConditionalWorkerId() },
      body: result,
    });
    if (!response.ok) throw new Error(response.body?.message ?? "O backend não aceitou o resultado da consulta.");
    return response;
  }
  catch (error) {
    console.warn("[live-auction-collector:bg] falha ao registrar job condicional", error);
    return { ok: false, status: 0, body: { message: error instanceof Error ? error.message : "Falha ao registrar o job condicional." } };
  }
}

async function getConditionalWorkerId() {
  const stored = await chrome.storage.local.get(CONDITIONAL_WORKER_ID_STORAGE_KEY);
  if (typeof stored[CONDITIONAL_WORKER_ID_STORAGE_KEY] === "string" && stored[CONDITIONAL_WORKER_ID_STORAGE_KEY].trim()) {
    return stored[CONDITIONAL_WORKER_ID_STORAGE_KEY].trim();
  }
  const workerId = `browser-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [CONDITIONAL_WORKER_ID_STORAGE_KEY]: workerId });
  return workerId;
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
  const stored = await chrome.storage.local.get(EXTENSION_ACCESS_TOKEN_STORAGE_KEY);
  const token = typeof stored[EXTENSION_ACCESS_TOKEN_STORAGE_KEY] === "string"
    ? stored[EXTENSION_ACCESS_TOKEN_STORAGE_KEY].trim()
    : "";
  delete headers["x-live-auction-extension-token"];
  delete headers["x-copart-extension-token"];
  if (token) headers.authorization = `Bearer ${token}`;

  headers["x-live-auction-worker-id"] = await getConditionalWorkerId();

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
