(() => {
  if (window.__liveAuctionCollector) return;
  window.__liveAuctionCollector = true;

  const DATABASE_INGEST_ENDPOINT = "https://picareta-bot.felss.dev/api/vehicles/ingest";
  const FINAL_SALE_STATUSES = new Set(["sold", "conditional", "not_sold"]);
  const INVALID_COPART_LOT_CANDIDATES = new Set(["SEU", "SUA", "LANCE", "OFERTA", "ATUAL", "VIVO", "AGORA"]);
  const SETTINGS_STORAGE_KEY = "liveAuctionCollector:settings:v2";
  const DEFAULT_SETTINGS = {
    autoSaveStates: ["PR", "SC", "RS", "SP"],
    allowedCategories: [],
    allowTrucks: true,
    allowMotorcycles: true,
    requireDetectedState: true,
  };
  const TRUCK_CATEGORY_KEYS = new Set(["CAMINHAO", "CAMINHOES", "CAMINHOES LEVES", "CAMINHOES PESADOS", "CAMINHOES PEQUENOS", "CAMINHOES E REBOCADORES", "REBOCADOR", "REBOCADORES", "ONIBUS", "MICROONIBUS", "ONIBUS E MICROONIBUS"]);
  const MOTORCYCLE_CATEGORY_KEYS = new Set(["MOTO", "MOTOS", "MOTOCICLETA", "MOTOCICLETAS"]);
  const BRAZIL_STATE_CODES = new Set(["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"]);
  const SORTED_BRAZIL_STATE_CODES = [...BRAZIL_STATE_CODES].sort();
  const DEFAULT_ACTIVE_INTERVAL_MS = 15000;
  const VIP_ACTIVE_INTERVAL_MS = 2500;
  const DEFAULT_ACTIVE_DEBOUNCE_MS = 300;
  const COPART_ACTIVE_DEBOUNCE_MS = 120;
  const VIP_ACTIVE_DEBOUNCE_MS = 60;
  const SODRE_SYNC_RETRY_MS = 1500;
  const SODRE_LOCATION_STATE_HINTS = [
    { term: "GUARULHOS", state: "SP" },
  ];
  const COPART_ADAPTER = { id: "copart", source: "copart", label: "Copart" };
  const VIP_ADAPTER = { id: "vipleiloes", source: "vipleiloes", label: "VIP Leiloes" };
  const SODRE_ADAPTER = { id: "sodre", source: "sodre", label: "Sodre Santoro" };
  const ADAPTERS = [VIP_ADAPTER, SODRE_ADAPTER, COPART_ADAPTER];
  const SODRE_SALE_STATUS_BY_CLASS = {
    "vendido": "sold",
    "condicional": "conditional",
    "nao-vendido": "not_sold",
    "repasse": "not_sold",
    "retirado": "not_sold",
    "aguardando": "open",
    "dou-lhe-uma": "open",
    "dou-lhe-duas": "open",
    "pregao": "open",
  };
  const OBSERVER_SELECTORS = [
    ".vehicle-detail-container",
    ".data-container",
    ".bid-container",
    ".main-bid-container",
    "#chatMessageContainer",
    "#evo-detalhesanuncio-tabela",
    "#evo-carrossel-principaisinformacoes",
    "#evo-oferta-valoratual",
    "#evo-oferta-tipo",
    "#evo-oferta-descricao",
    "#evo-oferta-vencedor",
    "#evo-transmissao-anunciosituacao",
    "#evo-transmissao-anunciohistorico",
    "#evo-transmissao-texto-anunciomensagem",
    "[data-bind-carrossel-anunciotitulo]",
    "[data-bind-carrossel-anunciosubtitulo1]",
    "[data-bind-carrossel-anunciosubtitulo2]",
    "#evo-hidden-eventocodigo",
    "#evo-hidden-anunciouriamigavel",
    "#evo-hidden-anuncionumero",
    "#lote_id",
    "#sincronizar",
    ".act-titulo-lote-atual",
    ".act-descricao-lote-atual",
    ".act-mensagem-lote-atual",
    ".act-valor-lance-atual",
    ".act-status-lote-atual",
  ];

  if (!isSupportedPage()) return;

  const state = {
    adapter: null,
    root: null,
    preview: null,
    status: null,
    summary: null,
    activateButton: null,
    settingsButton: null,
    settingsPanel: null,
    refreshButton: null,
    recaptureLoading: false,
    ignoredButton: null,
    ignoredPanel: null,
    ignoredList: null,
    ignoredSaveAllButton: null,
    ignoredBulkStatus: null,
    ignoredDetailsModal: null,
    ignoredDetailsTitle: null,
    ignoredDetailsTable: null,
    ignoredItems: [],
    ignoredLoading: false,
    ignoredError: null,
    ignoredLoaded: false,
    ignoredBulkSaving: false,
    ignoredBulkProgress: null,
    ignoredBulkMessage: null,
    lastIgnoredSignature: "",
    observedSignatures: new Map(),
    ignoredSignatures: new Map(),
    settingsStatesContainer: null,
    settingsCategoriesInput: null,
    settingsRequireStateInput: null,
    settings: null,
    settingsDraft: null,
    markupCache: null,
    textCache: null,
    searchDocumentsCache: null,
    searchRootsCache: null,
    activeTimer: null,
    activeDebounceTimer: null,
    activeWatchdogTimer: null,
    activeObservers: [],
    refreshing: false,
    pendingRefresh: false,
    lastSignature: "",
    assistant: null,
    assistantError: null,
    assistantLoading: false,
    assistantSignature: "",
    assistantPendingSignature: "",
    assistantTimer: null,
    assistantRequestId: 0,
    fipeOverrides: new Map(),
    active: false,
    saveMessage: null,
    savedCount: 0,
    lastSavedSignature: "",
    savingSignature: "",
    lastSodreSyncAttemptAt: 0,
    copartDetailSettleTimer: null,
    copartDetailSettleAttempts: 0,
    copartDetailSettleKey: "",
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

  document.addEventListener("visibilitychange", () => {
    if (document.hidden || !state.active) return;

    installActiveObservers();
    void refreshPreview({ forceRender: true });
  });

  function init() {
    state.adapter = getActiveAdapter();
    state.active = readStoredBoolean(getStorageKey("active"));
    state.settings = readStoredSettings();
    state.ignoredItems = readLocalCaptureItems();
    injectPanel();
    renderPlaceholder();
    renderActiveButton();
    renderRefreshButton();

    if (state.active) {
      state.saveMessage = "Restaurado";
      startActiveLoop();
      state.status.textContent = "Ativo";
      renderSummary(getCurrentPreviewEvent());
    }
  }

  function injectPanel() {
    const root = document.createElement("div");
    root.className = "clp-root";
    root.innerHTML = `
      <div class="clp-header">
        <div>
          <strong>Picareta Smart Assistant</strong>
          <span data-role="status">Inativo</span>
        </div>
        <button type="button" data-role="hide" title="Fechar">✕</button>
      </div>
      <div class="clp-summary" data-role="summary"></div>
      <div class="clp-ignored-panel" data-role="ignored-panel" hidden>
        <div class="clp-section-heading">
          <div>
            <strong>Lotes capturados</strong>
            <span>Todos os lotes identificados no leilão.</span>
          </div>
          <div class="clp-ignored-heading-actions">
            <button type="button" data-role="ignored-save-all" title="Salvar todos os lotes pendentes no banco" aria-label="Salvar todos os lotes pendentes no banco"><span class="clp-icon" aria-hidden="true">💾</span></button>
            <button type="button" data-role="ignored-refresh" title="Atualizar lotes capturados" aria-label="Atualizar lotes capturados"><span class="clp-icon" aria-hidden="true">🔄</span></button>
            <button type="button" data-role="ignored-export" title="Exportar lotes para JSON" aria-label="Exportar lotes para JSON"><span class="clp-icon" aria-hidden="true">⬇️</span></button>
            <button type="button" data-role="ignored-clear" title="Excluir todos os lotes deste leilão" aria-label="Excluir todos os lotes deste leilão"><span class="clp-icon" aria-hidden="true">🗑️</span></button>
            <button type="button" data-role="ignored-close" title="Fechar lotes capturados" aria-label="Fechar lotes capturados"><span class="clp-icon" aria-hidden="true">✕</span></button>
          </div>
        </div>
        <div class="clp-ignored-bulk-status" data-role="ignored-bulk-status" hidden></div>
        <div class="clp-ignored-list" data-role="ignored-list"></div>
      </div>
      <div class="clp-settings" data-role="settings-panel" hidden>
        <div class="clp-settings-group">
          <div class="clp-settings-label">Estados para salvar automatico</div>
          <div class="clp-settings-states" data-role="settings-states"></div>
        </div>
        <label class="clp-settings-check">
          <input type="checkbox" data-role="settings-require-state">
          <span>Bloquear lote quando nao detectar estado</span>
        </label>
        <label class="clp-settings-check">
          <input type="checkbox" data-role="settings-allow-trucks">
          <span>Habilitar caminhões na coleta automática</span>
        </label>
        <label class="clp-settings-check">
          <input type="checkbox" data-role="settings-allow-motorcycles">
          <span>Habilitar motos na coleta automática</span>
        </label>
        <div class="clp-settings-group">
          <div class="clp-settings-label">Categorias Copart (vazio = todas)</div>
          <textarea class="clp-settings-textarea" data-role="settings-categories" rows="2" placeholder="Deixe vazio para aceitar todas as categorias"></textarea>
        </div>
        <div class="clp-settings-actions">
          <button type="button" data-role="settings-reset" title="Restaurar configuração padrão" aria-label="Restaurar configuração padrão"><span class="clp-icon" aria-hidden="true">↺</span></button>
          <button type="button" class="clp-primary" data-role="settings-save" title="Salvar configuração" aria-label="Salvar configuração"><span class="clp-icon" aria-hidden="true">✓</span></button>
        </div>
      </div>
      <div class="clp-actions">
        <button type="button" class="clp-primary" data-role="toggle-active" title="Ativar coleta" aria-label="Ativar coleta"><span class="clp-icon" aria-hidden="true">▶</span></button>
        <button type="button" data-role="refresh" title="Atualizar lote" aria-label="Atualizar lote"><span class="clp-icon" aria-hidden="true">🔄</span></button>
        <button type="button" data-role="toggle-settings" title="Abrir configuração" aria-label="Abrir configuração"><span class="clp-icon" aria-hidden="true">⚙️</span></button>
        <button type="button" data-role="toggle-ignored" title="Abrir lotes capturados" aria-label="Abrir lotes capturados"><span class="clp-icon" aria-hidden="true">🗂️</span></button>
      </div>
      <pre class="clp-preview" data-role="preview" hidden>{}</pre>
    `;

    document.documentElement.appendChild(root);

    const detailsModal = document.createElement("div");
    detailsModal.className = "clp-details-modal";
    detailsModal.hidden = true;
    detailsModal.setAttribute("data-role", "ignored-details-modal");
    detailsModal.innerHTML = `
      <section class="clp-details-dialog" role="dialog" aria-modal="true" aria-labelledby="clp-details-title">
        <div class="clp-details-header">
          <div>
            <strong id="clp-details-title" data-role="ignored-details-title">Dados do lote</strong>
            <span>Todos os campos armazenados no JSON da captura.</span>
          </div>
          <button type="button" data-role="ignored-details-close" title="Fechar dados do lote" aria-label="Fechar dados do lote">✕</button>
        </div>
        <div class="clp-details-table-wrap" data-role="ignored-details-table"></div>
        <div class="clp-details-footer">
          <button type="button" data-role="ignored-details-close">Fechar</button>
        </div>
      </section>
    `;
    document.documentElement.appendChild(detailsModal);

    state.root = root;
    state.preview = root.querySelector('[data-role="preview"]');
    state.status = root.querySelector('[data-role="status"]');
    state.summary = root.querySelector('[data-role="summary"]');
    state.activateButton = root.querySelector('[data-role="toggle-active"]');
    state.refreshButton = root.querySelector('[data-role="refresh"]');
    state.settingsButton = root.querySelector('[data-role="toggle-settings"]');
    state.settingsPanel = root.querySelector('[data-role="settings-panel"]');
    state.settingsStatesContainer = root.querySelector('[data-role="settings-states"]');
    state.settingsCategoriesInput = root.querySelector('[data-role="settings-categories"]');
    state.settingsRequireStateInput = root.querySelector('[data-role="settings-require-state"]');
    state.settingsAllowTrucksInput = root.querySelector('[data-role="settings-allow-trucks"]');
    state.settingsAllowMotorcyclesInput = root.querySelector('[data-role="settings-allow-motorcycles"]');
    state.ignoredButton = root.querySelector('[data-role="toggle-ignored"]');
    state.ignoredPanel = root.querySelector('[data-role="ignored-panel"]');
    state.ignoredList = root.querySelector('[data-role="ignored-list"]');
    state.ignoredSaveAllButton = root.querySelector('[data-role="ignored-save-all"]');
    state.ignoredBulkStatus = root.querySelector('[data-role="ignored-bulk-status"]');
    state.ignoredDetailsModal = detailsModal;
    state.ignoredDetailsTitle = detailsModal.querySelector('[data-role="ignored-details-title"]');
    state.ignoredDetailsTable = detailsModal.querySelector('[data-role="ignored-details-table"]');

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const roleTarget = target.closest("[data-role]");
      const role = roleTarget?.getAttribute("data-role");
      if (role === "refresh") {
        if (isCopartLotPage()) void recaptureCurrentLot();
        else void refreshPreview({ forceRender: true });
      }
      if (role === "toggle-active") toggleActive();
      if (role === "toggle-settings") toggleSettingsPanel();
      if (role === "toggle-ignored") void toggleIgnoredPanel();
      if (role === "ignored-save-all") void saveAllIgnoredLots();
      if (role === "ignored-refresh") void refreshIgnoredLots();
      if (role === "ignored-export") void exportIgnoredLots();
      if (role === "ignored-clear") clearIgnoredLots();
      if (role === "ignored-close") closeIgnoredPanel();
      if (role === "ignored-reprocess") void reprocessIgnoredLot(roleTarget);
      if (role === "ignored-details") showIgnoredDetails(roleTarget);
      if (role === "ignored-delete") deleteIgnoredLot(roleTarget);
      if (role === "settings-save") saveSettingsFromForm();
      if (role === "settings-reset") resetSettingsForm();
      if (role === "settings-state-chip") toggleSettingsStateChip(roleTarget);
      if (role === "hide") hidePanel();
    });

    detailsModal.addEventListener("click", (event) => {
      const target = event.target;
      if (target === detailsModal) {
        closeIgnoredDetails();
        return;
      }
      if (target instanceof Element && target.closest('[data-role="ignored-details-close"]')) {
        closeIgnoredDetails();
      }
    });
    detailsModal.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeIgnoredDetails();
    });

    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.target instanceof Element)) return;
    });
  }

  function hidePanel() {
    state.active = false;
    writeStoredBoolean(getStorageKey("active"), false);
    stopActiveLoop();
    closeIgnoredDetails();
    renderActiveButton();
    state.status.textContent = "Inativo";
    if (state.root) state.root.hidden = true;
  }

  async function refreshPreview(options = {}) {
    if (state.refreshing) {
      if (state.active) state.pendingRefresh = true;
      return null;
    }

    state.refreshing = true;
    state.markupCache = null;
    state.textCache = null;
    state.searchDocumentsCache = null;
    state.searchRootsCache = null;
    state.status.textContent = "Lendo lote";

    try {
      ensureSodreSynchronization();
      await waitForFrameDocuments();

      const localEvent = buildPreviewEvent();
      const frameEvents = await requestFrameSnapshots();
      const mergedEvent = mergeWithFallback(selectBestEvent([localEvent, ...frameEvents]), localEvent);
      const event = applyFipeOverride(mergedEvent);
      const signature = getEventSignature(event);
      const shouldRender = options.forceRender || signature !== state.lastSignature;

      if (shouldRender) {
        state.lastSignature = signature;
        state.preview.textContent = JSON.stringify(event, null, 2);
        renderSummary(event);
        scheduleAssistantRefresh(event);
      }

      if (state.active && !options.skipSave) {
        const saveStateChanged = await maybeSaveEvent(event);
        if (saveStateChanged || shouldRender) renderSummary(event);
      }

      scheduleCopartDetailSettling(event);

      state.status.textContent = state.active
        ? "Ativo"
        : event.description ? "Atualizado" : "Sem lote";

      return event;
    }
    finally {
      state.refreshing = false;
      if (state.pendingRefresh && state.active) {
        state.pendingRefresh = false;
        window.setTimeout(() => {
          void refreshPreview();
        }, 0);
      }
    }
  }

  function renderPlaceholder() {
    const event = createEmptyEvent();

    state.preview.textContent = JSON.stringify(event, null, 2);
    state.status.textContent = "Inativo";
    renderSummary(event);
  }

  function createEmptyEvent() {
    const adapter = getActiveAdapter();

    return {
      source: adapter.source,
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
      consignor: null,
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
    const adapter = getAdapterForEvent(event);
    const assistantVehicle = isRecord(state.assistant?.vehicle) ? state.assistant.vehicle : null;
    const metrics = isRecord(state.assistant?.metrics) ? state.assistant.metrics : null;
    const marketAnalysis = isRecord(metrics?.marketAnalysis) ? metrics.marketAnalysis : null;
    const baseFeeEstimate = isRecord(metrics?.feeEstimate) ? metrics.feeEstimate : null;
    const brand = assistantVehicle?.brand ?? event.brand;
    const model = assistantVehicle?.model ?? event.model;
    const year = assistantVehicle?.year ?? extractLatestYear(event.yearModel);
    const imageUrl = event.imageUrl ?? assistantVehicle?.imageUrl;
    const title = [brand, model].filter(Boolean).join(" ") || event.description || "Aguardando lote";
    const subtitle = event.description && normalizeForMatch(event.description) !== normalizeForMatch(title)
      ? event.description
      : null;
    const bid = numberOrNull(event.bid ?? assistantVehicle?.bid);
    const fipe = numberOrNull(assistantVehicle?.fipe ?? event.fipe);
    const feeEstimate = buildReactiveFeeEstimate(baseFeeEstimate, bid);
    const fipePercent = calculatePercent(bid, fipe);
    const total = numberOrNull(feeEstimate?.total);
    const totalFipePercent = calculatePercent(total, fipe);
    const averageSoldPct = numberOrNull(marketAnalysis?.averagePct);
    const averageConditionalPct = numberOrNull(marketAnalysis?.conditionalAveragePct);
    const averageSoldValue = averageSoldPct != null && fipe != null ? Math.round(fipe * averageSoldPct / 100) : null;
    const averageConditionalValue = averageConditionalPct != null && fipe != null ? Math.round(fipe * averageConditionalPct / 100) : null;
    const status = getStatusPresentation(event.saleStatus);
    const matched = state.assistant?.matched === true;
    const maxBid = numberOrNull(marketAnalysis?.maxBid);
    const marketStatus = maxBid != null && bid != null
      ? bid <= maxBid ? "within" : "above"
      : null;
    const assistantMessage = state.assistantLoading
      ? '<div class="clp-assistant-loading">Consultando histórico e indicadores...</div>'
      : state.assistantError
        ? `<div class="clp-assistant-error">${escapeHtml(state.assistantError)}</div>`
        : "";
    const analysisHtml = marketAnalysis
      ? `
        <div class="clp-ai-card" data-status="${escapeHtml(marketStatus ?? "neutral")}">
          <div class="clp-ai-heading">
            <span>ANÁLISE IA</span>
            <strong>${escapeHtml(formatMoneyValue(numberOrNull(marketAnalysis.maxBid)))}</strong>
          </div>
          <div class="clp-ai-copy">Lance máximo recomendado${marketStatus === "within" ? " · lance atual dentro do limite" : marketStatus === "above" ? " · lance atual acima do limite" : ""}</div>
          <div class="clp-ai-meta">Venda: ${escapeHtml(formatMoneyValue(averageSoldValue))} (${escapeHtml(averageSoldPct != null ? `${averageSoldPct}% FIPE` : "sem média")}) · Condicional: ${escapeHtml(formatMoneyValue(averageConditionalValue))} (${escapeHtml(averageConditionalPct != null ? `${averageConditionalPct}% FIPE` : "sem amostra")}) · total alvo ${escapeHtml(formatMoneyValue(numberOrNull(marketAnalysis.maxTotal)))} · ${escapeHtml(numberOrNull(marketAnalysis.sampleSize) != null ? `${marketAnalysis.sampleSize} vendidos` : "sem amostra")}${typeof marketAnalysis.basisLabel === "string" && marketAnalysis.basisLabel ? ` · ${escapeHtml(marketAnalysis.basisLabel)}` : ""}</div>
        </div>
      `
      : !state.assistantLoading && fipe != null
        ? '<div class="clp-ai-empty">Histórico insuficiente para calcular o lance recomendado.</div>'
        : "";
    const collectorNote = state.saveMessage
      ? `<div class="clp-collector-note">${escapeHtml(state.saveMessage)}${state.savedCount > 0 ? ` · ${state.savedCount} salvo(s)` : ""}</div>`
      : "";

    state.summary.innerHTML = `
      <div class="clp-vehicle-head">
        <div class="clp-vehicle-identity">
          ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" data-clp-vehicle-image>` : ""}
          <div class="clp-vehicle-title">
            <span class="clp-eyebrow">${escapeHtml(adapter.label)} · lote ${escapeHtml(event.lot ?? event.code ?? "-")}</span>
            <strong>${escapeHtml(title)}</strong>
            ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ""}
          </div>
        </div>
        <span class="clp-status-badge" data-status="${escapeHtml(status.key)}" title="${escapeHtml(event.message ?? status.label)}">${escapeHtml(status.label)}</span>
      </div>
      <div class="clp-tags">
        ${year ? `<span>${escapeHtml(year)}</span>` : ""}
        ${(assistantVehicle?.damage ?? event.damage) ? `<span>${escapeHtml(assistantVehicle?.damage ?? event.damage)}</span>` : ""}
        ${event.category ? `<span>${escapeHtml(event.category)}</span>` : ""}
        ${matched ? '<span class="clp-match-tag">Base encontrada</span>' : ""}
      </div>
      <div class="clp-metrics">
        <div><span>Lance atual</span><strong>${escapeHtml(formatMoneyValue(bid))}</strong></div>
        <div><span>FIPE</span><strong>${escapeHtml(formatMoneyValue(fipe))}</strong><small>${fipePercent != null ? `${escapeHtml(fipePercent)}% da FIPE` : "não informada"}</small></div>
        <div><span>Total + taxas</span><strong>${escapeHtml(formatMoneyValue(total))}</strong><small>${totalFipePercent != null ? `${escapeHtml(totalFipePercent)}% da FIPE` : feeEstimate ? `+ ${escapeHtml(formatMoneyValue(numberOrNull(feeEstimate.feesTotal)))}` : "aguardando lance"}</small></div>
      </div>
      ${analysisHtml}
      ${assistantMessage}
      <div class="clp-details">
        ${event.consignor ? `<span><b>Comitente</b>${escapeHtml(event.consignor)}</span>` : ""}
        ${event.yard ? `<span><b>Pátio</b>${escapeHtml(event.yard)}</span>` : ""}
        ${event.condition ? `<span><b>Condição</b>${escapeHtml(event.condition)}</span>` : ""}
      </div>
      ${collectorNote}
    `;

    const vehicleImage = state.summary.querySelector("[data-clp-vehicle-image]");
    if (vehicleImage) {
      vehicleImage.addEventListener("error", () => {
        const fallbackUrl = findImageUrl();
        if (fallbackUrl && fallbackUrl !== imageUrl) {
          vehicleImage.setAttribute("src", fallbackUrl);
          return;
        }

        vehicleImage.remove();
      });
    }

    renderSaveSignal(event);
  }

  function renderSaveSignal(event) {
    if (!state.summary) return;
    const decision = getSaveDecision(event);
    const note = state.summary.querySelector(".clp-collector-note");
    if (!note && decision.pending) {
      const signal = document.createElement("div");
      signal.className = "clp-collector-note";
      signal.textContent = decision.reason;
      state.summary.appendChild(signal);
    }
  }

  function scheduleAssistantRefresh(event, options = {}) {
    if (state.assistantTimer) {
      window.clearTimeout(state.assistantTimer);
      state.assistantTimer = null;
    }

    if (!event.brand && !event.model && !event.code && !event.lot) {
      state.assistant = null;
      state.assistantError = null;
      state.assistantLoading = false;
      renderSummary(event);
      return;
    }

    const signature = getAssistantSignature(event);
    if (!options.force && signature === state.assistantSignature && state.assistant) return;
    if (!options.force && signature === state.assistantPendingSignature) return;

    const requestId = ++state.assistantRequestId;
    state.assistantPendingSignature = signature;
    if (signature !== state.assistantSignature || options.force) {
      state.assistant = null;
      state.assistantError = null;
      state.assistantLoading = true;
      renderSummary(event);
    }

    const delay = options.immediate ? 0 : 500;
    state.assistantTimer = window.setTimeout(() => {
      state.assistantTimer = null;
      void refreshAssistant(event, signature, requestId);
    }, delay);
  }

  async function refreshAssistant(event, signature, requestId) {
    state.assistantLoading = true;
    state.assistantError = null;
    renderSummary(event);

    const response = await requestLocalApi("/api/vehicles/live-assistant", {
      method: "POST",
      body: event,
    });

    if (requestId !== state.assistantRequestId || signature !== getAssistantSignature(getCurrentPreviewEvent())) return;

    state.assistantLoading = false;
    state.assistantPendingSignature = "";
    if (!response.ok || !isRecord(response.body)) {
      state.assistant = null;
      state.assistantError = getApiErrorMessage(response.body) ?? "Não foi possível consultar a base.";
      renderSummary(getCurrentPreviewEvent());
      return;
    }

    state.assistant = response.body;
    state.assistantSignature = signature;
    state.assistantError = null;

    const assistantVehicle = isRecord(response.body.vehicle) ? response.body.vehicle : null;
    const assistantFipe = numberOrNull(assistantVehicle?.fipe);
    const currentEvent = getCurrentPreviewEvent();
    if (assistantFipe != null && numberOrNull(currentEvent.fipe) == null) {
      setFipeOverride(currentEvent, assistantFipe, formatMoneyValue(assistantFipe));
      const eventWithFipe = applyFipeOverride(currentEvent);
      state.preview.textContent = JSON.stringify(eventWithFipe, null, 2);
      state.lastSignature = getEventSignature(eventWithFipe);
      renderSummary(eventWithFipe);
      return;
    }

    renderSummary(currentEvent);
  }

  function getAssistantSignature(event) {
    return JSON.stringify({
      source: event.source,
      auctionId: event.auctionId,
      lot: event.lot,
      code: event.code,
      brand: event.brand,
      model: event.model,
      yearModel: event.yearModel,
      damage: event.damage,
      yard: event.yard,
      fipe: event.fipe,
      vehicleUrl: event.vehicleUrl,
    });
  }

  function setFipeOverride(event, fipe, fipeRaw) {
    const key = getDecisionKey(event);
    if (!key) return;
    state.fipeOverrides.set(key, {
      fipe,
      fipeRaw: fipeRaw || formatMoneyValue(fipe),
    });
  }

  function applyFipeOverride(event) {
    const key = getDecisionKey(event);
    const override = key ? state.fipeOverrides.get(key) : null;
    if (!override) return event;

    return {
      ...event,
      fipe: override.fipe,
      fipeRaw: override.fipeRaw,
      fipePercent: calculatePercent(numberOrNull(event.bid), override.fipe),
    };
  }

  function toggleActive() {
    state.active = !state.active;
    writeStoredBoolean(getStorageKey("active"), state.active);
    renderActiveButton();

    if (state.active) {
      state.saveMessage = "Salvará quando identificar o resultado final";
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
    ensureSodreSynchronization();
    installInitialObserver();
    void refreshPreview({ forceRender: true }).then(() => {
      installActiveObservers();
    });

    state.activeTimer = window.setInterval(() => {
      if (!state.active) return;
      installActiveObservers();
      void refreshPreview();
    }, getActiveIntervalMs());

    state.activeWatchdogTimer = window.setInterval(() => {
      if (!state.active) return;

      if (state.root && !document.documentElement.contains(state.root)) {
        document.documentElement.appendChild(state.root);
      }

      if (state.activeObservers.length === 0) installActiveObservers();
      void refreshPreview();
    }, Math.max(5000, getActiveIntervalMs() * 2));
  }

  function stopActiveLoop() {
    if (state.activeTimer) window.clearInterval(state.activeTimer);
    if (state.activeDebounceTimer) window.clearTimeout(state.activeDebounceTimer);
    if (state.activeWatchdogTimer) window.clearInterval(state.activeWatchdogTimer);

    state.activeTimer = null;
    state.activeDebounceTimer = null;
    state.activeWatchdogTimer = null;
    state.lastSodreSyncAttemptAt = 0;
    if (state.copartDetailSettleTimer) window.clearTimeout(state.copartDetailSettleTimer);
    state.copartDetailSettleTimer = null;
    state.copartDetailSettleAttempts = 0;
    state.copartDetailSettleKey = "";
    disconnectActiveObservers();
  }

  function ensureSodreSynchronization() {
    if (!state.active || getActiveAdapter().id !== "sodre" || document.hidden) return false;

    const syncButton = document.querySelector("#sincronizar");
    if (!(syncButton instanceof HTMLElement) || syncButton.classList.contains("ativo")) return false;

    const now = Date.now();
    if (now - state.lastSodreSyncAttemptAt < SODRE_SYNC_RETRY_MS) return false;

    state.lastSodreSyncAttemptAt = now;
    console.info("[live-auction-collector] ressincronizando_sodre", {
      at: new Date(now).toISOString(),
    });
    syncButton.click();
    return true;
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

  function installInitialObserver() {
    disconnectActiveObservers();

    const target = document.body ?? document.documentElement;
    if (!target) return;

    const observer = new MutationObserver(() => {
      scheduleActiveRefresh();
    });
    observer.observe(target, {
      childList: true,
      subtree: true,
    });
    state.activeObservers.push(observer);
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
    }, getActiveDebounceMs());
  }

  function scheduleCopartDetailSettling(event) {
    if (getActiveAdapter().id !== "copart") return;
    if (!event?.code && !(event?.auctionId && event?.lot)) return;

    const settleKey = String(event.code ?? `${event.auctionId}:${event.lot}`);
    if (state.copartDetailSettleKey !== settleKey) {
      state.copartDetailSettleKey = settleKey;
      state.copartDetailSettleAttempts = 0;
    }

    const detailFieldCount = [event.category, event.damage, event.condition, event.yard, event.consignor]
      .filter(value => Boolean(value)).length;
    const detailReady = Boolean(event.brand && event.model && event.category && event.message && detailFieldCount >= 5);
    if (detailReady || state.copartDetailSettleAttempts >= 8) {
      if (state.copartDetailSettleTimer) window.clearTimeout(state.copartDetailSettleTimer);
      state.copartDetailSettleTimer = null;
      return;
    }

    if (state.copartDetailSettleTimer) return;

    const delays = [250, 400, 650, 900, 1300, 1800, 2500, 3500];
    const delay = delays[state.copartDetailSettleAttempts] ?? 3500;
    state.copartDetailSettleTimer = window.setTimeout(() => {
      state.copartDetailSettleTimer = null;
      state.copartDetailSettleAttempts += 1;
      void refreshPreview();
    }, delay);
  }

  function getObserverTargets() {
    const targets = [];
    const seen = new Set();

    for (const doc of getSearchDocuments()) {
      for (const selector of OBSERVER_SELECTORS) {
        for (const element of safeQueryAll(doc, selector)) {
          addObserverTarget(targets, seen, element);
        }
      }
    }

    for (const root of getSearchRoots()) {
      if (!isRelevantObserverRoot(root)) continue;

      const target = getObserverTarget(root);
      addObserverTarget(targets, seen, target);
    }

    return targets;
  }

  function addObserverTarget(targets, seen, target) {
    if (!target || seen.has(target)) return;
    if (state.root && target.closest?.(".clp-root")) return;

    seen.add(target);
    targets.push(target);
  }

  function getActiveIntervalMs() {
    return getActiveAdapter().id === "vipleiloes" ? VIP_ACTIVE_INTERVAL_MS : DEFAULT_ACTIVE_INTERVAL_MS;
  }

  function getActiveDebounceMs() {
    const adapterId = getActiveAdapter().id;
    if (adapterId === "vipleiloes") return VIP_ACTIVE_DEBOUNCE_MS;
    if (adapterId === "copart") return COPART_ACTIVE_DEBOUNCE_MS;
    return DEFAULT_ACTIVE_DEBOUNCE_MS;
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

    if (safeQueryAll(root, [
      ".vehicle-detail-container",
      ".data-container",
      ".bid-container",
      ".main-bid-container",
      "#chatMessageContainer",
      "#evo-detalhesanuncio-tabela",
      "#evo-oferta-valoratual",
      "#evo-transmissao-anunciosituacao",
      "#evo-transmissao-anunciohistorico",
      "[data-bind-carrossel-anunciotitulo]",
    ].join(",")).length > 0) {
      return true;
    }

    const text = normalizeText(root.body?.innerText ?? root.body?.textContent ?? root.textContent ?? "");
    if (!text) return false;

    return /Leil[aã]o\s*\/\s*Lote|Oferta atual|Valor atual|FIPE|Pr[oó]ximo lote|Maior lance|Condicional|Vendido|Em Preg[aã]o|Hist[oó]rico de Lances/i.test(text);
  }

  function renderActiveButton() {
    if (!state.activateButton) return;

    state.activateButton.innerHTML = state.active
      ? '<span class="clp-icon" aria-hidden="true">⏹</span>'
      : '<span class="clp-icon" aria-hidden="true">▶</span>';
    state.activateButton.dataset.active = String(state.active);
    state.activateButton.title = state.active ? "Desativar coleta" : "Ativar coleta";
    state.activateButton.setAttribute("aria-label", state.activateButton.title);
  }

  function renderRefreshButton() {
    if (!state.refreshButton) return;

    const isRecapture = isCopartLotPage();
    state.refreshButton.disabled = state.recaptureLoading;
    state.refreshButton.innerHTML = state.recaptureLoading
      ? '<span class="clp-icon clp-icon-spin" aria-hidden="true">↻</span>'
      : '<span class="clp-icon" aria-hidden="true">🔄</span>';
    state.refreshButton.title = state.recaptureLoading
      ? "Recapturando lote"
      : isRecapture ? "Recapturar e atualizar este lote" : "Atualizar leitura do lote";
    state.refreshButton.setAttribute("aria-label", state.refreshButton.title);
  }

  async function recaptureCurrentLot() {
    if (state.recaptureLoading) return;

    state.recaptureLoading = true;
    state.saveMessage = "Recapturando lote na Copart...";
    renderRefreshButton();
    renderSummary(getCurrentPreviewEvent());

    try {
      const event = await refreshPreview({ forceRender: true, skipSave: true });
      const code = findCopartLotCodeFromUrl();
      if (!event || !code || event.source !== "copart") {
        throw new Error("Não foi possível identificar o lote nesta página.");
      }

      const response = await requestLocalApi("/api/vehicles/recapture", {
        method: "POST",
        body: {
          ...event,
          code,
          vehicleUrl: buildCopartVehicleUrl(code),
        },
      });

      if (!response.ok || !isRecord(response.body)) {
        throw new Error(getApiErrorMessage(response.body) ?? "Não foi possível atualizar o lote.");
      }

      const fields = Array.isArray(response.body.fields) ? response.body.fields.length : 0;
      state.saveMessage = fields > 0
        ? `Lote recapturado e atualizado · ${fields} campo(s)`
        : "Lote recapturado e atualizado";
      if (response.body.picaretaSynced === false) {
        state.saveMessage += " · Picareta aguardando sincronização";
      }
      logCollector("recapturado", event, {
        response: response.body,
        message: state.saveMessage,
      });
      scheduleAssistantRefresh(event, { immediate: true, force: true });
    }
    catch (error) {
      state.saveMessage = error instanceof Error ? error.message : "Falha ao recapturar lote";
      logCollector("recaptura_falhou", getCurrentPreviewEvent(), { message: state.saveMessage });
    }
    finally {
      state.recaptureLoading = false;
      renderRefreshButton();
      renderSummary(getCurrentPreviewEvent());
    }
  }

  async function toggleIgnoredPanel() {
    if (!state.ignoredPanel) return;

    const opening = state.ignoredPanel.hidden;
    if (opening) {
      if (state.settingsPanel && !state.settingsPanel.hidden) toggleSettingsPanel();
      state.ignoredPanel.hidden = false;
      updateIgnoredButton();
      await refreshIgnoredLots();
      return;
    }

    closeIgnoredPanel();
  }

  function closeIgnoredPanel() {
    if (state.ignoredPanel) state.ignoredPanel.hidden = true;
    closeIgnoredDetails();
    if (state.ignoredButton) {
      state.ignoredButton.dataset.active = "false";
      state.ignoredButton.title = "Abrir lotes capturados";
      state.ignoredButton.setAttribute("aria-label", state.ignoredButton.title);
    }
  }

  async function refreshIgnoredLots() {
    if (!state.ignoredList) return;

    state.ignoredLoading = true;
    state.ignoredError = null;
    renderIgnoredLots();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    state.ignoredItems = readLocalCaptureItems();
    state.ignoredLoading = false;
    state.ignoredLoaded = true;
    renderIgnoredLots();
    updateIgnoredButton();
  }

  async function exportIgnoredLots() {
    if (!state.ignoredList) return;
    if (!state.ignoredLoaded && !state.ignoredLoading) await refreshIgnoredLots();
    if (state.ignoredError) return;

    const payload = {
      exportedAt: new Date().toISOString(),
      source: getActiveAdapter().source,
      total: state.ignoredItems.length,
      items: state.ignoredItems,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `lotes-capturados-${getActiveAdapter().source}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    state.saveMessage = `${state.ignoredItems.length} lote(s) exportado(s) para JSON`;
    renderSummary(getCurrentPreviewEvent());
  }

  function renderIgnoredLots() {
    if (!state.ignoredList) return;
    updateIgnoredBulkUi();
    if (state.ignoredLoading) {
      state.ignoredList.innerHTML = '<div class="clp-ignored-state">Consultando lotes ignorados...</div>';
      return;
    }
    if (state.ignoredError) {
      state.ignoredList.innerHTML = `<div class="clp-ignored-state clp-ignored-state-error">${escapeHtml(state.ignoredError)}</div>`;
      return;
    }
    if (state.ignoredItems.length === 0) {
      state.ignoredList.innerHTML = '<div class="clp-ignored-state">Nenhum lote capturado neste leilão.</div>';
      return;
    }

    state.ignoredList.innerHTML = state.ignoredItems.map((item) => {
      const event = isRecord(item.lastEvent) ? item.lastEvent : item;
      const title = [item.brand, item.model].filter(Boolean).join(" ") || item.description || "Lote sem identificação";
      const lot = item.lot ?? item.code ?? "-";
      const meta = [
        item.category || "Sem categoria",
        item.yard || "Pátio não informado",
        formatIgnoredDate(item.lastCapturedAt ?? item.lastIgnoredAt),
        item.saleStatus ? `status ${item.saleStatus}` : null,
      ].filter(Boolean).join(" · ");
      const url = item.vehicleUrl ?? event.vehicleUrl;
      const resolved = isResolvedIgnoredItem(item);
      const diagnostic = getCaptureDiagnostic(item);
      return `
        <article class="clp-ignored-item">
          <div class="clp-ignored-item-main">
            <strong>${escapeHtml(title)}</strong>
            <span>Lote ${escapeHtml(lot)}${url ? ` · <a href="${escapeHtml(url)}" target="_blank" rel="noopener">abrir</a>` : ""} · ${escapeHtml(meta)}</span>
            <small class="clp-ignored-save-status" data-status="${escapeHtml(diagnostic.status)}">${escapeHtml(diagnostic.label)}</small>
            <small class="clp-ignored-reason">${escapeHtml(diagnostic.reason)}</small>
          </div>
          <div class="clp-ignored-item-actions">
            <button type="button" class="clp-ignored-details" data-role="ignored-details" data-id="${escapeHtml(item._id ?? "")}" title="Ver todos os dados do lote" aria-label="Ver todos os dados do lote">Dados</button>
            ${resolved
              ? '<span class="clp-ignored-resolved">Salvo</span>'
              : `<button type="button" class="clp-ignored-reprocess" data-role="ignored-reprocess" data-id="${escapeHtml(item._id ?? "")}"${state.ignoredBulkSaving ? " disabled" : ""}>Salvar</button>`}
            <button type="button" class="clp-ignored-delete" data-role="ignored-delete" data-id="${escapeHtml(item._id ?? "")}" title="Excluir este lote da lista" aria-label="Excluir este lote da lista"${state.ignoredBulkSaving ? " disabled" : ""}>🗑️</button>
          </div>
        </article>
      `;
    }).join("");
  }

  function updateIgnoredBulkUi() {
    const pendingCount = state.ignoredItems.filter(item => !isResolvedIgnoredItem(item)).length;
    if (state.ignoredSaveAllButton) {
      state.ignoredSaveAllButton.disabled = state.ignoredBulkSaving || pendingCount === 0;
      state.ignoredSaveAllButton.innerHTML = state.ignoredBulkSaving
        ? '<span class="clp-icon clp-icon-spin" aria-hidden="true">⟳</span>'
        : '<span class="clp-icon" aria-hidden="true">💾</span>';
      state.ignoredSaveAllButton.title = state.ignoredBulkSaving
        ? "Salvando lotes no banco"
        : pendingCount > 0 ? `Salvar ${pendingCount} lote(s) pendente(s) no banco` : "Todos os lotes pendentes já foram salvos";
      state.ignoredSaveAllButton.setAttribute("aria-label", state.ignoredSaveAllButton.title);
      state.ignoredSaveAllButton.setAttribute("aria-busy", String(state.ignoredBulkSaving));
    }

    if (!state.ignoredBulkStatus) return;
    const progress = state.ignoredBulkProgress;
    if (state.ignoredBulkSaving && progress) {
      state.ignoredBulkStatus.hidden = false;
      state.ignoredBulkStatus.className = "clp-ignored-bulk-status is-running";
      state.ignoredBulkStatus.textContent = `Salvando ${progress.current}/${progress.total} · ${progress.saved} salvo(s) · ${progress.skipped} rejeitado(s)`;
      return;
    }

    if (state.ignoredBulkMessage) {
      state.ignoredBulkStatus.hidden = false;
      state.ignoredBulkStatus.className = "clp-ignored-bulk-status";
      state.ignoredBulkStatus.textContent = state.ignoredBulkMessage;
      return;
    }

    state.ignoredBulkStatus.hidden = true;
    state.ignoredBulkStatus.textContent = "";
  }

  function isResolvedIgnoredItem(item) {
    return item?.status === "approved" || item?.status === "resolved" || Boolean(item?.resolvedAt);
  }

  function getSaleStatusLabel(value) {
    return {
      sold: "Vendido",
      conditional: "Condicional",
      not_sold: "Não vendido",
      open: "Em andamento",
    }[value] ?? "Sem resultado final";
  }

  function getDecisionLabel(value) {
    if (value === "save") return "Salvar manualmente";
    if (value === "skip") return "Ignorar manualmente";
    return "Regra automática";
  }

  function getCaptureDecisionLabel(item, event) {
    return item?.decisionMode === "auto"
      ? "Regra automática"
      : getDecisionLabel(item?.manualDecision ?? event?.manualDecision ?? "auto");
  }

  function getCaptureDiagnostic(item) {
    const event = isRecord(item?.lastEvent) ? item.lastEvent : item;
    const saleStatus = event?.saleStatus ?? item?.saleStatus ?? null;
    const hasFinalResult = FINAL_SALE_STATUSES.has(saleStatus);
    const resolved = isResolvedIgnoredItem(item);
    const rawReason = typeof item?.reason === "string" && item.reason.trim()
      ? item.reason.trim()
      : "Capturado no leilão";
    if (resolved) {
      return {
        status: hasFinalResult ? "saved" : "saved-no-result",
        label: hasFinalResult ? `Salvo · ${getSaleStatusLabel(saleStatus)}` : "Salvo · sem resultado final",
        reason: hasFinalResult
          ? (item.resolution ?? "Resultado final capturado e salvo na base.")
          : "Salvo por decisão manual, mas o resultado final da venda ainda não foi capturado.",
        decision: getCaptureDecisionLabel(item, event),
        result: getSaleStatusLabel(saleStatus),
        at: item.resolvedAt ?? item.lastSaveAttemptAt ?? item.lastCapturedAt ?? null,
      };
    }

    const pending = item?.saveStatus === "pending"
      || /aguardando resultado/i.test(rawReason)
      || /salvar manual quando liberar/i.test(rawReason);
    const failed = item?.saveStatus === "error";
    return {
      status: failed ? "error" : pending ? "pending" : "not-saved",
      label: failed ? "Falha ao salvar" : pending ? "Não salvo · aguardando resultado" : "Não salvo",
      reason: rawReason,
      decision: getCaptureDecisionLabel(item, event),
      result: getSaleStatusLabel(saleStatus),
      at: item.lastDecisionAt ?? item.lastSaveAttemptAt ?? item.lastCapturedAt ?? null,
    };
  }

  function getIgnoredStoredEvent(item) {
    const storedEvent = isRecord(item?.lastEvent) ? item.lastEvent : item;
    if (!isRecord(storedEvent)) return null;
    return {
      ...storedEvent,
      manualDecision: "save",
      observedAt: storedEvent.observedAt ?? item.lastCapturedAt ?? new Date().toISOString(),
    };
  }

  function updateLocalCaptureDiagnostic(event, update) {
    const key = getDecisionKey(event);
    if (!key) return;

    const items = readLocalCaptureItems();
    const index = items.findIndex((item) => item.identityKey === key);
    if (index < 0) return;

    items[index] = {
      ...items[index],
      ...update,
      lastDecisionAt: new Date().toISOString(),
    };
    state.ignoredItems = items;
    writeLocalCaptureItems(items);
    if (state.ignoredPanel && !state.ignoredPanel.hidden) renderIgnoredLots();
  }

  async function resolveIgnoredItem(item) {
    const id = String(item?._id ?? "");
    if (!id || id.startsWith("local:")) return true;

    const response = await requestLocalApi(`/api/vehicles/ignored-lots/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: { resolution: "Salvo na base pela lista de lotes capturados" },
    });
    return response.ok;
  }

  async function saveIgnoredItem(item) {
    const eventToSave = getIgnoredStoredEvent(item);
    if (!eventToSave) return { status: "skipped" };

    const response = await requestLocalApi("/api/vehicles/ingest", {
      method: "POST",
      body: eventToSave,
    });
    const accepted = Number(response.body?.accepted ?? 0);
    if (!response.ok || accepted < 1) {
      const message = getIngestErrorMessage(response.body)
        ?? getApiErrorMessage(response.body)
        ?? "O lote não foi aceito pelo banco.";
      updateLocalCaptureDiagnostic(eventToSave, {
        saveStatus: response.ok ? "not-saved" : "error",
        reason: message,
        lastSaveAttemptAt: new Date().toISOString(),
      });
      return {
        status: response.ok || response.status === 400 || response.status === 422 ? "skipped" : "error",
        message,
      };
    }

    const resolved = await resolveIgnoredItem(item);
    if (!resolved) {
      updateLocalCaptureDiagnostic(eventToSave, {
        saveStatus: "error",
        reason: "Lote salvo, mas não foi possível atualizar a lista.",
        lastSaveAttemptAt: new Date().toISOString(),
      });
      return { status: "error", message: "Lote salvo, mas não foi possível atualizar a lista." };
    }

    markLocalCaptureResolved(eventToSave, "Salvo na base pela lista de lotes capturados");
    return { status: "saved" };
  }

  async function saveAllIgnoredLots() {
    if (state.ignoredBulkSaving) return;
    if (!state.ignoredLoaded && !state.ignoredLoading) await refreshIgnoredLots();

    const pendingItems = state.ignoredItems.filter(item => !isResolvedIgnoredItem(item) && getIgnoredStoredEvent(item));
    if (pendingItems.length === 0) {
      state.ignoredError = null;
      state.ignoredBulkMessage = "Não há lotes pendentes para salvar.";
      renderIgnoredLots();
      return;
    }

    state.ignoredBulkSaving = true;
    state.ignoredError = null;
    state.ignoredBulkMessage = null;
    state.ignoredBulkProgress = {
      current: 0,
      total: pendingItems.length,
      saved: 0,
      skipped: 0,
      errors: 0,
      reasons: {},
    };
    renderIgnoredLots();

    for (const item of pendingItems) {
      const result = await saveIgnoredItem(item);
      if (result.status === "saved") state.ignoredBulkProgress.saved += 1;
      else if (result.status === "error") state.ignoredBulkProgress.errors += 1;
      else state.ignoredBulkProgress.skipped += 1;
      if (result.status !== "saved") {
        const reason = result.message?.replace(/^Ignorado:\s*/i, "") ?? "sem detalhe retornado";
        state.ignoredBulkProgress.reasons[reason] = (state.ignoredBulkProgress.reasons[reason] ?? 0) + 1;
      }
      state.ignoredBulkProgress.current += 1;
      renderIgnoredLots();
    }

    const progress = state.ignoredBulkProgress;
    state.ignoredBulkSaving = false;
    const reasonSummary = progress
      ? Object.entries(progress.reasons)
        .sort(([, first], [, second]) => second - first)
        .slice(0, 2)
        .map(([reason, count]) => `${reason} (${count})`)
        .join(", ")
      : "";
    state.ignoredBulkMessage = progress
      ? `Concluído: ${progress.saved} salvo(s) · ${progress.skipped} rejeitado(s)${progress.errors ? ` · ${progress.errors} erro(s)` : ""}${reasonSummary ? ` · ${reasonSummary}` : ""}.`
      : "Processamento concluído.";
    state.saveMessage = progress?.saved > 0
      ? `${progress.saved} lote(s) salvo(s) na base`
      : "Nenhum lote foi salvo na base";
    renderIgnoredLots();
    renderSummary(getCurrentPreviewEvent());
  }

  function ignoredItemKey(item) {
    if (typeof item?.identityKey === "string" && item.identityKey) return item.identityKey;
    const storedEvent = getIgnoredStoredEvent(item);
    return storedEvent ? getDecisionKey(storedEvent) : null;
  }

  function removeIgnoredItems(itemsToRemove) {
    const removedKeys = new Set(itemsToRemove.map(ignoredItemKey).filter(Boolean));
    state.ignoredItems = state.ignoredItems.filter((item) => !itemsToRemove.includes(item));
    for (const key of removedKeys) {
      state.observedSignatures.delete(key);
      state.ignoredSignatures.delete(key);
    }
    writeLocalCaptureItems(state.ignoredItems);
    state.ignoredLoaded = true;
    state.ignoredError = null;
    renderIgnoredLots();
    updateIgnoredButton();
  }

  function deleteIgnoredLot(button) {
    if (state.ignoredBulkSaving) return;
    const id = button?.getAttribute("data-id");
    const item = state.ignoredItems.find((candidate) => String(candidate?._id ?? "") === id);
    if (!item) return;

    const title = [item.brand, item.model].filter(Boolean).join(" ") || item.description || "este lote";
    if (!window.confirm(`Excluir ${title} da lista de lotes capturados?`)) return;

    removeIgnoredItems([item]);
    closeIgnoredDetails();
    state.ignoredBulkMessage = "Lote excluído da lista local.";
    renderIgnoredLots();
  }

  function clearIgnoredLots() {
    if (state.ignoredBulkSaving || state.ignoredItems.length === 0) return;
    const amount = state.ignoredItems.length;
    if (!window.confirm(`Excluir os ${amount} lotes capturados desta fonte? Essa ação remove apenas a lista local.`)) return;

    const items = [...state.ignoredItems];
    removeIgnoredItems(items);
    closeIgnoredDetails();
    state.ignoredBulkMessage = `${amount} lote(s) excluído(s) da lista local.`;
    renderIgnoredLots();
  }

  function formatIgnoredDetailValue(value) {
    if (value === undefined) return "—";
    if (value === null) return "null";
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    try {
      return JSON.stringify(value, null, 2);
    }
    catch {
      return String(value);
    }
  }

  function showIgnoredDetails(button) {
    const id = button?.getAttribute("data-id");
    const item = state.ignoredItems.find((candidate) => String(candidate?._id ?? "") === id);
    if (!item || !state.ignoredDetailsModal || !state.ignoredDetailsTable) return;

    const title = [item.brand, item.model].filter(Boolean).join(" ") || item.description || "Lote sem identificação";
    const diagnostic = getCaptureDiagnostic(item);
    if (state.ignoredDetailsTitle) state.ignoredDetailsTitle.textContent = title;
    state.ignoredDetailsTable.innerHTML = `
      <div class="clp-details-diagnostic" data-status="${escapeHtml(diagnostic.status)}">
        <div class="clp-details-diagnostic-heading">
          <strong>Log do salvamento</strong>
          <span>${escapeHtml(diagnostic.label)}</span>
        </div>
        <div class="clp-details-diagnostic-grid">
          <div><b>Motivo</b><span>${escapeHtml(diagnostic.reason)}</span></div>
          <div><b>Decisão</b><span>${escapeHtml(diagnostic.decision)}</span></div>
          <div><b>Resultado capturado</b><span>${escapeHtml(diagnostic.result)}</span></div>
          <div><b>Última ação</b><span>${escapeHtml(diagnostic.at ? formatIgnoredDate(diagnostic.at) : "—")}</span></div>
        </div>
      </div>
      <table class="clp-details-table">
        <thead><tr><th>Campo</th><th>Valor</th></tr></thead>
        <tbody>${Object.entries(item).map(([key, value]) => `
          <tr>
            <th scope="row">${escapeHtml(key)}</th>
            <td><pre>${escapeHtml(formatIgnoredDetailValue(value))}</pre></td>
          </tr>
        `).join("")}</tbody>
      </table>
    `;
    state.ignoredDetailsModal.hidden = false;
    state.ignoredDetailsModal.setAttribute("aria-hidden", "false");
    const closeButton = state.ignoredDetailsModal.querySelector('[data-role="ignored-details-close"]');
    if (closeButton instanceof HTMLElement) closeButton.focus();
  }

  function closeIgnoredDetails() {
    if (!state.ignoredDetailsModal) return;
    state.ignoredDetailsModal.hidden = true;
    state.ignoredDetailsModal.setAttribute("aria-hidden", "true");
  }

  function updateIgnoredButton(payload = null) {
    if (!state.ignoredButton) return;
    const active = state.ignoredPanel && !state.ignoredPanel.hidden;
    const hasNewItem = isRecord(payload) && payload._id != null;
    const count = payload && Number.isFinite(Number(payload.total))
      ? Number(payload.total)
      : hasNewItem ? Math.max(1, state.ignoredItems.length) : state.ignoredItems.length;
    state.ignoredButton.dataset.active = String(Boolean(active));
    state.ignoredButton.dataset.hasItems = String(count > 0);
    state.ignoredButton.title = count > 0 ? `Lotes capturados (${count})` : "Abrir lotes capturados";
    state.ignoredButton.setAttribute("aria-label", state.ignoredButton.title);
  }

  async function reprocessIgnoredLot(button) {
    const id = button?.getAttribute("data-id");
    if (!id) return;
    const item = state.ignoredItems.find(candidate => String(candidate?._id ?? "") === id);
    const storedEvent = isRecord(item?.lastEvent) ? item.lastEvent : null;
    if (!item || !storedEvent) return;

    button.disabled = true;
    button.textContent = "Salvando...";
    const eventToSave = {
      ...storedEvent,
      manualDecision: "save",
      observedAt: storedEvent.observedAt ?? new Date().toISOString(),
    };
    const response = await requestLocalApi("/api/vehicles/ingest", {
      method: "POST",
      body: eventToSave,
    });
    const accepted = Number(response.body?.accepted ?? 0);
    if (!response.ok || accepted < 1) {
      button.disabled = false;
      button.textContent = "Reprocessar";
      state.ignoredError = getIngestErrorMessage(response.body) ?? getApiErrorMessage(response.body) ?? "O lote ainda não pôde ser salvo.";
      renderIgnoredLots();
      return;
    }

    const localOnly = id.startsWith("local:");
    const resolved = localOnly
      ? { ok: true }
      : await requestLocalApi(`/api/vehicles/ignored-lots/${encodeURIComponent(id)}/resolve`, {
          method: "POST",
          body: { resolution: "Salvo na base pela lista de lotes ignorados" },
        });
    if (!resolved.ok) {
      state.ignoredError = "Lote salvo, mas não foi possível removê-lo da lista.";
    } else {
      state.saveMessage = "Lote ignorado reprocessado e salvo";
      state.ignoredError = null;
      markLocalCaptureResolved(eventToSave, "Salvo na base pela lista de lotes capturados");
    }
    await refreshIgnoredLots();
    renderSummary(getCurrentPreviewEvent());
  }

  function formatIgnoredDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "data desconhecida";
    return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
  }

  function toggleSettingsPanel() {
    if (!state.settingsPanel) return;

    const opening = state.settingsPanel.hidden;
    if (opening) {
      if (state.ignoredPanel && !state.ignoredPanel.hidden) closeIgnoredPanel();
      state.settingsDraft = cloneSettings(state.settings);
      renderSettingsForm();
    }

    state.settingsPanel.hidden = !opening;
    if (state.settingsButton) {
      state.settingsButton.dataset.active = String(opening);
      state.settingsButton.title = opening ? "Fechar configuração" : "Abrir configuração";
      state.settingsButton.setAttribute("aria-label", state.settingsButton.title);
    }
  }

  function renderSettingsForm() {
    renderSettingsStates();

    if (state.settingsCategoriesInput) {
      state.settingsCategoriesInput.value = state.settingsDraft.allowedCategories.join(", ");
    }

    if (state.settingsRequireStateInput) {
      state.settingsRequireStateInput.checked = state.settingsDraft.requireDetectedState;
    }

    if (state.settingsAllowTrucksInput) {
      state.settingsAllowTrucksInput.checked = state.settingsDraft.allowTrucks;
    }

    if (state.settingsAllowMotorcyclesInput) {
      state.settingsAllowMotorcyclesInput.checked = state.settingsDraft.allowMotorcycles;
    }
  }

  function renderSettingsStates() {
    if (!state.settingsStatesContainer || !state.settingsDraft) return;

    state.settingsStatesContainer.innerHTML = SORTED_BRAZIL_STATE_CODES.map((uf) => {
      const active = state.settingsDraft.autoSaveStates.includes(uf);
      return `<button type="button" class="clp-settings-chip" data-role="settings-state-chip" data-uf="${uf}" data-active="${active}">${uf}</button>`;
    }).join("");
  }

  function toggleSettingsStateChip(chip) {
    if (!chip || !state.settingsDraft) return;

    const uf = chip.getAttribute("data-uf");
    if (!uf) return;

    const list = state.settingsDraft.autoSaveStates;
    const index = list.indexOf(uf);
    if (index === -1) list.push(uf);
    else list.splice(index, 1);

    renderSettingsStates();
  }

  function saveSettingsFromForm() {
    if (!state.settingsDraft) return;

    const categoriesRaw = state.settingsCategoriesInput?.value ?? "";
    const allowedCategories = categoriesRaw.split(",").map((value) => normalizeText(value)).filter(Boolean);
    const requireDetectedState = state.settingsRequireStateInput?.checked ?? DEFAULT_SETTINGS.requireDetectedState;
    const allowTrucks = state.settingsAllowTrucksInput?.checked ?? DEFAULT_SETTINGS.allowTrucks;
    const allowMotorcycles = state.settingsAllowMotorcyclesInput?.checked ?? DEFAULT_SETTINGS.allowMotorcycles;

    state.settings = {
      autoSaveStates: state.settingsDraft.autoSaveStates.length > 0
        ? [...state.settingsDraft.autoSaveStates]
        : [...DEFAULT_SETTINGS.autoSaveStates],
      allowedCategories: allowedCategories.length > 0 ? allowedCategories : [...DEFAULT_SETTINGS.allowedCategories],
      allowTrucks,
      allowMotorcycles,
      requireDetectedState,
    };
    writeStoredSettings(state.settings);
    state.saveMessage = "Configuracoes salvas";
    if (state.settingsPanel) state.settingsPanel.hidden = true;
    if (state.settingsButton) {
      state.settingsButton.dataset.active = "false";
      state.settingsButton.title = "Abrir configuração";
      state.settingsButton.setAttribute("aria-label", state.settingsButton.title);
    }
    renderSummary(getCurrentPreviewEvent());
  }

  function resetSettingsForm() {
    state.settingsDraft = cloneSettings(DEFAULT_SETTINGS);
    renderSettingsForm();
  }

  function getStorageKey(name) {
    return `liveAuctionCollector:${getActiveAdapter().id}:${name}`;
  }

  function readLocalCaptureItems() {
    try {
      const raw = localStorage.getItem(getStorageKey("capturedLots:v1"));
      const items = raw ? JSON.parse(raw) : [];
      return Array.isArray(items) ? items.filter((item) => isRecord(item)) : [];
    }
    catch {
      return [];
    }
  }

  function writeLocalCaptureItems(items) {
    try {
      localStorage.setItem(getStorageKey("capturedLots:v1"), JSON.stringify(items));
      return true;
    }
    catch {
      state.saveMessage = "Não foi possível guardar os lotes localmente";
      return false;
    }
  }

  function captureLocalLot(event, decision) {
    const key = getDecisionKey(event);
    const signature = getObservedSignature(event);
    if (!key || !signature) return;

    const previousSignature = state.observedSignatures.get(key);
    state.observedSignatures.set(key, signature);
    const items = readLocalCaptureItems();
    const existingIndex = findExistingCaptureIndex(items, event, key);
    const existing = existingIndex >= 0 ? items[existingIndex] : null;
    const capturedAt = new Date().toISOString();
    const decisionData = {
      decisionMode: decision.mode,
      manualDecision: decision.manualDecision,
      saveStatus: decision.shouldSave ? "saving" : decision.pending ? "pending" : "not-saved",
      reason: decision.reason,
      lastDecisionAt: capturedAt,
    };

    if (previousSignature === signature) {
      if (!existing) return;
      items[existingIndex] = { ...existing, ...decisionData };
      state.ignoredItems = items;
      writeLocalCaptureItems(items);
      if (state.ignoredPanel && !state.ignoredPanel.hidden) renderIgnoredLots();
      return;
    }

    const mergedEvent = mergeCapturedValues(existing, event);
    const item = {
      ...(existing ?? {}),
      ...mergedEvent,
      ...decisionData,
      _id: existing?._id ?? `local:${key}`,
      identityKey: key,
      localOnly: true,
      captureType: decision.shouldSave || decision.pending ? "observed" : "ignored",
      status: existing?.status === "approved" || existing?.status === "resolved" ? existing.status : "pending",
      reason: decision.reason,
      firstCapturedAt: existing?.firstCapturedAt ?? capturedAt,
      lastCapturedAt: capturedAt,
      lastEvent: mergeCapturedValues(existing?.lastEvent, event),
    };

    if (existingIndex >= 0) items[existingIndex] = item;
    else items.unshift(item);
    state.ignoredItems = items;
    writeLocalCaptureItems(items);
    if (state.ignoredPanel && !state.ignoredPanel.hidden) renderIgnoredLots();
    updateIgnoredButton();
  }

  function findExistingCaptureIndex(items, event, key) {
    const code = normalizeText(event.code);
    const auctionId = normalizeText(event.auctionId);
    const lot = normalizeText(event.lot);

    return items.findIndex((item) => {
      if (item.identityKey === key) return true;
      if (code && normalizeText(item.code) === code) return true;
      return Boolean(auctionId && lot
        && normalizeText(item.auctionId) === auctionId
        && normalizeText(item.lot) === lot);
    });
  }

  function markLocalCaptureResolved(event, resolution) {
    const key = getDecisionKey(event);
    if (!key) return;

    const items = readLocalCaptureItems();
    const index = items.findIndex((item) => item.identityKey === key);
    if (index < 0) return;

    items[index] = {
      ...items[index],
      status: "approved",
      resolution,
      saveStatus: "saved",
      reason: FINAL_SALE_STATUSES.has(event.saleStatus)
        ? `${resolution} · resultado: ${getSaleStatusLabel(event.saleStatus)}`
        : `${resolution} · resultado final não capturado`,
      lastSaveAttemptAt: new Date().toISOString(),
      resolvedAt: new Date().toISOString(),
      lastEvent: mergeCapturedValues(items[index].lastEvent, event),
    };
    state.ignoredItems = items;
    writeLocalCaptureItems(items);
    if (state.ignoredPanel && !state.ignoredPanel.hidden) renderIgnoredLots();
    updateIgnoredButton();
  }

  function mergeCapturedValues(previous, next) {
    const merged = isRecord(previous) ? { ...previous } : {};
    if (!isRecord(next)) return merged;

    for (const [key, value] of Object.entries(next)) {
      if (value == null) continue;
      if (typeof value === "string" && !value.trim()) continue;
      merged[key] = value;
    }
    return merged;
  }

  function readStoredBoolean(key) {
    try {
      return localStorage.getItem(key) === "1";
    }
    catch {
      return false;
    }
  }

  function readStoredSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!raw) return cloneSettings(DEFAULT_SETTINGS);

      const parsed = JSON.parse(raw);
      const autoSaveStates = Array.isArray(parsed?.autoSaveStates)
        ? parsed.autoSaveStates.filter((uf) => BRAZIL_STATE_CODES.has(uf))
        : [];
      const allowedCategories = Array.isArray(parsed?.allowedCategories)
        ? parsed.allowedCategories.map((value) => normalizeText(value)).filter(Boolean)
        : [];

      return {
        autoSaveStates: autoSaveStates.length > 0 ? autoSaveStates : [...DEFAULT_SETTINGS.autoSaveStates],
        allowedCategories: allowedCategories.length > 0 ? allowedCategories : [...DEFAULT_SETTINGS.allowedCategories],
        allowTrucks: typeof parsed?.allowTrucks === "boolean" ? parsed.allowTrucks : DEFAULT_SETTINGS.allowTrucks,
        allowMotorcycles: typeof parsed?.allowMotorcycles === "boolean" ? parsed.allowMotorcycles : DEFAULT_SETTINGS.allowMotorcycles,
        requireDetectedState: typeof parsed?.requireDetectedState === "boolean"
          ? parsed.requireDetectedState
          : DEFAULT_SETTINGS.requireDetectedState,
      };
    }
    catch {
      return cloneSettings(DEFAULT_SETTINGS);
    }
  }

  function writeStoredSettings(settings) {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    }
    catch {
      // Storage pode estar indisponivel em alguns contextos.
    }
  }

  function cloneSettings(settings) {
    return {
      autoSaveStates: [...settings.autoSaveStates],
      allowedCategories: [...settings.allowedCategories],
      allowTrucks: settings.allowTrucks,
      allowMotorcycles: settings.allowMotorcycles,
      requireDetectedState: settings.requireDetectedState,
    };
  }

  function writeStoredBoolean(key, value) {
    try {
      if (value) localStorage.setItem(key, "1");
      else localStorage.removeItem(key);
    }
    catch {
      // Storage pode estar indisponivel em alguns contextos.
    }
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
      source: event.source,
      auctionId: event.auctionId,
      lot: event.lot,
      code: event.code,
      category: event.category,
      damage: event.damage,
      condition: event.condition,
      yard: event.yard,
      consignor: event.consignor,
      bidRaw: event.bidRaw,
      fipe: event.fipe,
      fipeRaw: event.fipeRaw,
      saleStatus: event.saleStatus,
      message: event.message,
      imageUrl: event.imageUrl,
    });
  }

  function getDecisionKey(event) {
    const source = normalizeText(event.source) ?? getActiveAdapter().source;
    const code = normalizeText(event.code);
    if (code) return `${source}:code:${code}`;

    const auctionId = normalizeText(event.auctionId);
    const lot = normalizeText(event.lot);
    if (auctionId && lot) return `${source}:auction:${auctionId}:lot:${lot}`;

    return null;
  }

  function getManualDecision() {
    return "auto";
  }

  async function maybeSaveEvent(event) {
    const decision = getSaveDecision(event);
    captureLocalLot(event, decision);
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
      if (!decision.pending) void recordIgnoredEvent(event, decision.reason, decision.mode, decision.manualDecision);
      return changed;
    }

    const eventToSave = {
      ...event,
      manualDecision: decision.manualDecision,
    };
    const signature = getSaveSignature(eventToSave);
    if (state.lastSavedSignature === signature) {
      const savedLabel = "Salvo na base";
      const changed = state.saveMessage !== savedLabel;
      state.saveMessage = savedLabel;
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
        endpoint: getIngestEndpoint(),
        decisionMode: decision.mode,
        decisionReason: decision.reason,
      });

      const headers = {
        "Content-Type": "application/json",
      };
      const token = getExtensionToken();
      if (token) {
        headers["x-live-auction-extension-token"] = token;
        headers["x-copart-extension-token"] = token;
      }

      const response = await sendIngestEvent(eventToSave, headers);
      const responseBody = response.body ?? null;

      if (!response.ok) {
        state.saveMessage = getIngestErrorMessage(responseBody) ?? "Falha ao salvar";
        updateLocalCaptureDiagnostic(eventToSave, {
          saveStatus: "error",
          reason: state.saveMessage,
          lastSaveAttemptAt: new Date().toISOString(),
        });
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
      markLocalCaptureResolved(eventToSave, state.saveMessage);
      logCollector("salvo", eventToSave, {
        status: response.status,
        decisionMode: decision.mode,
        response: summarizeIngestResponse(responseBody),
      });
      return true;
    }
    catch (error) {
      state.saveMessage = "Backend indisponivel";
      updateLocalCaptureDiagnostic(eventToSave, {
        saveStatus: "error",
        reason: error instanceof Error ? error.message : "Erro desconhecido",
        lastSaveAttemptAt: new Date().toISOString(),
      });
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
    if (canSendRuntimeMessage()) {
      return sendRuntimeMessage({
        type: "LIVE_AUCTION_INGEST_EVENT",
        endpoint: getIngestEndpoint(),
        headers,
        event,
      });
    }

    const response = await fetch(getIngestEndpoint(), {
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

  async function requestLocalApi(path, options = {}) {
    const endpoint = new URL(path, DATABASE_INGEST_ENDPOINT).toString();
    const method = options.method === "GET" || options.method === "PATCH" ? options.method : "POST";
    const headers = {
      "Content-Type": "application/json",
    };
    const token = getExtensionToken();
    if (token) {
      headers["x-live-auction-extension-token"] = token;
      headers["x-copart-extension-token"] = token;
    }

    if (canSendRuntimeMessage()) {
      return sendRuntimeMessage({
        type: "LIVE_AUCTION_API_REQUEST",
        endpoint,
        method,
        headers,
        body: options.body ?? null,
      });
    }

    try {
      const response = await fetch(endpoint, {
        method,
        headers,
        body: method === "GET" ? undefined : JSON.stringify(options.body ?? null),
      });
      const body = await response.json().catch(() => null);
      return {
        ok: response.ok,
        status: response.status,
        body,
      };
    }
    catch (error) {
      return {
        ok: false,
        status: 0,
        body: { message: error instanceof Error ? error.message : "Backend indisponível" },
      };
    }
  }

  async function recordIgnoredEvent(event, reason, decisionMode, manualDecision) {
    const key = getDecisionKey(event);
    if (!key) return;

    const signature = `${key}:${reason}:${event.saleStatus ?? ""}:${event.category ?? ""}`;
    if (state.ignoredSignatures.get(key) === signature) return;
    state.ignoredSignatures.set(key, signature);

    const response = await requestLocalApi("/api/vehicles/ignored-lots", {
      method: "POST",
      body: {
        event: {
          ...event,
          manualDecision: manualDecision ?? event.manualDecision ?? getManualDecision(event),
        },
        reason,
        decisionMode,
      },
    });

    if (response.ok && isRecord(response.body?.item)) {
      const item = response.body.item;
      const itemId = String(item._id ?? "");
      const existingIndex = state.ignoredItems.findIndex((candidate) => candidate.identityKey === item.identityKey
        || String(candidate?._id ?? "") === itemId);
      if (existingIndex >= 0) {
        state.ignoredItems[existingIndex] = { ...state.ignoredItems[existingIndex], ...item };
      } else {
        state.ignoredItems.unshift(item);
      }
      writeLocalCaptureItems(state.ignoredItems);
      if (state.ignoredPanel && !state.ignoredPanel.hidden) renderIgnoredLots();
      state.saveMessage = "Ignorado e salvo na lista";
      renderSummary(getCurrentPreviewEvent());
      updateIgnoredButton(response.body.item);
      return;
    }

    logCollector("registro_ignorado_falhou", event, {
      reason,
      message: getApiErrorMessage(response.body) ?? "Não foi possível registrar o lote ignorado",
    });
    if (state.ignoredSignatures.get(key) === signature) state.ignoredSignatures.delete(key);
  }

  function getObservedSignature(event) {
    const key = getDecisionKey(event);
    if (!key) return null;

    return `${key}:${JSON.stringify({
      auctionId: event.auctionId ?? null,
      lot: event.lot ?? null,
      code: event.code ?? null,
      description: event.description ?? null,
      version: event.version ?? null,
      yearModel: event.yearModel ?? null,
      brand: event.brand ?? null,
      model: event.model ?? null,
      category: event.category ?? null,
      fipe: event.fipe ?? null,
      fipeRaw: event.fipeRaw ?? null,
      damage: event.damage ?? null,
      condition: event.condition ?? null,
      yard: event.yard ?? null,
      consignor: event.consignor ?? null,
      bid: event.bid ?? null,
      bidRaw: event.bidRaw ?? null,
      saleStatus: event.saleStatus ?? null,
      imageUrl: event.imageUrl ?? null,
      vehicleUrl: event.vehicleUrl ?? null,
      message: event.message ?? null,
    })}`;
  }

  function canSendRuntimeMessage() {
    try {
      return typeof globalThis.chrome?.runtime?.sendMessage === "function";
    }
    catch {
      return false;
    }
  }

  function sendRuntimeMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const runtimeError = chrome.runtime.lastError;
            if (runtimeError) {
              resolve(buildRuntimeFailure(runtimeError));
              return;
            }

            resolve(isRecord(response) ? response : buildRuntimeFailure("Sem resposta do service worker"));
          }
          catch (error) {
            resolve(buildRuntimeFailure(error));
          }
        });
      }
      catch (error) {
        resolve(buildRuntimeFailure(error));
      }
    });
  }

  function buildRuntimeFailure(error) {
    const rawMessage = error instanceof Error
      ? error.message
      : typeof error === "string" ? error : "Falha na comunica\u00e7\u00e3o da extens\u00e3o";
    const message = /extension context invalidated/i.test(rawMessage)
      ? "Extens\u00e3o atualizada. Recarregue esta p\u00e1gina."
      : rawMessage;

    return {
      ok: false,
      status: 0,
      body: { message },
    };
  }

  function getApiErrorMessage(value) {
    if (!isRecord(value)) return null;
    if (typeof value.message === "string" && value.message.trim()) return value.message.trim().slice(0, 160);
    if (typeof value.statusMessage === "string" && value.statusMessage.trim()) return value.statusMessage.trim().slice(0, 160);
    return null;
  }

  function logCollector(action, event, extra = {}) {
    const payload = {
      at: new Date().toISOString(),
      source: event.source ?? getActiveAdapter().source,
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
      manualDecision: event.manualDecision ?? getManualDecision(event),
      bidRaw: event.bidRaw ?? null,
      fipeRaw: event.fipeRaw ?? null,
      ...extra,
    };

    console.info(`[live-auction-collector] ${action}`, payload);
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
            consignor: firstVehicle.consignor ?? null,
            manualDecision: firstVehicle.manualDecision ?? null,
          }
        : null,
    };
  }

  function getSaveDecision(event) {
    const hardReason = getHardSaveBlockReason(event);
    const softReason = getSoftSaveBlockReason(event);
    const onlyWaitingResult = hardReason === "Aguardando resultado";

    if (onlyWaitingResult) {
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
        shouldSave: false,
        pending: true,
        reason: "Salvará quando identificar o resultado final",
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
      // manualDecision "save" (nao "auto") para que o servidor honre as regras
      // configuradas aqui (estados/categorias) em vez do proprio limite fixo dele.
      mode: "auto",
      manualDecision: "save",
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
    const adapter = getAdapterForEvent(event);
    if (adapter.id === "copart") {
      if (!event.category) return "Sem categoria";
      if (!isAllowedCategory(event.category)) return `Categoria ignorada: ${event.category}`;
    }

    const stateBlockReason = getStateBlockReason(event);
    if (stateBlockReason) return stateBlockReason;

    return null;
  }

  function getStateBlockReason(event) {
    const stateCode = extractStateCode(event.yard)
      ?? (event.source === "sodre" ? extractStateCode(event.description) : null);
    if (!stateCode) return state.settings.requireDetectedState ? "Sem estado" : null;
    if (!state.settings.autoSaveStates.includes(stateCode)) return `Estado ignorado: ${stateCode} (configure em ⚙️ Config)`;

    return null;
  }

  function extractStateCode(value) {
    const text = normalizeText(value);
    if (!text) return null;

    const normalized = normalizeForMatch(text);
    const slashStateMatch = normalized.match(/\/\s*([A-Z]{2})(?=$|[\s,.;:)\-])/);
    if (slashStateMatch?.[1] && BRAZIL_STATE_CODES.has(slashStateMatch[1])) return slashStateMatch[1];

    const cityStateMatch = normalized.match(/^(.*?)\s*-\s*([A-Z]{2})$/);
    if (cityStateMatch?.[2]) return cityStateMatch[2];

    const addressMatch = normalized.match(/,\s*([^,]+?)\s*,\s*([A-Z]{2})(?:\b|,)/);
    if (addressMatch?.[2]) return addressMatch[2];

    const labeledStateMatch = normalized.match(/^(?:LOCAL DO LOTE|LOCAL|ESTADO|UF)?\s*:?\s*([A-Z]{2})$/);
    if (labeledStateMatch?.[1] && BRAZIL_STATE_CODES.has(labeledStateMatch[1])) return labeledStateMatch[1];

    return null;
  }

  function isAllowedCategory(category) {
    const normalized = normalizeCategory(category);
    if (!normalized) return false;

    if (state.settings.allowedCategories.length === 0) return true;

    if (isTruckCategory(normalized)) return state.settings.allowTrucks;
    if (isMotorcycleCategory(normalized)) return state.settings.allowMotorcycles;

    return state.settings.allowedCategories.some((allowed) => normalizeCategory(allowed) === normalized);
  }

  function isTruckCategory(normalizedCategory) {
    return TRUCK_CATEGORY_KEYS.has(normalizedCategory)
      || normalizedCategory.startsWith("CAMINHAO ")
      || normalizedCategory.startsWith("CAMINHOES ")
      || normalizedCategory.startsWith("REBOCADOR ")
      || normalizedCategory.startsWith("ONIBUS ")
      || normalizedCategory.startsWith("MICROONIBUS ");
  }

  function isMotorcycleCategory(normalizedCategory) {
    return MOTORCYCLE_CATEGORY_KEYS.has(normalizedCategory)
      || normalizedCategory.startsWith("MOTO ")
      || normalizedCategory.startsWith("MOTOS ")
      || normalizedCategory.startsWith("MOTOCICLETA ")
      || normalizedCategory.startsWith("MOTOCICLETAS ");
  }

  function normalizeCategory(value) {
    return normalizeForMatch(value ?? "").replace(/[^A-Z0-9]+/g, " ").trim();
  }

  function getSaveSignature(event) {
    return JSON.stringify({
      endpoint: getIngestEndpoint(),
      source: event.source,
      auctionId: event.auctionId,
      lot: event.lot,
      code: event.code,
      consignor: event.consignor,
      condition: event.condition,
      saleStatus: event.saleStatus,
      manualDecision: event.manualDecision ?? getManualDecision(event),
      bidRaw: event.bidRaw,
      fipeRaw: event.fipeRaw,
    });
  }

  function getIngestEndpoint() {
    return DATABASE_INGEST_ENDPOINT;
  }

  function getExtensionToken() {
    try {
      return localStorage.getItem("liveAuctionExtensionToken")?.trim()
        || localStorage.getItem("copartExtensionToken")?.trim()
        || "";
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

  function installFrameBridge() {
    window.addEventListener("message", (messageEvent) => {
      const data = messageEvent.data;
      if (!isRecord(data) || (data.type !== "LIVE_AUCTION_PREVIEW_REQUEST" && data.type !== "COPART_PREVIEW_REQUEST")) return;

      state.markupCache = null;

      const event = buildPreviewEvent();
      const response = {
        type: "LIVE_AUCTION_PREVIEW_RESPONSE",
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

    const requestId = `live-auction-preview-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    return new Promise((resolve) => {
      const events = [];
      const timeoutId = window.setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve(events);
      }, 500);

      function onMessage(messageEvent) {
        const data = messageEvent.data;
        if (!isRecord(data) || (data.type !== "LIVE_AUCTION_PREVIEW_RESPONSE" && data.type !== "COPART_PREVIEW_RESPONSE")) return;
        if (data.requestId !== requestId || !isRecord(data.event)) return;

        events.push(data.event);
      }

      window.addEventListener("message", onMessage);

      for (const frame of frames) {
        try {
          frame.postMessage({ type: "LIVE_AUCTION_PREVIEW_REQUEST", requestId }, "*");
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
    if (event.consignor) score += 1;
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
    const adapter = getActiveAdapter();
    state.adapter = adapter;

    if (adapter.id === "vipleiloes") return buildVipPreviewEvent();
    if (adapter.id === "sodre") return buildSodrePreviewEvent();
    return buildCopartPreviewEvent();
  }

  function buildCopartPreviewEvent() {
    const detail = extractCurrentVehicleDetail();
    const pageCode = findCopartLotCodeFromUrl();
    const lotVaga = detail.lot
      ? { lot: detail.lot, auctionId: null }
      : parseCopartLotVaga(getSearchText());
    const auctionLot = parseAuctionAndLot(detail.auctionLotRaw);
    const currentLot = normalizeCopartLotCandidate(coalesceText(lotVaga?.lot, auctionLot.lot, detail.lot));
    const chat = extractChatState(currentLot);
    const visibleStatus = findVisibleStatusText();
    const visibleSaleStatus = inferSaleStatus(visibleStatus);
    const visibleHasFinalStatus = FINAL_SALE_STATUSES.has(visibleSaleStatus);
    const statusText = visibleHasFinalStatus
      ? visibleStatus
      : coalesceText(chat.finalForCurrentLot?.message, visibleStatus, chat.message);
    const bidRaw = coalesceText(findCurrentBidRaw(), chat.finalForCurrentLot?.bidRaw, chat.bidRaw);
    const bid = parseMoney(bidRaw);
    const fipe = parseMoney(detail.fipeRaw);
    const saleStatus = inferSaleStatus(statusText);
    const code = coalesceText(detail.code, pageCode);
    const individualPage = pageCode != null;
    const description = coalesceText(detail.description, [detail.brand, detail.model].filter(Boolean).join(" "));
    const lot = normalizeCopartLotCandidate(individualPage
      ? coalesceText(currentLot, chat.lot, auctionLot.auctionId, detail.lot)
      : coalesceText(currentLot, chat.lot, auctionLot.lot, detail.lot));

    return {
      source: "copart",
      auctionId: individualPage ? findAuctionId() : coalesceText(auctionLot.auctionId, findAuctionId()),
      lot,
      code,
      description,
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
      consignor: detail.consignor ?? null,
      bid,
      bidRaw,
      saleStatus,
      eventType: inferEventType({ bid, saleStatus, message: statusText }),
      fipePercent: bid != null && fipe != null && fipe > 0 ? Math.round((bid / fipe) * 100) : null,
      imageUrl: findImageUrl(),
      vehicleUrl: pageCode ? buildCopartVehicleUrl(pageCode) : buildCopartVehicleUrl(code),
      message: statusText,
      observedAt: new Date().toISOString(),
    };
  }

  function buildVipPreviewEvent() {
    const details = extractVipDetailTable();
    const title = coalesceText(
      findFirstText(["[data-bind-carrossel-anunciotitulo]"]),
      details.veiculo,
    );
    const brandModel = parseVipBrandModel(title, findFirstText(["[data-bind-carrossel-anunciosubtitulo2]"]));
    const auctionId = coalesceText(
      findInputValue(["#evo-hidden-eventocodigo"]),
      findInputValue(["#evo-hidden-uriamigavel"]),
      findVipAuctionIdFromUrl(),
    );
    const lot = coalesceText(
      findInputValue(["#evo-hidden-anuncionumero"]),
      details.numeroDoLote,
      extractLotNumber(findFirstText(["#evo-numerolote-titulo", "[data-bind-carrossel-anunciotitulonumeroanuncio]"])),
    );
    const slug = findInputValue(["#evo-hidden-anunciouriamigavel"]);
    const code = coalesceText(details.codigo, slug);
    const yearModel = normalizeYearModel(coalesceText(
      findFirstText(["[data-bind-carrossel-anunciosubtitulo1]"]),
      details.ano,
    ));
    const bidRaw = coalesceText(
      extractMoneyText(findFirstText(["#evo-oferta-valoratual"])),
      extractMoneyText(findFirstText(["#evo-transmissao-anunciohistorico li"])),
    );
    const bid = parseMoney(bidRaw);
    const primaryStatusText = findVipPrimaryStatusText();
    const statusText = buildVipStatusText(primaryStatusText);
    const saleStatus = inferVipSaleStatus(primaryStatusText, statusText);
    const yard = coalesceText(details.localizacao, findVipLotState());
    const condition = coalesceText(details.procedencia, details.condicao, details.funcionandoNaEntrada);
    const damage = coalesceText(details.tipoDeMonta, details.monta, "Sem monta");

    return {
      source: "vipleiloes",
      auctionId,
      lot,
      code,
      description: title,
      version: null,
      yearModel,
      brand: brandModel.brand,
      model: brandModel.model,
      category: "Automóveis",
      fipe: null,
      fipeRaw: null,
      damage,
      condition,
      yard,
      consignor: details.comitente ?? null,
      bid,
      bidRaw,
      saleStatus,
      eventType: inferEventType({ bid, saleStatus, message: statusText }),
      fipePercent: null,
      imageUrl: findVipImageUrl(),
      vehicleUrl: buildVipVehicleUrl(slug, auctionId, lot),
      message: statusText,
      observedAt: new Date().toISOString(),
    };
  }

  function extractVipDetailTable() {
    const values = {};

    for (const table of getElements(["#evo-detalhesanuncio-tabela", "#evo-carrossel-principaisinformacoes"]).slice(0, 6)) {
      for (const row of safeQueryAll(table, "tr")) {
        const label = normalizeDetailKey(row.querySelector("th")?.textContent);
        const value = normalizeText(row.querySelector("td")?.textContent);

        if (label && value && values[label] == null) values[label] = value;
      }
    }

    return values;
  }

  function parseVipBrandModel(title, brandHint) {
    const normalizedTitle = normalizeText(title);
    const normalizedBrandHint = normalizeText(brandHint);
    const titleParts = normalizedTitle?.split(/\s+-\s+/).map((part) => normalizeText(part)).filter(Boolean) ?? [];
    const brand = normalizedBrandHint ?? titleParts[0] ?? null;
    let model = titleParts.length > 1 ? titleParts.slice(1).join(" - ") : null;

    if (!model && normalizedTitle && brand) {
      const regex = new RegExp(`^${escapeRegExp(brand)}\\s*-?\\s*`, "i");
      model = normalizeText(normalizedTitle.replace(regex, ""));
    }

    return {
      brand,
      model: normalizeText(model) ?? normalizedTitle,
    };
  }

  function findVipPrimaryStatusText() {
    return findFirstText(["#evo-transmissao-anunciosituacao"]);
  }

  function buildVipStatusText(primaryStatusText) {
    const parts = [
      primaryStatusText,
      findFirstText(["#evo-oferta-tipo"]),
      findFirstText(["#evo-oferta-descricao"]),
      findFirstText(["#evo-oferta-vencedor"]),
      normalizeVipMessage(findFirstText(["#evo-transmissao-texto-anunciomensagem"])),
      ...findVipHistoryTexts(),
    ].map((value) => normalizeText(value)).filter(Boolean);

    return uniqueTexts(parts).join(" | ") || null;
  }

  function findVipHistoryTexts() {
    const texts = [];
    const elements = getElements(["#evo-transmissao-anunciohistorico li"]);
    const candidates = [...elements.slice(0, 4), ...elements.slice(-4)];

    for (const element of candidates) {
      const text = normalizeText(element.textContent);
      if (text) texts.push(text);
    }

    return texts;
  }

  function normalizeVipMessage(value) {
    const text = normalizeText(value);
    if (!text || normalizeForMatch(text) === "SEM MENSAGEM PARA EXIBIR") return null;

    return text;
  }

  function inferVipSaleStatus(primaryStatus, message) {
    const primaryText = normalizeForMatch(primaryStatus ?? "");
    const text = normalizeForMatch(message ?? "");

    if (primaryText.includes("CONDICIONAL")) return "conditional";
    if (primaryText.includes("REPASSE") || primaryText.includes("NAO VENDIDO") || primaryText.includes("NAO FOI VENDIDO")) return "not_sold";
    if (primaryText.includes("VENDIDO") || primaryText.includes("ARREMATADO")) return "sold";
    if (primaryText.includes("EM PREGAO") || primaryText.includes("DOU LHE") || primaryText.includes("DOU-LHE") || primaryText.includes("ABERTO")) return "open";

    if (text.includes("CONDICIONAL") || text.includes("EM ANALISE")) return "conditional";
    if (text.includes("REPASSE") || text.includes("NAO VENDIDO") || text.includes("SEM LANCE") || text.includes("RETIRADO") || text.includes("CANCELADO")) return "not_sold";
    if (text.includes("VENDIDO") || text.includes("ARREMATADO") || text.includes("LANCE VENCEDOR") || text.includes("VENCEDOR")) return "sold";
    if (text.includes("EM PREGAO") || text.includes("DOU LHE") || text.includes("DOU-LHE") || text.includes("ABERTO") || text.includes("LANCE") || text.includes("VALOR ATUAL")) return "open";

    return null;
  }

  function findVipImageUrl() {
    for (const image of getElements([
      "#evo-carrossel-itens .carousel-item.active img",
      "#evo-carrossel-itens img",
      ".carousel-image",
    ])) {
      const url = normalizeImageUrl(image.currentSrc || image.getAttribute("src"));
      if (url) return url;
    }

    return null;
  }

  function buildVipVehicleUrl(slug, auctionId, lot) {
    const normalizedSlug = normalizeText(slug);
    if (normalizedSlug) return `https://www.vipleiloes.com.br/evento/anuncio/${encodeURIComponent(normalizedSlug)}`;

    const normalizedAuctionId = normalizeText(auctionId);
    const normalizedLot = normalizeText(lot)?.replace(/\D/g, "");
    if (normalizedAuctionId && normalizedLot) {
      return `https://www.vipleiloes.com.br/eventoonline/${encodeURIComponent(normalizedAuctionId.toLowerCase())}#lote-${normalizedLot}`;
    }

    return isVipHref(location.href) ? location.href : null;
  }

  function findVipAuctionIdFromUrl() {
    try {
      const url = new URL(location.href);
      const match = url.pathname.match(/\/eventoonline\/([^/?#]+)/i);
      return normalizeText(match?.[1] ?? null);
    }
    catch {
      return null;
    }
  }

  function findVipLotState() {
    const stateText = findFirstText(["[data-bind-anuncio-estado]"]);
    return stateText ? `Local do Lote: ${stateText}` : null;
  }

  function buildSodrePreviewEvent() {
    const imageUrl = findSodreImageUrl();
    const imageIdentity = extractSodreImageIdentity(imageUrl);
    const auctionId = imageIdentity?.auctionId ?? findInputValue(["#leilao_id"]);
    const code = imageIdentity?.code ?? findInputValue(["#lote_id"]);
    const titleRaw = findFirstText([".act-titulo-lote-atual"]);
    const { lot, rest: titleRest } = splitSodreLotTitle(titleRaw);
    const description = findFirstText([".act-descricao-lote-atual"]);
    const vehicleInfo = parseSodreVehicle(description, titleRest);
    const operatorMessage = findFirstText([".act-mensagem-lote-atual"]);
    const statusInfo = findSodreStatusInfo();
    const saleStatus = inferSodreSaleStatus(statusInfo.classes);
    const message = coalesceText(
      uniqueTexts([statusInfo.text, operatorMessage]).join(" | "),
      statusInfo.text,
      operatorMessage,
    );
    const bidRaw = extractMoneyText(findFirstText([".act-valor-lance-atual"]));
    const bid = parseMoney(bidRaw);

    return {
      source: "sodre",
      auctionId,
      lot,
      code,
      description: titleRest ?? description,
      version: null,
      yearModel: vehicleInfo.yearText,
      brand: vehicleInfo.brand,
      model: vehicleInfo.model,
      category: "Automóveis",
      fipe: null,
      fipeRaw: null,
      damage: extractSodreDamage(description),
      condition: null,
      yard: extractSodreYardHint(description),
      consignor: null,
      bid,
      bidRaw,
      saleStatus,
      eventType: inferEventType({ bid, saleStatus, message }),
      fipePercent: null,
      imageUrl,
      vehicleUrl: buildSodreVehicleUrl(auctionId, code),
      message,
      observedAt: new Date().toISOString(),
    };
  }

  function splitSodreLotTitle(titleRaw) {
    const text = normalizeText(titleRaw);
    const match = text?.match(/^(\d{3,6})\s*-\s*(.+)$/);

    return match
      ? { lot: match[1], rest: normalizeText(match[2]) }
      : { lot: null, rest: text };
  }

  function parseSodreVehicle(description, titleRest) {
    const desc = normalizeText(description) ?? "";
    const segments = desc.split(/\s+-\s+/).map((part) => normalizeText(part)).filter(Boolean);
    const head = segments[0] ?? titleRest ?? "";
    const yearSegment = segments.slice(1).find((part) => /\d{4}\s*\/\s*\d{4}/.test(part));
    const yearText = coalesceText(yearSegment, parseSodreShortYearAsFull(titleRest));
    const headParts = head.split(/\s+/).filter(Boolean);

    return {
      brand: headParts[0] ?? null,
      model: headParts.length > 1 ? headParts.slice(1).join(" ") : null,
      yearText,
    };
  }

  function parseSodreShortYearAsFull(text) {
    const match = normalizeText(text)?.match(/(\d{2})\s*\/\s*(\d{2})\s*$/);
    if (!match) return null;

    const toFullYear = (twoDigits) => {
      const value = Number.parseInt(twoDigits, 10);
      return value <= 39 ? 2000 + value : 1900 + value;
    };

    return `${toFullYear(match[1])}/${toFullYear(match[2])}`;
  }

  function findSodreStatusInfo() {
    const element = getElements([".act-status-lote-atual"])[0];
    if (!element) return { text: null, classes: [] };

    return {
      text: normalizeText(element.textContent),
      classes: Array.from(element.classList ?? []),
    };
  }

  function inferSodreSaleStatus(classes) {
    for (const className of classes) {
      const mapped = SODRE_SALE_STATUS_BY_CLASS[className];
      if (mapped) return mapped;
    }

    return null;
  }

  function extractSodreDamage(description) {
    const text = normalizeText(description);
    if (!text) return null;

    const match = text.match(/(?:pequena|m[eé]dia|grande)\s+monta|sucata|perda\s+total|irrecuper[aá]vel|sem\s+monta|n[aã]o\s+batid[oa]|sem\s+sinistro|n[aã]o\s+sinistrad[oa]|semi[- ]?novo|usado/i);
    return match ? normalizeText(match[0]) : null;
  }

  function extractSodreYardHint(description) {
    const text = normalizeText(description);
    if (!text) return null;

    const addressMatch = text.match(/(?:Bem\s+encontra-se|Local(?:iza(?:ção|cao)\s+do\s+lote|\s+do\s+lote)?|P[aá]tio)\s*:\s*(.+?)(?=\s+-\s+|$)/i);
    const address = normalizeText(addressMatch?.[1] ?? null);
    const stateToken = extractStateCode(address) ?? extractStateCode(text);
    const inferredState = inferSodreStateFromLocation(address);
    const stateCode = stateToken ?? inferredState;

    if (address && stateCode) return `${address} - ${stateCode}`;
    return address ?? stateCode;
  }

  function inferSodreStateFromLocation(value) {
    const normalized = normalizeForMatch(value ?? "");
    if (!normalized) return null;

    return SODRE_LOCATION_STATE_HINTS.find(({ term }) => new RegExp(`(?:^| )${term}(?= |$)`).test(normalized))?.state ?? null;
  }

  function findSodreImageUrl() {
    for (const anchor of getElements([".slideshow .item.current a.act-colorbox", ".slideshow .item.current a"])) {
      const url = normalizeImageUrl(anchor.getAttribute("href"));
      if (url) return url;
    }

    for (const image of getElements([".slideshow .item.current img"])) {
      const url = normalizeImageUrl(image.currentSrc || image.getAttribute("src"));
      if (url) return url;
    }

    return null;
  }

  function extractSodreImageIdentity(imageUrl) {
    if (!imageUrl) return null;

    try {
      const match = new URL(imageUrl).pathname.match(/\/veiculos\/(\d+)\/(\d+)\//i);
      if (!match?.[1] || !match[2]) return null;
      return { auctionId: match[1], code: match[2] };
    }
    catch {
      return null;
    }
  }

  function buildSodreVehicleUrl(auctionId, code) {
    const normalizedAuctionId = normalizeText(auctionId)?.replace(/\D/g, "");
    const normalizedCode = normalizeText(code)?.replace(/\D/g, "");

    if (normalizedAuctionId && normalizedCode) {
      return `https://leilao.sodresantoro.com.br/leilao/${normalizedAuctionId}/lote/${normalizedCode}/`;
    }

    return isSodreHref(location.href) ? location.href : null;
  }

  function extractLotNumber(value) {
    return normalizeText(value)?.match(/\bLote\s+([A-Za-z0-9.-]+)/i)?.[1] ?? null;
  }

  function findFirstText(selectors) {
    for (const element of getElements(selectors)) {
      const text = normalizeText(element.textContent);
      if (text) return text;
    }

    return null;
  }

  function findInputValue(selectors) {
    for (const element of getElements(selectors)) {
      const value = normalizeText(element.value ?? element.getAttribute?.("value"));
      if (value) return value;
    }

    return null;
  }

  function normalizeDetailKey(value) {
    const label = normalizeLabel(value);
    const aliases = {
      "veiculo": "veiculo",
      "ano": "ano",
      "cor": "cor",
      "combustivel": "combustivel",
      "km": "km",
      "funcionando na entrada": "funcionandoNaEntrada",
      "procedencia": "procedencia",
      "localizacao": "localizacao",
      "numero do lote": "numeroDoLote",
      "final da placa": "finalDaPlaca",
      "comitente": "comitente",
      "cambio": "cambio",
      "chave": "chave",
      "direcao": "direcao",
      "codigo": "codigo",
      "tipo de monta": "tipoDeMonta",
      "monta": "monta",
      "condicao": "condicao",
    };

    return aliases[label] ?? label.replace(/\s+([a-z0-9])/g, (_, char) => String(char).toUpperCase());
  }

  function uniqueTexts(values) {
    const seen = new Set();
    const output = [];

    for (const value of values) {
      const text = normalizeText(value);
      const key = normalizeForMatch(text ?? "");
      if (!text || seen.has(key)) continue;

      seen.add(key);
      output.push(text);
    }

    return output;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function extractCurrentVehicleDetail() {
    const containers = getElements([
      ".vehicle-detail-container",
      ".current-vehicle-container",
      "colibri-auctions-g2-bidding-tool-vehicle-detail",
    ]).slice(0, 6);
    const rowValues = {};

    for (const container of containers) {
      const values = extractDetailRows(container);
      Object.assign(rowValues, values);
    }

    const essentialKeys = ["description", "code", "brand", "model", "category", "yard", "consignor"];
    if (essentialKeys.every((key) => rowValues[key])) return rowValues;

    const detailMarkup = getVehicleDetailMarkup();
    const fallbackValues = {
      ...extractDetailFromText(getSearchText()),
      ...extractDetailFromText(htmlToText(detailMarkup) ?? ""),
      ...extractDetailFromMarkup(detailMarkup),
    };

    return { ...fallbackValues, ...rowValues };
  }

  function extractDetailRows(container) {
    const values = {};

    for (const root of getReadableRoots(container)) {
      for (const row of safeQueryAll(root, ".data-container")) {
        const label = normalizeLabel(row.querySelector(".data-title")?.textContent);
        const value = normalizeText(row.querySelector(".data-value")?.textContent);

        if (!label || !value) continue;

        if (label === "leilao lote") values.auctionLotRaw = value;
        if (label === "lote vaga") {
          const parsedLot = parseCopartLotVaga(value);
          values.lot = normalizeCopartLotCandidate(parsedLot ? parsedLot.lot : value);
        }
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
        if (label === "comitente") values.consignor = value;
      }
    }

    return values;
  }

  function extractDetailFromMarkup(rawMarkup) {
    const markup = typeof rawMarkup === "string" ? rawMarkup : "";
    const fipeRaw = readDataValueFromMarkup(markup, "FIPE:");

    return removeEmptyValues({
      auctionLotRaw: readDataValueFromMarkup(markup, "Leil[aã]o\\s*\\/\\s*Lote:"),
      lot: normalizeCopartLotCandidate(parseCopartLotVaga(readDataValueFromMarkup(markup, "Lote\\s*\\/\\s*Vaga:"))?.lot),
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
      consignor: readDataValueFromMarkup(markup, "Comitente:"),
    });
  }

  function extractDetailFromText(rawText) {
    const text = normalizeText(rawText) ?? "";

    return removeEmptyValues({
      auctionLotRaw: findTextValue(text, /Leil[aã]o\s*\/\s*Lote:\s*([A-Za-z0-9.-]+\s*\/\s*[A-Za-z0-9.-]+)/i),
      lot: normalizeCopartLotCandidate(
        findTextValue(text, /Lote\s*\/\s*Vaga:\s*([A-Za-z0-9.-]+)\s*\/\s*[A-Za-z0-9.-]+/i)
          ?? findTextValue(text, /\bLote\s*(?:ao vivo|atual)?:\s*([A-Za-z0-9.-]+)/i),
      ),
      code: findTextValue(text, /C[oó]digo(?:\s+Copart)?:\s*([A-Za-z0-9.-]+)/i),
      description: findTextValue(text, /Descri[cç][aã]o:\s*(.*?)\s+Vers[aã]o:/i),
      version: findTextValue(text, /Vers[aã]o:\s*(.*?)(?=\s+(?:Fabrica[cç][aã]o\s*\/\s*Modelo|Ano\s+de\s+Fabrica[cç][aã]o):|$)/i),
      yearModel: normalizeYearModel(
        findTextValue(text, /Fabrica[cç][aã]o\s*\/\s*Modelo:\s*(\d{4}\s*\/\s*\d{4}|\d{4}\/\d{4})/i)
          ?? findTextValue(text, /Ano\s+de\s+Fabrica[cç][aã]o:\s*\d{4}\s+Ano\s+Modelo:\s*(\d{4})/i),
      ),
      brand: findTextValue(text, /Marca:\s*(.*?)\s+Modelo:/i),
      model: findTextValue(text, /Marca:\s*.*?\s+Modelo:\s*(.*?)(?=\s+(?:Vers[aã]o|Ano\s+de\s+Fabrica[cç][aã]o|Categoria):|$)/i),
      category: findTextValue(text, /Categoria:\s*(.*?)(?=\s+(?:Condi[cç][aã]o\s+de\s+Func\.?|Final\s+de\s+Placa|Combust[ií]vel|Chave|Complemento|Notas):|$)/i),
      fipeRaw: extractMoneyText(findTextValue(text, /(?:Valor\s+)?FIPE:\s*(R\$\s*[\d.,]+)/i) ?? ""),
      damage: findTextValue(text, /Tipo de Monta:\s*(.*?)(?=\s+(?:Condi[cç][aã]o|Valor\s+FIPE|FIPE|Tipo de Chassi):|$)/i),
      condition: findTextValue(text, /Condi[cç][aã]o:\s*(.*?)(?=\s+(?:Condi[cç][aã]o\s+Func\.|Valor\s+FIPE|FIPE|Chassi|Tipo de Chassi|P[aá]tio|Comitente):|$)/i),
      yard: findTextValue(text, /P[aá]tio\s+ve[ií]culo\s*:\s*(.*?)(?=\s+(?:Lote\s*\/\s*Vaga|Data\s+da|Comitente):|$)/i)
        ?? findTextValue(text, /P[aá]tio(?:\s+do\s+(?:leil[aã]o|lote))?\s*:\s*(.*?)(?=\s+(?:P[aá]tio|Comitente|Lote\s*\/\s*Vaga|Data\s+da):|$)/i),
      consignor: findTextValue(text, /Comitente:\s*(.*?)(?=\s+(?:Tipo\s+de\s+Monta|Condi[cç][aã]o|Valor\s+FIPE|FIPE|P[aá]tio|Categoria|Oferta|Lance|Status|Leil[aã]o\s*\/\s*Lote):|$)/i),
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

    const finalForCurrentLot = latestForCurrentLot ?? (!currentLot ? latestAnyFinal : null);
    return {
      ...(finalForCurrentLot ?? latestBidAfterCurrentLot ?? latestAnyFinal ?? {}),
      finalForCurrentLot,
    };
  }

  function getSystemMessages() {
    const messages = [];

    for (const root of getScopedRoots([
      ".chat-container",
      ".chat-bidding-container",
      "#chatMessageContainer",
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
    for (const container of getElements([
      "#evo-oferta-valoratual",
      ".main-bid-container",
      ".current-bid",
      "[data-bind*='oferta']",
    ]).filter(isVisibleElement)) {
      const text = normalizeText(container.textContent);
      if (!text) continue;

      const money = findBidRawFromText(text);
      if (money) return money;
    }

    for (const root of getScopedRoots([
      ".bid-container",
      "colibri-auctions-g2-bidding-tool-bid-button",
    ])) {
      if (!isVisibleElement(root)) continue;

      for (const container of safeQueryAll(root, ".main-bid-container, .title-container")) {
        if (!isVisibleElement(container)) continue;
        const text = normalizeText(container.textContent);
        if (!text || !normalizeForMatch(text).includes("OFERTA ATUAL")) continue;

        const money = findBidRawFromText(text);
        if (money) return money;
      }
    }

    return findBidRawFromMarkup(getPageMarkup()) ?? findBidRawFromText(getSearchText());
  }

  function findBidRawFromMarkup(markup) {
    const snippet = getLastSnippetAround(markup, "Oferta atual", 0, 2500);

    return findBidRawFromText(htmlToText(snippet ?? "") ?? "");
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
        if (!isVisibleElement(element)) continue;
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

    return findTextValue(text, /\b(Maior lance\s*-\s*[A-Z]{2}|Condicional\s*-\s*[A-Z]{2}|Vendido\s*-\s*[A-Z]{0,2}|Venda\s+finalizada|Leil[aã]o\s+finalizado|Resultado\s+da\s+condicional\s*:\s*Finalizad[oa]|Dar\s+lance\s+agora|Repasse)\b/i);
  }

  function findStatusFromText(text) {
    const bidSnippet = getLastSnippetAround(text, "Oferta atual", 500, 1200) ?? text;

    return findTextValue(bidSnippet, /\b(Maior lance\s*-\s*[A-Z]{2}|Condicional\s*-\s*[A-Z]{2}|Vendido\s*-\s*[A-Z]{0,2}|Venda\s+finalizada|Leil[aã]o\s+finalizado|Resultado\s+da\s+condicional\s*:\s*Finalizad[oa]|Dar\s+lance\s+agora|Repasse)\b/i);
  }

  function findAuctionId() {
    try {
      return new URL(location.href).searchParams.get("auctionId");
    }
    catch {
      return null;
    }
  }

  function findCopartLotCodeFromUrl() {
    try {
      const url = new URL(location.href);
      if (!isCopartHref(url.href)) return null;
      return normalizeText(url.pathname.match(/\/lot\/(\d+)/i)?.[1] ?? null);
    }
    catch {
      return null;
    }
  }

  function isCopartLotPage() {
    return getActiveAdapter().id === "copart" && findCopartLotCodeFromUrl() != null;
  }

  function isVisibleElement(element) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;

    try {
      if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }
    catch {
      return true;
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

    for (const meta of getElements([
      'meta[property="og:image"]',
      'meta[name="twitter:image"]',
    ])) {
      collectImageCandidatesFromText(meta.getAttribute("content"), candidates, 12);
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
    if (Number(element.naturalWidth ?? 0) > 0 && Number(element.naturalHeight ?? 0) > 0) score += 16;
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
      /BRIMAGES|REPOSITORY[\\/]FOTOS|IMAGETYPE=|IMAGE|PHOTO|THUMB|PIX/i.test(url)
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
    if (state.searchRootsCache != null) return state.searchRootsCache;

    const roots = [];
    const seen = new Set();

    for (const doc of getSearchDocuments()) {
      collectSearchRoot(doc, roots, seen);
    }

    state.searchRootsCache = roots;
    return state.searchRootsCache;
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
    if (state.searchDocumentsCache != null) return state.searchDocumentsCache;

    const docs = [];
    const seen = new Set();

    collectSearchDocument(getRootDocument(), docs, seen);
    state.searchDocumentsCache = docs;
    return state.searchDocumentsCache;
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

  function parseCopartLotVaga(raw) {
    const text = normalizeText(raw);
    if (!text) return null;

    const labeledMatch = text.match(/Lote\s*\/\s*Vaga\s*:\s*([A-Za-z0-9.-]+)\s*\/\s*([A-Za-z0-9.-]+)/i);
    const directMatch = text.match(/^([A-Za-z0-9.-]+)\s*\/\s*([A-Za-z0-9.-]+)$/i);
    const match = labeledMatch ?? directMatch;
    if (!match) return null;

    return {
      lot: normalizeCopartLotCandidate(match[1]),
      vaga: normalizeText(match[2]),
    };
  }

  function normalizeCopartLotCandidate(value) {
    const lot = normalizeText(value);
    if (!lot) return null;

    if (INVALID_COPART_LOT_CANDIDATES.has(normalizeForMatch(lot))) return null;

    return lot;
  }

  function inferSaleStatus(message) {
    const text = normalizeForMatch(message ?? "");

    if (text.includes("NAO VENDIDO") || text.includes("NAO FOI VENDIDO")) return "not_sold";
    if (text.includes("VENDIDO") || text.includes("ARREMATADO") || text.includes("VENDA FINALIZADA") || text.includes("LEILAO FINALIZADO") || (text.includes("RESULTADO DA CONDICIONAL") && text.includes("FINALIZ"))) return "sold";
    if (text.includes("CONDICIONAL")) return "conditional";
    if (text.includes("DAR LANCE") || text.includes("LANCE") || text.includes("OFERTA ATUAL") || text.includes("MAIOR LANCE")) return "open";

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

  function formatMoneyValue(value) {
    const number = numberOrNull(value);
    return number != null ? `R$ ${Math.round(number).toLocaleString("pt-BR")}` : "—";
  }

  function buildReactiveFeeEstimate(baseFeeEstimate, bid) {
    if (!isRecord(baseFeeEstimate) || bid == null || bid <= 0) return baseFeeEstimate;

    const fixedFees = numberOrNull(baseFeeEstimate.fixedFees) ?? 0;
    if (baseFeeEstimate.mode === "fixed") {
      return {
        ...baseFeeEstimate,
        basePrice: bid,
        feesTotal: fixedFees,
        total: bid + fixedFees,
      };
    }

    const commission = Math.round(bid * 0.05);
    const dsal = findReactiveDsalFee(bid);
    const logistics = numberOrNull(baseFeeEstimate.logistics) ?? 0;
    const feesTotal = commission + dsal + fixedFees + logistics;

    return {
      ...baseFeeEstimate,
      basePrice: bid,
      commission,
      dsal,
      feesTotal,
      total: bid + feesTotal,
    };
  }

  function findReactiveDsalFee(price) {
    if (price < 5000) return 600;
    if (price < 10000) return 900;
    if (price < 20000) return 1400;
    if (price < 30000) return 1900;
    if (price < 50000) return 2900;
    if (price < 75000) return 3500;
    return 4500;
  }

  function numberOrNull(value) {
    if (value == null || value === "") return null;
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
  }

  function calculatePercent(value, fipe) {
    const currentValue = numberOrNull(value);
    const currentFipe = numberOrNull(fipe);
    if (currentValue == null || currentFipe == null || currentFipe <= 0) return null;
    return Math.round((currentValue / currentFipe) * 100);
  }

  function extractLatestYear(value) {
    const years = [...String(value ?? "").matchAll(/\b((?:19|20)\d{2})\b/g)]
      .map((match) => Number(match[1]))
      .filter(Number.isFinite);
    return years.length > 0 ? Math.max(...years) : null;
  }

  function getStatusPresentation(value) {
    if (value === "sold") return { key: "sold", label: "Vendido" };
    if (value === "conditional") return { key: "conditional", label: "Condicional" };
    if (value === "not_sold") return { key: "not-sold", label: "Não vendido" };
    if (value === "open") return { key: "open", label: "Em disputa" };
    return { key: "waiting", label: "Aguardando" };
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

  function buildCopartVehicleUrl(code) {
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
        const path = decodeURIComponent(url.pathname)
          .replace(/\\/g, "/")
          .toLowerCase();

        return path.includes("/.extension/copart-live-collector/exemples/")
          || path.includes("/.extension/copart-live-collector/vip/")
          || path.includes("/.extension/sodre/");
      }

      if (url.protocol === "about:" && window.top !== window) return true;

      if (url.protocol !== "http:" && url.protocol !== "https:") return false;

      return ADAPTERS.some((adapter) => adapterMatchesHref(adapter, url.href));
    }
    catch {
      return false;
    }
  }

  function getActiveAdapter() {
    const href = getCurrentHref();
    const adapter = ADAPTERS.find((item) => adapterMatchesHref(item, href));

    return adapter ?? state.adapter ?? COPART_ADAPTER;
  }

  function getAdapterForEvent(event) {
    if (event?.source === VIP_ADAPTER.source) return VIP_ADAPTER;
    if (event?.source === SODRE_ADAPTER.source) return SODRE_ADAPTER;
    if (event?.source === COPART_ADAPTER.source || event?.source === "copart-live") return COPART_ADAPTER;

    return getActiveAdapter();
  }

  function adapterMatchesHref(adapter, href) {
    if (adapter.id === "vipleiloes") return isVipHref(href);
    if (adapter.id === "sodre") return isSodreHref(href);
    return isCopartHref(href);
  }

  function isSodreHref(href) {
    try {
      const url = new URL(href);
      if (url.protocol === "file:") {
        return decodeURIComponent(url.pathname).replace(/\\/g, "/").toLowerCase().includes("/.extension/sodre/");
      }

      return (url.hostname === "sodresantoro.com.br" || url.hostname.endsWith(".sodresantoro.com.br"))
        && /\/app\/telao\//i.test(url.pathname);
    }
    catch {
      return false;
    }
  }

  function isVipHref(href) {
    try {
      const url = new URL(href);
      if (url.protocol === "file:") {
        return decodeURIComponent(url.pathname).replace(/\\/g, "/").toLowerCase().includes("/.extension/copart-live-collector/vip/");
      }

      return (url.hostname === "vipleiloes.com.br" || url.hostname.endsWith(".vipleiloes.com.br"))
        && /\/eventoonline\//i.test(url.pathname);
    }
    catch {
      return false;
    }
  }

  function isCopartHref(href) {
    try {
      const url = new URL(href);
      if (url.protocol === "file:") {
        return decodeURIComponent(url.pathname).replace(/\\/g, "/").toLowerCase().includes("/.extension/copart-live-collector/exemples/");
      }

      const host = url.hostname;
      return host === "copart.com.br" || host.endsWith(".copart.com.br") || host === "copart.com" || host.endsWith(".copart.com");
    }
    catch {
      return false;
    }
  }

  function getCurrentHref() {
    try {
      return location.href;
    }
    catch {
      return "";
    }
  }
})();
