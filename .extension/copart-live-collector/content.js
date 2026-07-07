(() => {
  if (window.__copartPreviewOnly) return;
  window.__copartPreviewOnly = true;

  if (!isSupportedPage()) return;

  const INGEST_ENDPOINT = "http://localhost:3000/api/vehicles/ingest";
  const FINAL_SALE_STATUSES = new Set(["sold", "conditional", "not_sold"]);
  const ALLOWED_CATEGORIES = new Set(["AUTOMOVEIS", "SUV GRANDES", "SUV PEQUENOS", "PICAPES GRANDES", "PICAPES PEQUENAS"]);

  const state = {
    root: null,
    preview: null,
    status: null,
    summary: null,
    decisionToggle: null,
    decisionIcon: null,
    decisionTitle: null,
    decisionDetail: null,
    decisionAutoButton: null,
    diagnostics: null,
    activateButton: null,
    debugButton: null,
    diagnosticsData: null,
    markupCache: null,
    textCache: null,
    activeTimer: null,
    activeDebounceTimer: null,
    activeObservers: [],
    refreshing: false,
    lastSignature: "",
    active: false,
    debugOpen: false,
    saveMessage: null,
    savedCount: 0,
    lastSavedSignature: "",
    savingSignature: "",
    debugLogs: [],
    manualDecisions: new Map(),
  };

  if (window.top !== window) {
    installFrameBridge();
    return;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  }
  else {
    init();
  }

  function init() {
    injectPanel();
    renderPlaceholder();
  }

  function injectPanel() {
    const root = document.createElement("div");
    root.className = "clp-root";
    root.innerHTML = `
      <div class="clp-header">
        <div>
          <strong>Copart Collector</strong>
          <span data-role="status">Aguardando ativacao</span>
        </div>
        <button type="button" data-role="hide">x</button>
      </div>
      <div class="clp-summary" data-role="summary"></div>
      <div class="clp-decision" data-role="decision-panel">
        <button type="button" class="clp-decision-toggle" data-role="toggle-decision">
          <span class="clp-decision-icon" data-role="decision-icon">X</span>
          <span class="clp-decision-copy">
            <strong data-role="decision-title">Nao vai salvar</strong>
            <small data-role="decision-detail">Aguardando lote</small>
          </span>
        </button>
        <button type="button" class="clp-decision-auto" data-role="decision-auto">Auto</button>
      </div>
      <div class="clp-diagnostics" data-role="diagnostics" hidden></div>
      <div class="clp-actions">
        <button type="button" class="clp-primary" data-role="toggle-active">Ativar</button>
        <button type="button" data-role="refresh">Atualizar</button>
        <button type="button" data-role="toggle-debug">Debug</button>
      </div>
      <pre class="clp-preview" data-role="preview" hidden>{}</pre>
    `;

    document.documentElement.appendChild(root);

    state.root = root;
    state.preview = root.querySelector('[data-role="preview"]');
    state.status = root.querySelector('[data-role="status"]');
    state.summary = root.querySelector('[data-role="summary"]');
    state.decisionToggle = root.querySelector('[data-role="toggle-decision"]');
    state.decisionIcon = root.querySelector('[data-role="decision-icon"]');
    state.decisionTitle = root.querySelector('[data-role="decision-title"]');
    state.decisionDetail = root.querySelector('[data-role="decision-detail"]');
    state.decisionAutoButton = root.querySelector('[data-role="decision-auto"]');
    state.diagnostics = root.querySelector('[data-role="diagnostics"]');
    state.activateButton = root.querySelector('[data-role="toggle-active"]');
    state.debugButton = root.querySelector('[data-role="toggle-debug"]');

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      if (target.closest('[data-role="toggle-decision"]')) {
        toggleManualDecision();
        return;
      }

      if (target.closest('[data-role="decision-auto"]')) {
        resetManualDecision();
        return;
      }

      const role = target.closest("[data-role]")?.getAttribute("data-role");
      if (role === "refresh") void refreshPreview({ forceRender: true });
      if (role === "toggle-active") toggleActive();
      if (role === "toggle-debug") toggleDebug();
      if (role === "hide") hidePanel();
    });
  }

  function hidePanel() {
    state.active = false;
    stopActiveLoop();
    renderActiveButton();
    state.status.textContent = "Inativo";
    if (state.root) state.root.hidden = true;
  }

  async function refreshPreview(options = {}) {
    if (state.refreshing) return null;

    state.refreshing = true;
    state.markupCache = null;
    state.textCache = null;
    state.status.textContent = "Lendo lote";

    try {
      await waitForFrameDocuments();

      const localEvent = buildPreviewEvent();
      const frameEvents = await requestFrameSnapshots();
      const event = mergeWithFallback(selectBestEvent([localEvent, ...frameEvents]), localEvent);
      const signature = getEventSignature(event);
      const shouldRender = options.forceRender || signature !== state.lastSignature;

      if (shouldRender) {
        state.lastSignature = signature;
        state.preview.textContent = JSON.stringify(event, null, 2);
        renderSummary(event);
        state.diagnosticsData = state.debugOpen ? collectDiagnostics() : null;
        renderDiagnostics(state.diagnosticsData);
      }

      if (state.active) {
        const saveStateChanged = await maybeSaveEvent(event);
        if (saveStateChanged || shouldRender) renderSummary(event);
      }

      state.status.textContent = state.active
        ? event.description ? "Ativo" : "Ativo: aguardando lote"
        : event.description ? "Preview atualizado" : "Sem lote detectado";

      return event;
    }
    finally {
      state.refreshing = false;
    }
  }

  function renderPlaceholder() {
    const event = createEmptyEvent();

    state.preview.textContent = JSON.stringify(event, null, 2);
    state.status.textContent = "Aguardando ativacao";
    renderSummary(event);
    state.diagnosticsData = null;
    renderDiagnostics(null);
  }

  function createEmptyEvent() {
    return {
      source: "copart-live",
      auctionId: null,
      lot: null,
      code: null,
      description: null,
      version: null,
      yearModel: null,
      brand: null,
      model: null,
      category: null,
      fipe: null,
      fipeRaw: null,
      damage: null,
      condition: null,
      yard: null,
      bid: null,
      bidRaw: null,
      saleStatus: null,
      eventType: "snapshot",
      fipePercent: null,
      imageUrl: null,
      vehicleUrl: null,
      message: null,
      observedAt: new Date().toISOString(),
    };
  }

  function renderSummary(event) {
    const title = [event.description, event.yearModel].filter(Boolean).join(" | ") || "Aguardando lote";
    const bid = event.bidRaw ?? "-";
    const fipe = event.fipeRaw ?? "-";
    const fipePercent = event.fipePercent != null ? `${event.fipePercent}%` : "-";
    const status = event.message ?? event.saleStatus ?? "-";
    const damage = event.damage ?? "-";
    const condition = event.condition ?? "-";
    const category = event.category ?? "-";
    const collectorState = state.active
      ? ["Ativo", state.saveMessage, state.savedCount > 0 ? `${state.savedCount} salvo(s)` : null].filter(Boolean).join(" | ")
      : "Inativo";

    state.summary.innerHTML = `
      <strong>${escapeHtml(title)}</strong>
      <span>Coletor ${escapeHtml(collectorState)}</span>
      <span>Leilao ${escapeHtml(event.auctionId ?? "-")} | Lote ${escapeHtml(event.lot ?? "-")} | Codigo ${escapeHtml(event.code ?? "-")}</span>
      <span>Lance ${escapeHtml(bid)} | FIPE ${escapeHtml(fipe)} | Lance/FIPE ${escapeHtml(fipePercent)}</span>
      <span>Status ${escapeHtml(status)}</span>
      <span>Categoria ${escapeHtml(category)} | Monta ${escapeHtml(damage)} | Condicao ${escapeHtml(condition)}</span>
    `;

    renderDecision(event);
  }

  function renderDecision(event) {
    if (!state.decisionToggle || !state.decisionIcon || !state.decisionTitle || !state.decisionDetail) return;

    const decision = getSaveDecision(event);
    const isManual = decision.mode === "manual";
    const willSaveEventually = decision.shouldSave || decision.pending;
    const title = willSaveEventually
      ? decision.pending ? "Vai salvar no final" : "Vai salvar"
      : "Nao vai salvar";
    const modeText = isManual ? "Manual" : "Automatico";
    const detail = `${modeText}: ${decision.reason}`;

    state.decisionToggle.dataset.decision = willSaveEventually ? "save" : "skip";
    state.decisionToggle.dataset.mode = decision.mode;
    state.decisionIcon.textContent = willSaveEventually ? "OK" : "X";
    state.decisionTitle.textContent = title;
    state.decisionDetail.textContent = detail;

    if (state.decisionAutoButton) {
      state.decisionAutoButton.disabled = !isManual;
      state.decisionAutoButton.dataset.active = String(isManual);
    }
  }

  function renderDiagnostics(diagnostics) {
    if (!state.diagnostics) return;

    state.diagnostics.hidden = !state.debugOpen;
    if (!state.debugOpen) return;

    const lines = [];

    if (diagnostics) {
      lines.push(...diagnostics);
    }
    else {
      lines.push("Diagnostico aparece apos Atualizar.");
    }

    if (state.debugLogs.length > 0) {
      lines.push("Logs de envio:");
      lines.push(...state.debugLogs);
    }
    else {
      lines.push("Logs de envio: nenhum post registrado nesta pagina.");
    }

    state.diagnostics.innerHTML = lines.map((item) => `<span>${escapeHtml(item)}</span>`).join("");
  }

  function toggleActive() {
    state.active = !state.active;
    renderActiveButton();

    if (state.active) {
      state.saveMessage = "Aguardando resultado";
      startActiveLoop();
      state.status.textContent = "Ativo";
      renderSummary(getCurrentPreviewEvent());
      return;
    }

    stopActiveLoop();
    state.saveMessage = null;
    state.savingSignature = "";
    state.status.textContent = "Inativo";
    renderSummary(getCurrentPreviewEvent());
  }

  function startActiveLoop() {
    stopActiveLoop();
    void refreshPreview({ forceRender: true }).then(() => {
      installActiveObservers();
    });

    state.activeTimer = window.setInterval(() => {
      if (!state.active) return;
      installActiveObservers();
      void refreshPreview();
    }, 15000);
  }

  function stopActiveLoop() {
    if (state.activeTimer) window.clearInterval(state.activeTimer);
    if (state.activeDebounceTimer) window.clearTimeout(state.activeDebounceTimer);

    state.activeTimer = null;
    state.activeDebounceTimer = null;
    disconnectActiveObservers();
  }

  function installActiveObservers() {
    disconnectActiveObservers();

    for (const target of getObserverTargets().slice(0, 30)) {
      const observer = new MutationObserver(() => {
        scheduleActiveRefresh();
      });

      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });

      state.activeObservers.push(observer);
    }
  }

  function disconnectActiveObservers() {
    for (const observer of state.activeObservers) {
      observer.disconnect();
    }

    state.activeObservers = [];
  }

  function scheduleActiveRefresh() {
    if (!state.active) return;
    if (state.activeDebounceTimer) window.clearTimeout(state.activeDebounceTimer);

    state.activeDebounceTimer = window.setTimeout(() => {
      state.activeDebounceTimer = null;
      void refreshPreview();
    }, 300);
  }

  function getObserverTargets() {
    const targets = [];
    const seen = new Set();

    for (const root of getSearchRoots()) {
      if (!isRelevantObserverRoot(root)) continue;

      const target = getObserverTarget(root);
      if (!target || seen.has(target)) continue;

      seen.add(target);
      targets.push(target);
    }

    return targets;
  }

  function getObserverTarget(root) {
    if (root.nodeType === Node.DOCUMENT_NODE) {
      return root.body ?? root.documentElement;
    }

    return root;
  }

  function isRelevantObserverRoot(root) {
    if (root === document) return false;
    if (state.root && root === state.root) return false;

    if (safeQueryAll(root, ".vehicle-detail-container, .data-container, .bid-container, .main-bid-container, #chatMessageContainer").length > 0) {
      return true;
    }

    const text = normalizeText(root.body?.innerText ?? root.body?.textContent ?? root.textContent ?? "");
    if (!text) return false;

    return /Leil[aã]o\s*\/\s*Lote|Oferta atual|FIPE|Pr[oó]ximo lote|Maior lance|Condicional|Vendido/i.test(text);
  }

  function toggleDebug() {
    state.debugOpen = !state.debugOpen;
    renderDebugButton();

    if (state.debugOpen && !state.diagnosticsData) {
      state.diagnosticsData = collectDiagnostics();
    }

    renderDiagnostics(state.diagnosticsData);
  }

  function renderActiveButton() {
    if (!state.activateButton) return;

    state.activateButton.textContent = state.active ? "Desativar" : "Ativar";
    state.activateButton.dataset.active = String(state.active);
  }

  function renderDebugButton() {
    if (!state.debugButton) return;

    state.debugButton.textContent = state.debugOpen ? "Ocultar debug" : "Debug";
    state.debugButton.dataset.active = String(state.debugOpen);
  }

  function getCurrentPreviewEvent() {
    try {
      return JSON.parse(state.preview.textContent ?? "{}");
    }
    catch {
      return createEmptyEvent();
    }
  }

  function getEventSignature(event) {
    return JSON.stringify({
      auctionId: event.auctionId,
      lot: event.lot,
      code: event.code,
      bidRaw: event.bidRaw,
      saleStatus: event.saleStatus,
      message: event.message,
    });
  }

  function toggleManualDecision() {
    const event = getCurrentPreviewEvent();
    const key = getDecisionKey(event);
    if (!key) return;

    const current = getManualDecision(event);
    const autoDecision = getSaveDecision(event, { ignoreManual: true });
    const autoWillSave = autoDecision.shouldSave || autoDecision.pending;
    const next = current === "auto"
      ? autoWillSave ? "skip" : "save"
      : current === "save" ? "skip" : "save";

    state.manualDecisions.set(key, next);
    state.saveMessage = next === "save" ? "Manual: salvar" : "Manual: ignorar";
    logCollector("decisao_manual", event, {
      manualDecision: next,
      message: state.saveMessage,
    });
    renderSummary(event);

    if (state.active && next === "save") void maybeSaveEvent(event);
  }

  function resetManualDecision() {
    const event = getCurrentPreviewEvent();
    const key = getDecisionKey(event);
    if (!key) return;

    state.manualDecisions.delete(key);
    state.saveMessage = "Automatico";
    logCollector("decisao_auto", event, {
      manualDecision: "auto",
      message: "Voltou para decisao automatica",
    });
    renderSummary(event);

    if (state.active) void maybeSaveEvent(event);
  }

  function getDecisionKey(event) {
    const code = normalizeText(event.code);
    if (code) return `code:${code}`;

    const auctionId = normalizeText(event.auctionId);
    const lot = normalizeText(event.lot);
    if (auctionId && lot) return `auction:${auctionId}:lot:${lot}`;

    return null;
  }

  function getManualDecision(event) {
    const key = getDecisionKey(event);
    if (!key) return "auto";

    return state.manualDecisions.get(key) ?? "auto";
  }

  async function maybeSaveEvent(event) {
    const decision = getSaveDecision(event);
    if (!decision.shouldSave) {
      const changed = state.saveMessage !== decision.reason;
      state.saveMessage = decision.reason;
      if (changed) {
        logCollector("nao_enviado", event, {
          decisionMode: decision.mode,
          manualDecision: decision.manualDecision,
          message: decision.reason,
        });
      }
      return changed;
    }

    const eventToSave = {
      ...event,
      manualDecision: decision.manualDecision,
    };
    const signature = getSaveSignature(eventToSave);
    if (state.lastSavedSignature === signature) {
      const changed = state.saveMessage !== "Salvo na base";
      state.saveMessage = "Salvo na base";
      return changed;
    }

    if (state.savingSignature === signature) {
      const changed = state.saveMessage !== "Salvando";
      state.saveMessage = "Salvando";
      return changed;
    }

    state.savingSignature = signature;
    state.saveMessage = "Salvando";

    try {
      logCollector("post", eventToSave, {
        endpoint: INGEST_ENDPOINT,
        decisionMode: decision.mode,
        decisionReason: decision.reason,
      });

      const headers = {
        "Content-Type": "application/json",
      };
      const token = getExtensionToken();
      if (token) headers["x-copart-extension-token"] = token;

      const response = await sendIngestEvent(eventToSave, headers);
      const responseBody = response.body ?? null;

      if (!response.ok) {
        state.saveMessage = getIngestErrorMessage(responseBody) ?? "Falha ao salvar";
        logCollector("post_falhou", eventToSave, {
          status: response.status,
          decisionMode: decision.mode,
          message: state.saveMessage,
        });
        return true;
      }

      state.lastSavedSignature = signature;
      state.savedCount += 1;
      state.saveMessage = "Salvo na base";
      logCollector("salvo", eventToSave, {
        status: response.status,
        decisionMode: decision.mode,
        response: summarizeIngestResponse(responseBody),
      });
      return true;
    }
    catch (error) {
      state.saveMessage = "Backend indisponivel";
      logCollector("post_erro", eventToSave, {
        decisionMode: decision.mode,
        message: error instanceof Error ? error.message : "Erro desconhecido",
      });
      return true;
    }
    finally {
      if (state.savingSignature === signature) state.savingSignature = "";
    }
  }

  async function sendIngestEvent(event, headers) {
    if (globalThis.chrome?.runtime?.sendMessage) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: "COPART_INGEST_EVENT",
            endpoint: INGEST_ENDPOINT,
            headers,
            event,
          },
          (response) => {
            if (chrome.runtime.lastError) {
              resolve({
                ok: false,
                status: 0,
                body: { message: chrome.runtime.lastError.message },
              });
              return;
            }

            resolve(isRecord(response) ? response : {
              ok: false,
              status: 0,
              body: { message: "Sem resposta do service worker" },
            });
          },
        );
      });
    }

    const response = await fetch(INGEST_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(event),
    });
    const body = await response.json().catch(() => null);

    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  }

  function logCollector(action, event, extra = {}) {
    const payload = {
      at: new Date().toISOString(),
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
      manualDecision: event.manualDecision ?? getManualDecision(event),
      bidRaw: event.bidRaw ?? null,
      fipeRaw: event.fipeRaw ?? null,
      ...extra,
    };

    console.info(`[copart-collector] ${action}`, payload);
    appendDebugLog(action, payload);
  }

  function appendDebugLog(action, payload) {
    const response = isRecord(payload.response) ? payload.response : null;
    const responseVehicle = response && isRecord(response.vehicle) ? response.vehicle : null;
    const parts = [
      `${formatLogTime(payload.at)} ${action}`,
      `leilao ${payload.auctionId ?? "-"}`,
      `lote ${payload.lot ?? "-"}`,
      `codigo ${payload.code ?? "-"}`,
      `marca ${payload.brand ?? "-"}`,
      `modelo ${payload.model ?? "-"}`,
      `categoria ${payload.category ?? "-"}`,
      `ano ${payload.yearModel ?? "-"}`,
      `monta ${payload.damage ?? "-"}`,
      `status ${payload.saleStatus ?? "-"}`,
      `decisao ${payload.manualDecision ?? "auto"}`,
    ];

    if (payload.condition) parts.push(`condicao ${payload.condition}`);
    if (payload.yard) parts.push(`patio ${payload.yard}`);
    if (payload.imageUrl) parts.push(`foto ${shortUrl(payload.imageUrl)}`);
    if (payload.bidRaw) parts.push(`lance ${payload.bidRaw}`);
    if (payload.fipeRaw) parts.push(`fipe ${payload.fipeRaw}`);
    if (payload.status != null) parts.push(`http ${payload.status}`);
    if (payload.message) parts.push(`msg ${payload.message}`);
    if (response) {
      parts.push(`accepted ${response.accepted ?? "-"}`);
      parts.push(`inserted ${response.inserted ?? "-"}`);
      parts.push(`updated ${response.updated ?? "-"}`);
    }
    if (responseVehicle) {
      parts.push(`salvo ${responseVehicle.brand ?? "-"} ${responseVehicle.model ?? "-"}`);
      parts.push(`categoria salva ${responseVehicle.category ?? "-"}`);
      parts.push(`monta salva ${responseVehicle.damage ?? "-"}`);
      parts.push(`decisao salva ${responseVehicle.manualDecision ?? "-"}`);
    }

    state.debugLogs.unshift(parts.join(" | "));
    state.debugLogs = state.debugLogs.slice(0, 40);

    if (state.debugOpen) renderDiagnostics(state.diagnosticsData);
  }

  function formatLogTime(value) {
    const parsed = typeof value === "string" ? new Date(value) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) return new Date().toLocaleTimeString();

    return parsed.toLocaleTimeString();
  }

  function shortUrl(value) {
    if (typeof value !== "string") return "-";

    try {
      const url = new URL(value);
      return `${url.hostname}${url.pathname}`.slice(0, 90);
    }
    catch {
      return value.slice(0, 90);
    }
  }

  function summarizeIngestResponse(responseBody) {
    if (!isRecord(responseBody)) return null;
    const firstVehicle = Array.isArray(responseBody.vehicles) && isRecord(responseBody.vehicles[0])
      ? responseBody.vehicles[0]
      : null;

    return {
      accepted: responseBody.accepted ?? null,
      inserted: responseBody.inserted ?? null,
      updated: responseBody.updated ?? null,
      skipped: Array.isArray(responseBody.skipped) ? responseBody.skipped.length : null,
      vehicle: firstVehicle
        ? {
            brand: firstVehicle.brand ?? null,
            model: firstVehicle.model ?? null,
            category: firstVehicle.category ?? null,
            year: firstVehicle.year ?? null,
            damage: firstVehicle.damage ?? null,
            yard: firstVehicle.yard ?? null,
            manualDecision: firstVehicle.manualDecision ?? null,
          }
        : null,
    };
  }

  function getSaveDecision(event, options = {}) {
    const manualDecision = options.ignoreManual ? "auto" : getManualDecision(event);
    const hardReason = getHardSaveBlockReason(event);
    const softReason = getSoftSaveBlockReason(event);
    const onlyWaitingResult = hardReason === "Aguardando resultado";

    if (manualDecision === "skip") {
      return {
        mode: "manual",
        manualDecision,
        shouldSave: false,
        pending: false,
        reason: "Ignorado manualmente",
      };
    }

    if (manualDecision === "save") {
      if (hardReason) {
        return {
          mode: "manual",
          manualDecision,
          shouldSave: false,
          pending: true,
          reason: `Salvar manual quando liberar: ${hardReason}`,
        };
      }

      return {
        mode: "manual",
        manualDecision,
        shouldSave: true,
        pending: false,
        reason: softReason ? `Salvar manual ignorando: ${softReason}` : "Salvar manualmente",
      };
    }

    if (onlyWaitingResult) {
      if (softReason) {
        return {
          mode: "auto",
          manualDecision: "auto",
          shouldSave: false,
          pending: false,
          reason: `${softReason}; aguardando resultado`,
        };
      }

      return {
        mode: "auto",
        manualDecision: "auto",
        shouldSave: false,
        pending: true,
        reason: "Aguardando resultado final",
      };
    }

    if (hardReason) {
      return {
        mode: "auto",
        manualDecision: "auto",
        shouldSave: false,
        pending: false,
        reason: hardReason,
      };
    }

    if (softReason) {
      return {
        mode: "auto",
        manualDecision: "auto",
        shouldSave: false,
        pending: false,
        reason: softReason,
      };
    }

    return {
      mode: "auto",
      manualDecision: "auto",
      shouldSave: true,
      pending: false,
      reason: "Regra automatica aprovada",
    };
  }

  function getHardSaveBlockReason(event) {
    if (!FINAL_SALE_STATUSES.has(event.saleStatus)) return "Aguardando resultado";
    if (!event.code && !event.vehicleUrl) return "Sem codigo/link";
    if (!event.brand || !event.model) return "Sem marca/modelo";

    return null;
  }

  function getSoftSaveBlockReason(event) {
    if (!event.category) return "Sem categoria";
    if (!isAllowedCategory(event.category)) return `Categoria ignorada: ${event.category}`;
    if (isBlockedDamage(event)) return "Monta descartada";

    return null;
  }

  function isAllowedCategory(category) {
    const normalized = normalizeCategory(category);
    return Boolean(normalized && ALLOWED_CATEGORIES.has(normalized));
  }

  function normalizeCategory(value) {
    return normalizeForMatch(value ?? "").replace(/[^A-Z0-9]+/g, " ").trim();
  }

  function getSaveSignature(event) {
    return JSON.stringify({
      endpoint: INGEST_ENDPOINT,
      auctionId: event.auctionId,
      lot: event.lot,
      code: event.code,
      saleStatus: event.saleStatus,
      manualDecision: event.manualDecision ?? getManualDecision(event),
      bidRaw: event.bidRaw,
      fipeRaw: event.fipeRaw,
    });
  }

  function getExtensionToken() {
    try {
      return localStorage.getItem("copartExtensionToken")?.trim() || "";
    }
    catch {
      return "";
    }
  }

  function getIngestErrorMessage(responseBody) {
    if (!isRecord(responseBody)) return null;

    const data = responseBody.data;
    if (isRecord(data) && Array.isArray(data.skipped) && data.skipped.length > 0) {
      const firstSkipped = data.skipped[0];
      if (isRecord(firstSkipped) && typeof firstSkipped.reason === "string") return `Ignorado: ${firstSkipped.reason}`;
    }

    if (typeof responseBody.message === "string" && responseBody.message.trim()) {
      return responseBody.message.trim().slice(0, 80);
    }

    return null;
  }

  function isBlockedDamage(event) {
    const text = normalizeForMatch([event.damage, event.condition, event.description].filter(Boolean).join(" "));
    return /GRANDE\s+MONTA|SUCATA|PERDA\s+TOTAL|IRRECUPERAVEL|RECUPERACAO\s+IMPOSSIVEL/.test(text);
  }

  function installFrameBridge() {
    window.addEventListener("message", (messageEvent) => {
      const data = messageEvent.data;
      if (!isRecord(data) || data.type !== "COPART_PREVIEW_REQUEST") return;

      state.markupCache = null;

      const event = buildPreviewEvent();
      const response = {
        type: "COPART_PREVIEW_RESPONSE",
        requestId: data.requestId,
        event,
      };

      messageEvent.source?.postMessage(response, "*");
    });
  }

  function requestFrameSnapshots() {
    const frames = Array.from(getRootDocument().querySelectorAll("iframe"))
      .map((frame) => frame.contentWindow)
      .filter(Boolean);

    if (frames.length === 0) return Promise.resolve([]);

    const requestId = `copart-preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve) => {
      const events = [];
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(events);
      }, 500);

      function onMessage(messageEvent) {
        const data = messageEvent.data;
        if (!isRecord(data) || data.type !== "COPART_PREVIEW_RESPONSE") return;
        if (data.requestId !== requestId || !isRecord(data.event)) return;

        events.push(data.event);
      }

      window.addEventListener("message", onMessage);

      for (const frame of frames) {
        try {
          frame.postMessage({ type: "COPART_PREVIEW_REQUEST", requestId }, "*");
        }
        catch {
          // Ignora frames inacessiveis.
        }
      }

      window.setTimeout(() => {
        window.clearTimeout(timeoutId);
        window.removeEventListener("message", onMessage);
        resolve(events);
      }, 220);
    });
  }

  function collectDiagnostics() {
    const rootDoc = getRootDocument();
    const frames = safeQueryAll(rootDoc, "iframe");
    const docs = getSearchDocuments();
    const lines = [
      `Docs lidos: ${docs.length}`,
      `Iframes: ${frames.length}`,
    ];

    for (const frame of frames.slice(0, 4)) {
      const frameDoc = getFrameDocument(frame);
      const id = frame.id || frame.name || "sem-id";
      const src = frame.getAttribute("src") ?? "-";

      if (!frameDoc) {
        lines.push(`${id}: sem acesso | src ${src}`);
        continue;
      }

      const roots = getSearchRootsFromRoot(frameDoc);
      const text = getRootsText(roots);
      const html = frameDoc.documentElement?.innerHTML ?? "";
      const detailCount = countInRoots(roots, ".vehicle-detail-container, colibri-auctions-g2-bidding-tool-vehicle-detail, .data-container");
      const bidCount = countInRoots(roots, ".bid-container, colibri-auctions-g2-bidding-tool-bid-button, .main-bid-container");
      const chatCount = countInRoots(roots, ".chat-container, .chat-bidding-container, colibri-auctions-g2-bidding-tool-chat, #chatMessageContainer");
      const shadowCount = countShadowRoots(frameDoc);

      lines.push(`${id}: ${frameDoc.readyState} | texto ${text.length} | html ${html.length}`);
      lines.push(`${id}: detalhe ${detailCount} | lance ${bidCount} | chat ${chatCount} | shadow ${shadowCount}`);

      const snippet = getDiagnosticSnippet(text);
      if (snippet) lines.push(`${id}: ${snippet}`);
    }

    const rootText = normalizeText(rootDoc.body?.innerText ?? rootDoc.body?.textContent ?? "") ?? "";
    lines.push(`Pagina: texto ${rootText.length}`);

    return lines;
  }

  function countInRoots(roots, selector) {
    return roots.reduce((total, root) => total + safeQueryAll(root, selector).length, 0);
  }

  function getRootsText(roots) {
    return normalizeText(
      roots
        .map((root) => root.body?.innerText ?? root.body?.textContent ?? root.textContent ?? "")
        .join(" "),
    ) ?? "";
  }

  function countShadowRoots(root) {
    let total = 0;

    for (const element of safeQueryAll(root, "*")) {
      if (element.shadowRoot) total += 1;
    }

    return total;
  }

  function getDiagnosticSnippet(text) {
    const normalized = normalizeText(text);
    if (!normalized) return null;

    const markers = ["Leilao / Lote", "Leilão / Lote", "Descricao", "Descrição", "Oferta atual", "FIPE", "Lote"];

    for (const marker of markers) {
      const index = normalized.indexOf(marker);
      if (index >= 0) return normalized.slice(Math.max(0, index - 40), index + 140);
    }

    return normalized.slice(0, 180);
  }

  function selectBestEvent(events) {
    let best = events[0] ?? createEmptyEvent();
    let bestScore = scoreEvent(best);

    for (const event of events.slice(1)) {
      const score = scoreEvent(event);
      if (score > bestScore) {
        best = event;
        bestScore = score;
      }
    }

    return best;
  }

  function scoreEvent(event) {
    if (!isRecord(event)) return 0;

    let score = 0;
    if (event.description) score += 5;
    if (event.code) score += 4;
    if (event.lot) score += 3;
    if (event.fipe != null || event.fipeRaw) score += 3;
    if (event.bid != null || event.bidRaw) score += 2;
    if (event.message || event.saleStatus) score += 1;

    return score;
  }

  function mergeWithFallback(event, fallback) {
    const merged = { ...fallback, ...event };

    for (const [key, value] of Object.entries(fallback)) {
      if (merged[key] == null && value != null) merged[key] = value;
    }

    return merged;
  }

  function buildPreviewEvent() {
    const detail = extractCurrentVehicleDetail();
    const auctionLot = parseAuctionAndLot(detail.auctionLotRaw);
    const chat = extractChatState(auctionLot.lot);
    const visibleStatus = findVisibleStatusText();
    const statusText = coalesceText(visibleStatus, chat.message);
    const bidRaw = coalesceText(chat.bidRaw, findCurrentBidRaw());
    const bid = parseMoney(bidRaw);
    const fipe = parseMoney(detail.fipeRaw);
    const saleStatus = inferSaleStatus(statusText);

    return {
      source: "copart-live",
      auctionId: coalesceText(auctionLot.auctionId, findAuctionId()),
      lot: coalesceText(chat.lot, auctionLot.lot, detail.lot),
      code: detail.code ?? null,
      description: detail.description ?? null,
      version: detail.version ?? null,
      yearModel: detail.yearModel ?? null,
      brand: detail.brand ?? null,
      model: detail.model ?? null,
      category: detail.category ?? null,
      fipe,
      fipeRaw: detail.fipeRaw ?? null,
      damage: detail.damage ?? null,
      condition: detail.condition ?? null,
      yard: detail.yard ?? null,
      bid,
      bidRaw,
      saleStatus,
      eventType: inferEventType({ bid, saleStatus, message: statusText }),
      fipePercent: bid != null && fipe != null && fipe > 0 ? Math.round((bid / fipe) * 100) : null,
      imageUrl: findImageUrl(),
      vehicleUrl: buildVehicleUrl(detail.code),
      message: statusText,
      observedAt: new Date().toISOString(),
    };
  }

  function extractCurrentVehicleDetail() {
    const detailMarkup = getVehicleDetailMarkup();
    const fallbackValues = {
      ...extractDetailFromText(getSearchText()),
      ...extractDetailFromText(htmlToText(detailMarkup) ?? ""),
      ...extractDetailFromMarkup(detailMarkup),
    };
    const containers = getElements([
      ".vehicle-detail-container",
      ".current-vehicle-container",
      "colibri-auctions-g2-bidding-tool-vehicle-detail",
    ]).slice(0, 6);

    for (const container of containers) {
      const values = extractDetailRows(container);
      if (values.description || values.code || values.auctionLotRaw) return { ...fallbackValues, ...values };
    }

    return fallbackValues;
  }

  function extractDetailRows(container) {
    const values = {};

    for (const root of getReadableRoots(container)) {
      for (const row of safeQueryAll(root, ".data-container")) {
        const label = normalizeLabel(row.querySelector(".data-title")?.textContent);
        const value = normalizeText(row.querySelector(".data-value")?.textContent);

        if (!label || !value) continue;

        if (label === "leilao lote") values.auctionLotRaw = value;
        if (label === "codigo") values.code = value;
        if (label === "descricao") values.description = value;
        if (label === "versao") values.version = value;
        if (label === "fabricacao modelo") values.yearModel = normalizeYearModel(value);
        if (label === "marca") values.brand = value;
        if (label === "modelo") values.model = value;
        if (label === "categoria") values.category = value;
        if (label === "fipe") values.fipeRaw = extractMoneyText(value) ?? value;
        if (label === "tipo de monta") values.damage = value;
        if (label === "condicao") values.condition = value;
        if (label === "patio") values.yard = value;
      }
    }

    return values;
  }

  function extractDetailFromMarkup(rawMarkup) {
    const markup = typeof rawMarkup === "string" ? rawMarkup : "";
    const fipeRaw = readDataValueFromMarkup(markup, "FIPE:");

    return removeEmptyValues({
      auctionLotRaw: readDataValueFromMarkup(markup, "Leil[aã]o\\s*\\/\\s*Lote:"),
      code: readDataValueFromMarkup(markup, "C[oó]digo:"),
      description: readDataValueFromMarkup(markup, "Descri[cç][aã]o:"),
      version: readDataValueFromMarkup(markup, "Vers[aã]o:"),
      yearModel: normalizeYearModel(readDataValueFromMarkup(markup, "Fabrica[cç][aã]o\\s*\\/\\s*Modelo:")),
      brand: readDataValueFromMarkup(markup, "Marca:"),
      model: readDataValueFromMarkup(markup, "Modelo:"),
      category: readDataValueFromMarkup(markup, "Categoria:"),
      fipeRaw: extractMoneyText(fipeRaw) ?? fipeRaw,
      damage: readDataValueFromMarkup(markup, "Tipo de Monta:"),
      condition: readDataValueFromMarkup(markup, "Condi[cç][aã]o:"),
      yard: readDataValueFromMarkup(markup, "P[aá]tio:"),
    });
  }

  function extractDetailFromText(rawText) {
    const text = normalizeText(rawText) ?? "";

    return removeEmptyValues({
      auctionLotRaw: findTextValue(text, /Leil[aã]o\s*\/\s*Lote:\s*([A-Za-z0-9.-]+\s*\/\s*[A-Za-z0-9.-]+)/i),
      lot: findTextValue(text, /\bLote\s*(?:ao vivo|atual)?:\s*([A-Za-z0-9.-]+)/i),
      code: findTextValue(text, /C[oó]digo(?:\s+Copart)?:\s*([A-Za-z0-9.-]+)/i),
      description: findTextValue(text, /Descri[cç][aã]o:\s*(.*?)\s+Vers[aã]o:/i),
      version: findTextValue(text, /Vers[aã]o:\s*(.*?)\s+Fabrica[cç][aã]o\s*\/\s*Modelo:/i),
      yearModel: normalizeYearModel(findTextValue(text, /Fabrica[cç][aã]o\s*\/\s*Modelo:\s*(\d{4}\s*\/\s*\d{4}|\d{4}\/\d{4})/i)),
      brand: findTextValue(text, /Marca:\s*(.*?)\s+Modelo:/i),
      model: findTextValue(text, /Marca:\s*.*?\s+Modelo:\s*(.*?)\s+Categoria:/i),
      category: findTextValue(text, /Categoria:\s*(.*?)\s+FIPE:/i),
      fipeRaw: extractMoneyText(findTextValue(text, /FIPE:\s*(R\$\s*[\d.,]+)/i) ?? ""),
      damage: findTextValue(text, /Tipo de Monta:\s*(.*?)\s+Tipo de Chassi:/i),
      condition: findTextValue(text, /Condi[cç][aã]o:\s*(.*?)\s+Condi[cç][aã]o Func\.:/i) ?? findTextValue(text, /Condi[cç][aã]o:\s*(.*?)\s+(?:N[uú]mero do Chassi|Chave|P[aá]tio):/i),
      yard: findTextValue(text, /P[aá]tio:\s*(.*?)\s+Comitente:/i),
    });
  }

  function readDataValueFromMarkup(markup, labelPattern) {
    const titleClass = String.raw`(?:^|\s)data-title(?:\s|$)`;
    const valueClass = String.raw`(?:^|\s)data-value(?:\s|$)`;
    const quotedClass = String.raw`(?:"([^"]*)"|'([^']*)'|([^\s>]+))`;
    const regex = new RegExp(
      String.raw`<label\b(?=[^>]*\bclass=${quotedClass})[^>]*>\s*${labelPattern}\s*<\/label>\s*<label\b(?=[^>]*\bclass=${quotedClass})[^>]*>([\s\S]*?)<\/label>`,
      "i",
    );
    const match = regex.exec(markup);

    if (!match) return null;

    const titleClassValue = normalizeText(match[1] ?? match[2] ?? match[3]);
    const valueClassValue = normalizeText(match[4] ?? match[5] ?? match[6]);
    if (!classListMatches(titleClassValue, titleClass) || !classListMatches(valueClassValue, valueClass)) return null;

    return htmlToText(match[7]);
  }

  function extractChatState(currentLot) {
    const messages = getSystemMessages();
    let latestForCurrentLot = null;
    let latestAnyFinal = null;
    let latestBidAfterCurrentLot = null;
    let currentLotSeen = currentLot == null;

    for (const message of messages) {
      const nextLot = message.match(/\bPr[oó]ximo lote\s+([A-Za-z0-9.-]+)/i)?.[1] ?? null;
      if (nextLot && normalizeText(nextLot) === normalizeText(currentLot)) currentLotSeen = true;

      const bid = parseBidMessage(message);
      if (bid && currentLotSeen) latestBidAfterCurrentLot = bid;

      const final = parseFinalMessage(message);
      if (!final) continue;

      latestAnyFinal = final;
      if (currentLot && normalizeText(final.lot) === normalizeText(currentLot)) latestForCurrentLot = final;
    }

    return latestForCurrentLot ?? latestBidAfterCurrentLot ?? latestAnyFinal ?? {};
  }

  function getSystemMessages() {
    const messages = [];

    for (const root of getScopedRoots([
      ".chat-container",
      ".chat-bidding-container",
      "colibri-auctions-g2-bidding-tool-chat",
    ])) {
      for (const label of safeQueryAll(root, "label")) {
        const text = normalizeText(label.textContent);
        if (text && normalizeForMatch(text).startsWith("SISTEMA:")) messages.push(text);
      }
    }

    if (messages.length === 0) {
      messages.push(...extractSystemMessagesFromMarkup(getPageMarkup()));
    }

    return messages;
  }

  function extractSystemMessagesFromMarkup(markup) {
    const messages = [];
    const regex = /<label\b[^>]*>\s*(Sistema:[\s\S]*?)<\/label>/gi;
    let match = regex.exec(markup);

    while (match) {
      const message = htmlToText(match[1]);
      if (message) messages.push(message);
      match = regex.exec(markup);
    }

    return messages;
  }

  function parseFinalMessage(message) {
    const conditional = message.match(/\bVenda condicional para o lote\s+([A-Za-z0-9.-]+)\s+por\s+(R\$\s*[\d.,]+)/i);
    if (conditional) return { lot: conditional[1], bidRaw: extractMoneyText(message), message };

    const sold = message.match(/\bLote\s+([A-Za-z0-9.-]+)\s+vendido\s+por\s+(R\$\s*[\d.,]+)/i);
    if (sold) return { lot: sold[1], bidRaw: extractMoneyText(message), message };

    const notSold = message.match(/\bLote\s+([A-Za-z0-9.-]+)\s+n[aã]o foi vendido\b/i);
    if (notSold) return { lot: notSold[1], bidRaw: null, message };

    const closed = message.match(/\bOs lances para o lote\s+([A-Za-z0-9.-]+)\s+foram encerrados\b/i);
    if (closed) return { lot: closed[1], bidRaw: null, message };

    return null;
  }

  function parseBidMessage(message) {
    if (!/\b(Novo lance|Lance inicial)\b/i.test(message)) return null;

    return {
      lot: null,
      bidRaw: extractMoneyText(message),
      message,
    };
  }

  function findCurrentBidRaw() {
    for (const root of getScopedRoots([
      ".bid-container",
      "colibri-auctions-g2-bidding-tool-bid-button",
    ])) {
      for (const container of safeQueryAll(root, ".main-bid-container, .title-container")) {
        const text = normalizeText(container.textContent);
        if (!text || !normalizeForMatch(text).includes("OFERTA ATUAL")) continue;

        const money = extractMoneyText(text);
        if (money) return money;
      }
    }

    return findBidRawFromMarkup(getPageMarkup()) ?? findBidRawFromText(getSearchText());
  }

  function findBidRawFromMarkup(markup) {
    const snippet = getLastSnippetAround(markup, "Oferta atual", 0, 2500);

    return extractMoneyText(htmlToText(snippet ?? ""));
  }

  function findBidRawFromText(text) {
    return extractMoneyText(findTextValue(text, /(?:Oferta atual|Lance atual|Maior lance):?\s*(R\$\s*[\d.,]+)/i) ?? "");
  }

  function findVisibleStatusText() {
    for (const root of getScopedRoots([
      ".bid-container",
      "colibri-auctions-g2-bidding-tool-bid-button",
    ])) {
      for (const element of safeQueryAll(root, ".winning-loss")) {
        const text = normalizeText(element.textContent);
        if (text) return text;
      }
    }

    const status = findStatusFromMarkup(getPageMarkup());
    if (status) return status;

    return findStatusFromText(getSearchText());
  }

  function findStatusFromMarkup(markup) {
    const snippet = getLastSnippetAround(markup, "winning-loss", 0, 2500) ?? markup;
    const text = htmlToText(snippet) ?? "";

    return findTextValue(text, /\b(Maior lance\s*-\s*[A-Z]{2}|Condicional\s*-\s*[A-Z]{2}|Vendido\s*-\s*[A-Z]{0,2}|Repasse)\b/i);
  }

  function findStatusFromText(text) {
    const bidSnippet = getLastSnippetAround(text, "Oferta atual", 500, 1200) ?? text;

    return findTextValue(bidSnippet, /\b(Maior lance\s*-\s*[A-Z]{2}|Condicional\s*-\s*[A-Z]{2}|Vendido\s*-\s*[A-Z]{0,2}|Repasse)\b/i);
  }

  function findAuctionId() {
    try {
      return new URL(location.href).searchParams.get("auctionId");
    }
    catch {
      return null;
    }
  }

  function findImageUrl() {
    const candidates = [];

    for (const root of getScopedRoots([
      ".vehicle-pictures-container",
      ".current-vehicle-container",
      "colibri-auctions-g2-bidding-tool-vehicle-pictures",
      ".main-image",
      ".thumbnail",
      "[class*='picture']",
      "[class*='image']",
    ]).slice(0, 20)) {
      collectImageCandidatesFromRoot(root, candidates);
    }

    if (candidates.length === 0) {
      for (const html of getSearchDocumentHtml()) {
        collectImageCandidatesFromText(getSnippetAround(html, "vehicle-pictures-container", 0, 32000) ?? "", candidates, 4);
        collectImageCandidatesFromText(getSnippetAround(html, "colibri-auctions-g2-bidding-tool-vehicle-pictures", 0, 32000) ?? "", candidates, 4);
        collectImageCandidatesFromText(getSnippetAround(html, "background-image", 4000, 12000) ?? "", candidates, 2);
        collectImageCandidatesFromText(getSnippetAround(html, "thumbnail", 4000, 12000) ?? "", candidates, 2);
      }
    }

    return pickBestImageCandidate(candidates);
  }

  function collectImageCandidatesFromRoot(root, candidates) {
    if (!root) return;

    if (root.nodeType === Node.ELEMENT_NODE) {
      collectImageCandidatesFromElement(root, candidates, 3);
    }

    for (const element of safeQueryAll(root, [
      "img",
      "source",
      "[style]",
      "[srcset]",
      "[data-srcset]",
      "[data-src]",
      "[data-original]",
      "[data-lazy]",
      "[data-url]",
      "[ng-src]",
    ].join(","))) {
      collectImageCandidatesFromElement(element, candidates, scoreImageElement(element));
    }
  }

  function collectImageCandidatesFromElement(element, candidates, baseScore) {
    const attrs = [
      "currentSrc",
      "src",
      "srcset",
      "data-srcset",
      "data-src",
      "data-original",
      "data-lazy",
      "data-url",
      "ng-src",
      "style",
    ];

    for (const attr of attrs) {
      const raw = attr === "currentSrc" ? element.currentSrc : element.getAttribute?.(attr);
      collectImageCandidatesFromText(raw, candidates, baseScore);
    }

    try {
      const style = getComputedStyle(element);
      collectImageCandidatesFromText(style.backgroundImage, candidates, baseScore + 2);

      for (let index = 0; index < style.length; index += 1) {
        const property = style[index];
        if (!property || !property.startsWith("--")) continue;

        collectImageCandidatesFromText(style.getPropertyValue(property), candidates, baseScore + 1);
      }
    }
    catch {
      // Alguns roots de iframe/shadow podem negar computed style.
    }
  }

  function collectImageCandidatesFromText(raw, candidates, baseScore) {
    const text = typeof raw === "string" ? decodeHtml(raw) : "";
    if (!text) return;

    const srcsetParts = text.includes(",") ? text.split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean) : [];
    for (const part of srcsetParts) pushImageCandidate(candidates, part, baseScore + 1);

    const urlRegex = /url\((['"]?)(.*?)\1\)|(?:https?:)?\/\/[^\s"'<>),]+/gi;
    let match = urlRegex.exec(text);

    while (match) {
      pushImageCandidate(candidates, match[2] ?? match[0], baseScore);
      match = urlRegex.exec(text);
    }

    pushImageCandidate(candidates, text, baseScore);
  }

  function pushImageCandidate(candidates, raw, baseScore) {
    const url = normalizeImageUrl(raw);
    if (!url) return;

    candidates.push({
      url,
      score: baseScore + scoreImageUrl(url),
    });
  }

  function pickBestImageCandidate(candidates) {
    const byUrl = new Map();

    for (const candidate of candidates) {
      const current = byUrl.get(candidate.url);
      if (!current || candidate.score > current.score) byUrl.set(candidate.url, candidate);
    }

    return Array.from(byUrl.values())
      .filter((candidate) => candidate.score > -5)
      .sort((a, b) => b.score - a.score)[0]?.url ?? null;
  }

  function scoreImageElement(element) {
    const className = normalizeForMatch(element.className ?? "");
    const width = Number(element.naturalWidth ?? element.clientWidth ?? element.width ?? 0);
    const height = Number(element.naturalHeight ?? element.clientHeight ?? element.height ?? 0);
    let score = 0;

    if (className.includes("THUMB")) score += 4;
    if (className.includes("MAIN") || className.includes("VEHICLE") || className.includes("PICTURE")) score += 3;
    if (width >= 120 && height >= 80) score += 4;
    if ((width > 0 && width < 48) || (height > 0 && height < 48)) score -= 6;

    return score;
  }

  function scoreImageUrl(url) {
    const text = normalizeForMatch(url);
    let score = 0;

    if (text.includes("COPART")) score += 4;
    if (text.includes("THUMB") || text.includes("IMAGE") || text.includes("PHOTO") || text.includes("PIX")) score += 3;
    if (text.includes("LOT")) score += 2;
    if (/\.(JPE?G|PNG|WEBP)(\?|#|$)/i.test(url)) score += 2;
    if (/LOGO|ICON|SPRITE|PLACEHOLDER|NO-IMAGE|FACEBOOK|INSTAGRAM|YOUTUBE|LINKEDIN/i.test(url)) score -= 12;
    if (/\.SVG(\?|#|$)/i.test(url)) score -= 12;

    return score;
  }

  function normalizeImageUrl(raw) {
    const text = normalizeText(raw);
    if (!text) return null;

    const cleaned = text
      .replace(/^url\((['"]?)(.*?)\1\)$/i, "$2")
      .replace(/^['"]|['"]$/g, "")
      .trim();

    if (!cleaned || /^(data|blob|chrome-extension):/i.test(cleaned)) return null;
    if (/^var\(/i.test(cleaned)) return null;

    const url = absolutizeUrl(cleaned.startsWith("//") ? `${location.protocol}${cleaned}` : cleaned);
    if (!url || !/^https?:\/\//i.test(url)) return null;
    if (!isLikelyVehicleImageUrl(url)) return null;

    return url;
  }

  function isLikelyVehicleImageUrl(url) {
    const text = normalizeForMatch(url);

    if (/LOGO|ICON|SPRITE|PLACEHOLDER|NO-IMAGE|FACEBOOK|INSTAGRAM|YOUTUBE|LINKEDIN|TWITTER|COOKIE/i.test(url)) return false;
    if (/\.SVG(\?|#|$)/i.test(url)) return false;

    return (
      /\.(JPE?G|PNG|WEBP)(\?|#|$)/i.test(url) ||
      text.includes("COPART") ||
      text.includes("IMAGE") ||
      text.includes("PHOTO") ||
      text.includes("THUMB") ||
      text.includes("PIX")
    );
  }

  function getElements(selectors) {
    const elements = [];
    const seen = new Set();

    for (const root of getSearchRoots()) {
      for (const selector of selectors) {
        for (const element of safeQueryAll(root, selector)) {
          if (seen.has(element) || element.closest?.(".clp-root")) continue;
          seen.add(element);
          elements.push(element);
        }
      }
    }

    return elements;
  }

  function getScopedRoots(selectors) {
    const roots = [];
    const seen = new Set();

    for (const element of getElements(selectors)) {
      collectRoot(element, roots, seen);
    }

    return roots;
  }

  function getReadableRoots(root) {
    const roots = [];
    const seen = new Set();

    collectRoot(root, roots, seen);
    return roots;
  }

  function collectRoot(root, roots, seen) {
    if (!root || seen.has(root)) return;

    seen.add(root);
    roots.push(root);

    for (const element of safeQueryAll(root, "*")) {
      if (state.root && element.closest?.(".clp-root")) continue;
      if (element.shadowRoot) collectRoot(element.shadowRoot, roots, seen);
      if (element.tagName === "TEMPLATE" && element.content) collectRoot(element.content, roots, seen);
    }
  }

  function safeQueryAll(root, selector) {
    if (!root || typeof root.querySelectorAll !== "function") return [];

    try {
      return Array.from(root.querySelectorAll(selector));
    }
    catch {
      return [];
    }
  }

  function getPageMarkup() {
    if (state.markupCache != null) return state.markupCache;

    const parts = [];

    for (const root of getScopedRoots([
      ".vehicle-detail-container",
      ".chat-bidding-container",
      ".bid-container",
      "colibri-auctions-g2-bidding-tool-vehicle-detail",
      "colibri-auctions-g2-bidding-tool-chat",
      "colibri-auctions-g2-bidding-tool-bid-button",
    ]).slice(0, 24)) {
      const markup = readRootMarkup(root);
      if (markup) parts.push(markup);
    }

    for (const html of getSearchDocumentHtml()) {
      appendSnippet(parts, getBlockById(html, "chatMessageContainer"));
      appendSnippet(parts, getSnippetAround(html, "vehicle-detail-container", 0, 26000));
      appendSnippet(parts, getSnippetAround(html, "Leilao / Lote:", 2500, 12000));
      appendSnippet(parts, getLastSnippetAround(html, "Oferta atual", 4000, 8000));
      appendSnippet(parts, getLastSnippetAround(html, "winning-loss", 4000, 8000));
    }

    state.markupCache = parts.join(" ");
    return state.markupCache;
  }

  function getVehicleDetailMarkup() {
    const parts = [];

    for (const root of getScopedRoots([
      ".vehicle-detail-container",
      ".current-vehicle-container",
      "colibri-auctions-g2-bidding-tool-vehicle-detail",
    ]).slice(0, 16)) {
      const markup = readRootMarkup(root);
      if (markup) parts.push(markup);
    }

    for (const html of getSearchDocumentHtml()) {
      appendSnippet(parts, getSnippetAround(html, "vehicle-detail-container", 0, 26000));
      appendSnippet(parts, getSnippetAround(html, "Leilao / Lote:", 2500, 14000));
      appendSnippet(parts, getSnippetAround(html, "Leilão / Lote:", 2500, 14000));
      appendSnippet(parts, getSnippetAround(html, "Descrição:", 3500, 14000));
      appendSnippet(parts, getSnippetAround(html, "C&oacute;digo:", 2500, 14000));
      appendSnippet(parts, getSnippetAround(html, "Código:", 2500, 14000));
    }

    return parts.join(" ");
  }

  function getSearchDocumentHtml() {
    return getSearchRoots()
      .map(readRootMarkup)
      .filter(Boolean);
  }

  function getSearchText() {
    if (state.textCache != null) return state.textCache;

    const parts = [];

    for (const root of getSearchRoots()) {
      const text = normalizeText(root.body?.innerText ?? root.body?.textContent ?? root.textContent ?? "");
      if (text) parts.push(text.slice(0, 120000));
    }

    state.textCache = parts.join(" ");
    return state.textCache;
  }

  function getSearchRoots() {
    const roots = [];
    const seen = new Set();

    for (const doc of getSearchDocuments()) {
      collectSearchRoot(doc, roots, seen);
    }

    return roots;
  }

  function getSearchRootsFromRoot(root) {
    const roots = [];
    const seen = new Set();

    collectSearchRoot(root, roots, seen);
    return roots;
  }

  function collectSearchRoot(root, roots, seen) {
    if (!root || seen.has(root) || roots.length >= 80) return;

    seen.add(root);
    roots.push(root);

    for (const element of safeQueryAll(root, "*")) {
      if (state.root && element.closest?.(".clp-root")) continue;
      if (element.shadowRoot) collectSearchRoot(element.shadowRoot, roots, seen);
      if (element.tagName === "TEMPLATE" && element.content) collectSearchRoot(element.content, roots, seen);
      if (roots.length >= 80) return;
    }
  }

  function getSearchDocuments() {
    const docs = [];
    const seen = new Set();

    collectSearchDocument(getRootDocument(), docs, seen);
    return docs;
  }

  function collectSearchDocument(doc, docs, seen) {
    if (!doc || seen.has(doc)) return;

    seen.add(doc);
    docs.push(doc);

    for (const frame of safeQueryAll(doc, "iframe")) {
      const frameDoc = getFrameDocument(frame);
      if (frameDoc) collectSearchDocument(frameDoc, docs, seen);
    }
  }

  function getFrameDocument(frame) {
    try {
      return frame.contentDocument ?? frame.contentWindow?.document ?? null;
    }
    catch {
      return null;
    }
  }

  function getRootDocument() {
    try {
      return window.top?.document ?? document;
    }
    catch {
      return document;
    }
  }

  function waitForFrameDocuments() {
    const frames = safeQueryAll(getRootDocument(), "iframe");
    const pendingFrames = frames.filter((frame) => {
      const frameDoc = getFrameDocument(frame);
      if (!frameDoc) return false;

      return frameDoc.readyState === "loading" || !normalizeText(frameDoc.body?.innerText ?? frameDoc.body?.textContent ?? "");
    });

    if (pendingFrames.length === 0) return Promise.resolve();

    return new Promise((resolve) => {
      let resolved = false;

      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };

      window.setTimeout(done, 450);

      for (const frame of pendingFrames) {
        frame.addEventListener("load", done, { once: true });
      }
    });
  }

  function readRootMarkup(root) {
    if (!root) return null;

    if (root.nodeType === Node.DOCUMENT_NODE) {
      return root.documentElement?.innerHTML ?? null;
    }

    if (root.nodeType === Node.ELEMENT_NODE) {
      if (state.root && root.closest?.(".clp-root")) return null;
      return root.outerHTML ?? root.innerHTML ?? null;
    }

    if ("innerHTML" in root && typeof root.innerHTML === "string") {
      return root.innerHTML;
    }

    if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      return Array.from(root.childNodes).map(serializeNode).join(" ");
    }

    return null;
  }

  function appendSnippet(parts, snippet) {
    const text = normalizeText(snippet);
    if (text) parts.push(text);
  }

  function getBlockById(html, id) {
    const start = html.indexOf(`id=${id}`);
    const quotedStart = start >= 0 ? start : html.indexOf(`id="${id}"`);
    const singleQuotedStart = quotedStart >= 0 ? quotedStart : html.indexOf(`id='${id}'`);
    if (singleQuotedStart < 0) return null;

    const blockStart = html.lastIndexOf("<div", singleQuotedStart);
    if (blockStart < 0) return getSnippetAt(html, singleQuotedStart, 0, 70000);

    const blockEnd = html.indexOf("</div>", singleQuotedStart);
    if (blockEnd < 0) return getSnippetAt(html, blockStart, 0, 70000);

    return html.slice(blockStart, Math.min(html.length, blockEnd + 6));
  }

  function getSnippetAround(html, marker, before, after) {
    const index = html.indexOf(marker);
    if (index < 0) return null;

    return getSnippetAt(html, index, before, after);
  }

  function getLastSnippetAround(html, marker, before, after) {
    const index = html.lastIndexOf(marker);
    if (index < 0) return null;

    return getSnippetAt(html, index, before, after);
  }

  function getSnippetAt(html, index, before, after) {
    const start = Math.max(0, index - before);
    const end = Math.min(html.length, index + after);

    return html.slice(start, end);
  }

  function serializeNode(node) {
    if (node.nodeType === Node.ELEMENT_NODE) return node.outerHTML ?? "";
    return node.textContent ?? "";
  }

  function htmlToText(html) {
    if (typeof html !== "string") return null;

    const decoded = decodeHtml(html).replace(/&amp;nbsp;|&nbsp;|&#160;/gi, " ");
    const stripped = decodeHtml(decoded)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ");

    return normalizeText(stripped);
  }

  function decodeHtml(value) {
    const textarea = document.createElement("textarea");

    textarea.innerHTML = value;
    return textarea.value;
  }

  function parseAuctionAndLot(raw) {
    const text = normalizeText(raw);
    if (!text) return { auctionId: null, lot: null };

    const match = text.match(/([A-Za-z0-9.-]+)\s*\/\s*([A-Za-z0-9.-]+)/);
    if (!match) return { auctionId: null, lot: text };

    return {
      auctionId: match[1],
      lot: match[2],
    };
  }

  function inferSaleStatus(message) {
    const text = normalizeForMatch(message ?? "");

    if (text.includes("CONDICIONAL")) return "conditional";
    if (text.includes("NAO VENDIDO") || text.includes("NAO FOI VENDIDO")) return "not_sold";
    if (text.includes("VENDIDO") || text.includes("ARREMATADO")) return "sold";
    if (text.includes("LANCE") || text.includes("OFERTA ATUAL") || text.includes("MAIOR LANCE")) return "open";

    return null;
  }

  function inferEventType(input) {
    const text = normalizeForMatch(input.message ?? "");

    if (input.saleStatus === "sold" || input.saleStatus === "conditional") return "sale";
    if (input.saleStatus === "not_sold") return "closed";
    if (text.includes("NAO FOI VENDIDO") || text.includes("ENCERRADO")) return "closed";
    if (input.bid != null || text.includes("LANCE")) return "bid";

    return "snapshot";
  }

  function parseMoney(raw) {
    const text = normalizeText(raw);
    if (!text) return null;

    const match = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/);
    if (!match) return null;

    const value = Number.parseFloat(match[1].replace(/\./g, "").replace(",", "."));
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  function extractMoneyText(raw) {
    const text = normalizeText(raw);
    if (!text) return null;

    const match = text.match(/R\$\s*\d{1,3}(?:\.\d{3})*(?:,\d{2})?|R\$\s*\d+(?:,\d{2})?/i);
    return match ? normalizeText(match[0]) : null;
  }

  function findTextValue(text, regex) {
    const match = regex.exec(text);
    return normalizeText(match?.[1] ?? null);
  }

  function normalizeYearModel(value) {
    const text = normalizeText(value);
    return text ? text.replace(/\s*\/\s*/g, " / ") : null;
  }

  function normalizeLabel(value) {
    return normalizeForMatch(value ?? "")
      .replace(/:/g, "")
      .replace(/[^A-Z0-9]+/g, " ")
      .trim()
      .toLowerCase();
  }

  function normalizeText(value) {
    if (typeof value !== "string") return null;

    const text = value
      .replace(/&amp;nbsp;|&nbsp;|&#160;/gi, " ")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return text || null;
  }

  function normalizeForMatch(value) {
    return String(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function classListMatches(value, pattern) {
    if (!value) return false;

    return new RegExp(pattern).test(value);
  }

  function removeEmptyValues(value) {
    const output = {};

    for (const [key, item] of Object.entries(value)) {
      if (item != null) output[key] = item;
    }

    return output;
  }

  function isRecord(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function coalesceText(...values) {
    for (const value of values) {
      const text = normalizeText(value);
      if (text) return text;
    }

    return null;
  }

  function absolutizeUrl(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;

    try {
      return new URL(raw.trim(), location.href).toString();
    }
    catch {
      return raw.trim();
    }
  }

  function buildVehicleUrl(code) {
    const normalized = typeof code === "string" ? code.replace(/\D/g, "") : "";
    return normalized ? `https://www.copart.com.br/lot/${normalized}` : null;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isSupportedPage() {
    try {
      const url = new URL(location.href);

      if (url.protocol === "file:") {
        return decodeURIComponent(url.pathname)
          .replace(/\\/g, "/")
          .toLowerCase()
          .includes("/.extension/copart-live-collector/exemples/");
      }

      if (url.protocol === "about:" && window.top !== window) return true;

      if (url.protocol !== "http:" && url.protocol !== "https:") return false;

      const host = url.hostname;
      return host === "copart.com.br" || host.endsWith(".copart.com.br") || host === "copart.com" || host.endsWith(".copart.com");
    }
    catch {
      return false;
    }
  }
})();
