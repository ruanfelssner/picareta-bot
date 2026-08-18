(() => {
  if (window.__liveAuctionCollector) return;
  window.__liveAuctionCollector = true;

  const INGEST_ENDPOINT = "https://picareta-bot.felss.dev/api/vehicles/ingest-text";
  const DATABASE_INGEST_ENDPOINT = "https://picareta-bot.felss.dev/api/vehicles/ingest";
  const FINAL_SALE_STATUSES = new Set(["sold", "conditional", "not_sold"]);
  const SAVE_MODES = { DOCUMENT: "document", DATABASE: "database" };
  const SETTINGS_STORAGE_KEY = "liveAuctionCollector:settings:v1";
  const DEFAULT_SETTINGS = {
    autoSaveStates: ["PR", "SC", "RS", "SP"],
    allowedCategories: ["AUTOMOVEIS", "SUV GRANDES", "SUV PEQUENOS", "PICAPES GRANDES", "PICAPES PEQUENAS"],
    allowTrucks: false,
    allowMotorcycles: false,
    requireDetectedState: true,
  };
  const TRUCK_CATEGORY_KEYS = new Set(["CAMINHAO", "CAMINHOES", "CAMINHOES LEVES", "CAMINHOES PESADOS", "CAMINHOES PEQUENOS"]);
  const MOTORCYCLE_CATEGORY_KEYS = new Set(["MOTO", "MOTOS", "MOTOCICLETA", "MOTOCICLETAS"]);
  const BRAZIL_STATE_CODES = new Set(["AC", "AL", "AM", "AP", "BA", "CE", "DF", "ES", "GO", "MA", "MG", "MS", "MT", "PA", "PB", "PE", "PI", "PR", "RJ", "RN", "RO", "RR", "RS", "SC", "SE", "SP", "TO"]);
  const SORTED_BRAZIL_STATE_CODES = [...BRAZIL_STATE_CODES].sort();
  const DEFAULT_ACTIVE_INTERVAL_MS = 15000;
  const VIP_ACTIVE_INTERVAL_MS = 2500;
  const DEFAULT_ACTIVE_DEBOUNCE_MS = 300;
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
    fipeButton: null,
    fipePanel: null,
    fipeBrandInput: null,
    fipeModelInput: null,
    fipeYearInput: null,
    fipeManualInput: null,
    fipeResults: null,
    soundButton: null,
    decisionToggle: null,
    decisionIcon: null,
    decisionAutoButton: null,
    modeButton: null,
    activateButton: null,
    settingsButton: null,
    settingsPanel: null,
    settingsStatesContainer: null,
    settingsCategoriesInput: null,
    settingsRequireStateInput: null,
    settings: null,
    settingsDraft: null,
    markupCache: null,
    textCache: null,
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
    fipeLoading: false,
    fipeError: null,
    fipeMessage: null,
    fipeSuggestions: [],
    fipeOverrides: new Map(),
    soundEnabled: true,
    audioContext: null,
    lastSoundLotKey: null,
    lastSoundBid: null,
    lastSoundSaleStatus: null,
    active: false,
    saveMessage: null,
    savedCount: 0,
    lastSavedSignature: "",
    savingSignature: "",
    lastSodreSyncAttemptAt: 0,
    manualDecisions: new Map(),
    saveMode: SAVE_MODES.DATABASE,
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
    state.saveMode = readStoredSaveMode();
    state.soundEnabled = readStoredSoundEnabled();
    state.settings = readStoredSettings();
    injectPanel();
    renderPlaceholder();
    renderActiveButton();
    renderModeButton();
    renderSoundButton();

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
      <div class="clp-fipe-panel" data-role="fipe-panel" hidden>
        <div class="clp-section-heading">
          <div>
            <strong>Referência FIPE</strong>
            <span>Escolha uma versão ou informe o valor manualmente.</span>
          </div>
          <button type="button" data-role="toggle-fipe" title="Fechar consulta FIPE" aria-label="Fechar consulta FIPE"><span class="clp-icon" aria-hidden="true">✕</span></button>
        </div>
        <div class="clp-fipe-search">
          <label>Marca<input type="text" data-role="fipe-brand" autocomplete="off"></label>
          <label>Modelo<input type="text" data-role="fipe-model" autocomplete="off"></label>
          <label>Ano<input type="text" data-role="fipe-year" inputmode="numeric" autocomplete="off"></label>
          <button type="button" data-role="fipe-search" title="Consultar modelos FIPE" aria-label="Consultar modelos FIPE"><span class="clp-icon" aria-hidden="true">⌕</span></button>
        </div>
        <div class="clp-fipe-manual">
          <label>FIPE manual<input type="text" data-role="fipe-manual" inputmode="decimal" placeholder="R$ 0"></label>
          <button type="button" data-role="fipe-manual-save" title="Aplicar FIPE manual" aria-label="Aplicar FIPE manual"><span class="clp-icon" aria-hidden="true">✓</span></button>
        </div>
        <div class="clp-fipe-results" data-role="fipe-results"></div>
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
          <div class="clp-settings-label">Categorias Copart permitidas (separadas por virgula)</div>
          <textarea class="clp-settings-textarea" data-role="settings-categories" rows="2"></textarea>
        </div>
        <div class="clp-settings-actions">
          <button type="button" data-role="settings-reset" title="Restaurar configuração padrão" aria-label="Restaurar configuração padrão"><span class="clp-icon" aria-hidden="true">↺</span></button>
          <button type="button" class="clp-primary" data-role="settings-save" title="Salvar configuração" aria-label="Salvar configuração"><span class="clp-icon" aria-hidden="true">✓</span></button>
        </div>
      </div>
      <div class="clp-actions">
        <button type="button" class="clp-primary" data-role="toggle-active" title="Ativar coleta" aria-label="Ativar coleta"><span class="clp-icon" aria-hidden="true">▶</span></button>
        <button type="button" data-role="toggle-decision" title="Alterar decisão de salvamento" aria-label="Alterar decisão de salvamento"><span class="clp-icon" data-decision-icon aria-hidden="true">🚫</span></button>
        <button type="button" data-role="decision-auto" title="Usar regra automática" aria-label="Usar regra automática"><span class="clp-icon" aria-hidden="true">↺</span></button>
        <button type="button" data-role="toggle-mode" title="Alternar modo de salvamento" aria-label="Alternar modo de salvamento"><span class="clp-icon" aria-hidden="true">🗄️</span></button>
        <button type="button" data-role="refresh" title="Atualizar lote" aria-label="Atualizar lote"><span class="clp-icon" aria-hidden="true">🔄</span></button>
        <button type="button" data-role="toggle-fipe" title="Consultar ou ajustar FIPE" aria-label="Consultar ou ajustar FIPE"><span class="clp-icon" aria-hidden="true">💰</span></button>
        <button type="button" data-role="toggle-sound" title="Desativar avisos sonoros" aria-label="Desativar avisos sonoros"><span class="clp-icon" aria-hidden="true">🔔</span></button>
        <button type="button" data-role="toggle-settings" title="Abrir configuração" aria-label="Abrir configuração"><span class="clp-icon" aria-hidden="true">⚙️</span></button>
      </div>
      <pre class="clp-preview" data-role="preview" hidden>{}</pre>
    `;

    document.documentElement.appendChild(root);

    state.root = root;
    state.preview = root.querySelector('[data-role="preview"]');
    state.status = root.querySelector('[data-role="status"]');
    state.summary = root.querySelector('[data-role="summary"]');
    state.fipeButton = root.querySelector('.clp-actions [data-role="toggle-fipe"]');
    state.fipePanel = root.querySelector('[data-role="fipe-panel"]');
    state.fipeBrandInput = root.querySelector('[data-role="fipe-brand"]');
    state.fipeModelInput = root.querySelector('[data-role="fipe-model"]');
    state.fipeYearInput = root.querySelector('[data-role="fipe-year"]');
    state.fipeManualInput = root.querySelector('[data-role="fipe-manual"]');
    state.fipeResults = root.querySelector('[data-role="fipe-results"]');
    state.soundButton = root.querySelector('[data-role="toggle-sound"]');
    state.decisionToggle = root.querySelector('[data-role="toggle-decision"]');
    state.decisionIcon = root.querySelector("[data-decision-icon]");
    state.decisionAutoButton = root.querySelector('[data-role="decision-auto"]');
    state.activateButton = root.querySelector('[data-role="toggle-active"]');
    state.modeButton = root.querySelector('[data-role="toggle-mode"]');
    state.settingsButton = root.querySelector('[data-role="toggle-settings"]');
    state.settingsPanel = root.querySelector('[data-role="settings-panel"]');
    state.settingsStatesContainer = root.querySelector('[data-role="settings-states"]');
    state.settingsCategoriesInput = root.querySelector('[data-role="settings-categories"]');
    state.settingsRequireStateInput = root.querySelector('[data-role="settings-require-state"]');
    state.settingsAllowTrucksInput = root.querySelector('[data-role="settings-allow-trucks"]');
    state.settingsAllowMotorcyclesInput = root.querySelector('[data-role="settings-allow-motorcycles"]');

    root.addEventListener("click", (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const roleTarget = target.closest("[data-role]");
      const role = roleTarget?.getAttribute("data-role");
      if (state.soundEnabled) void unlockAudio();
      if (role === "refresh") void refreshPreview({ forceRender: true });
      if (role === "toggle-active") toggleActive();
      if (role === "toggle-decision") toggleManualDecision();
      if (role === "decision-auto") resetManualDecision();
      if (role === "toggle-mode") toggleSaveMode();
      if (role === "toggle-fipe") toggleFipePanel();
      if (role === "toggle-sound") toggleSound();
      if (role === "fipe-search") void fetchFipeSuggestions();
      if (role === "fipe-manual-save") void applyManualFipe();
      if (role === "fipe-apply") void applyFipeSuggestion(roleTarget);
      if (role === "toggle-settings") toggleSettingsPanel();
      if (role === "settings-save") saveSettingsFromForm();
      if (role === "settings-reset") resetSettingsForm();
      if (role === "settings-state-chip") toggleSettingsStateChip(roleTarget);
      if (role === "hide") hidePanel();
    });

    root.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !(event.target instanceof Element)) return;
      if (event.target.matches('[data-role="fipe-brand"], [data-role="fipe-model"], [data-role="fipe-year"]')) {
        event.preventDefault();
        void fetchFipeSuggestions();
      }
      if (event.target.matches('[data-role="fipe-manual"]')) {
        event.preventDefault();
        void applyManualFipe();
      }
    });
  }

  function hidePanel() {
    state.active = false;
    writeStoredBoolean(getStorageKey("active"), false);
    stopActiveLoop();
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
    state.status.textContent = "Lendo lote";

    try {
      ensureSodreSynchronization();
      await waitForFrameDocuments();

      const localEvent = buildPreviewEvent();
      const frameEvents = await requestFrameSnapshots();
      const mergedEvent = mergeWithFallback(selectBestEvent([localEvent, ...frameEvents]), localEvent);
      const event = applyFipeOverride(mergedEvent);
      handleSoundNotifications(event);
      const signature = getEventSignature(event);
      const shouldRender = options.forceRender || signature !== state.lastSignature;

      if (shouldRender) {
        state.lastSignature = signature;
        state.preview.textContent = JSON.stringify(event, null, 2);
        renderSummary(event);
        scheduleAssistantRefresh(event);
      }

      if (state.active) {
        const saveStateChanged = await maybeSaveEvent(event);
        if (saveStateChanged || shouldRender) renderSummary(event);
      }

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
    const feeEstimate = isRecord(metrics?.feeEstimate) ? metrics.feeEstimate : null;
    const brand = assistantVehicle?.brand ?? event.brand;
    const model = assistantVehicle?.model ?? event.model;
    const year = assistantVehicle?.year ?? extractLatestYear(event.yearModel);
    const imageUrl = assistantVehicle?.imageUrl ?? event.imageUrl;
    const title = [brand, model].filter(Boolean).join(" ") || event.description || "Aguardando lote";
    const subtitle = event.description && normalizeForMatch(event.description) !== normalizeForMatch(title)
      ? event.description
      : null;
    const bid = numberOrNull(event.bid ?? assistantVehicle?.bid);
    const fipe = numberOrNull(assistantVehicle?.fipe ?? event.fipe);
    const fipePercent = numberOrNull(metrics?.fipePercent) ?? calculatePercent(bid, fipe);
    const total = numberOrNull(feeEstimate?.total);
    const totalFipePercent = numberOrNull(metrics?.totalFipePercent);
    const averageSoldPct = numberOrNull(marketAnalysis?.averagePct);
    const averageConditionalPct = numberOrNull(marketAnalysis?.conditionalAveragePct);
    const averageSoldValue = averageSoldPct != null && fipe != null ? Math.round(fipe * averageSoldPct / 100) : null;
    const averageConditionalValue = averageConditionalPct != null && fipe != null ? Math.round(fipe * averageConditionalPct / 100) : null;
    const status = getStatusPresentation(event.saleStatus);
    const matched = state.assistant?.matched === true;
    const marketStatus = metrics?.marketStatus === "within" || metrics?.marketStatus === "above"
      ? metrics.marketStatus
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
          ${imageUrl ? `<img src="${escapeHtml(imageUrl)}" alt="" referrerpolicy="no-referrer">` : ""}
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

    renderDecision(event);
    renderFipePanel();
  }

  function renderDecision(event) {
    if (!state.decisionToggle || !state.decisionIcon) return;

    const decision = getSaveDecision(event);
    const manualDecision = getManualDecision(event);
    const hasDecisionKey = getDecisionKey(event) != null;
    const willSaveEventually = decision.shouldSave || decision.pending;
    const title = willSaveEventually
      ? decision.pending ? "Vai salvar no final" : "Vai salvar"
      : "Nao vai salvar";
    const modeText = state.saveMode === SAVE_MODES.DOCUMENT ? "Documento" : "Automatico";
    const detail = `${modeText}: ${decision.reason}`;

    state.decisionIcon.textContent = willSaveEventually ? "💾" : "🚫";
    state.decisionToggle.dataset.decision = willSaveEventually ? "save" : "skip";
    state.decisionToggle.dataset.mode = manualDecision === "auto" ? "auto" : "manual";
    state.decisionToggle.disabled = state.saveMode === SAVE_MODES.DOCUMENT || !hasDecisionKey;
    state.decisionToggle.title = !hasDecisionKey
      ? "Aguardando identificação do lote"
      : state.saveMode === SAVE_MODES.DOCUMENT
        ? "Decisão manual disponível somente no modo Banco"
        : `${title}. ${detail}. Clique para alternar.`;
    state.decisionToggle.setAttribute("aria-label", state.decisionToggle.title);

    if (state.decisionAutoButton) {
      state.decisionAutoButton.disabled = manualDecision === "auto" || state.saveMode === SAVE_MODES.DOCUMENT || !hasDecisionKey;
      state.decisionAutoButton.dataset.active = String(manualDecision !== "auto");
      state.decisionAutoButton.title = manualDecision === "auto"
        ? "Regra automática ativa"
        : "Voltar para regra automática";
      state.decisionAutoButton.setAttribute("aria-label", state.decisionAutoButton.title);
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
      bid: event.bid,
      fipe: event.fipe,
      vehicleUrl: event.vehicleUrl,
    });
  }

  function toggleFipePanel() {
    if (!state.fipePanel) return;

    const opening = state.fipePanel.hidden;
    state.fipePanel.hidden = !opening;
    if (state.fipeButton) {
      state.fipeButton.dataset.active = String(opening);
      state.fipeButton.title = opening ? "Fechar consulta FIPE" : "Consultar ou ajustar FIPE";
      state.fipeButton.setAttribute("aria-label", state.fipeButton.title);
    }

    if (!opening) return;

    if (state.settingsPanel && !state.settingsPanel.hidden) toggleSettingsPanel();
    populateFipeForm();
    renderFipePanel();

    const hasQuery = state.fipeBrandInput?.value.trim()
      && state.fipeModelInput?.value.trim()
      && state.fipeYearInput?.value.trim();
    if (hasQuery && state.fipeSuggestions.length === 0) void fetchFipeSuggestions();
  }

  function populateFipeForm() {
    const event = getCurrentPreviewEvent();
    const assistantVehicle = isRecord(state.assistant?.vehicle) ? state.assistant.vehicle : null;
    const fipe = numberOrNull(assistantVehicle?.fipe ?? event.fipe);

    if (state.fipeBrandInput) state.fipeBrandInput.value = String(assistantVehicle?.brand ?? event.brand ?? "");
    if (state.fipeModelInput) state.fipeModelInput.value = String(assistantVehicle?.model ?? event.model ?? "");
    if (state.fipeYearInput) state.fipeYearInput.value = String(assistantVehicle?.year ?? extractLatestYear(event.yearModel) ?? "");
    if (state.fipeManualInput) state.fipeManualInput.value = fipe != null ? fipe.toLocaleString("pt-BR") : "";
  }

  function renderFipePanel() {
    if (!state.fipeResults) return;

    if (state.fipeLoading) {
      state.fipeResults.innerHTML = '<div class="clp-fipe-state">Consultando tabela FIPE...</div>';
      return;
    }

    const message = state.fipeError
      ? `<div class="clp-fipe-state clp-fipe-state-error">${escapeHtml(state.fipeError)}</div>`
      : state.fipeMessage
        ? `<div class="clp-fipe-state clp-fipe-state-success">${escapeHtml(state.fipeMessage)}</div>`
        : "";

    if (state.fipeSuggestions.length === 0) {
      state.fipeResults.innerHTML = message || '<div class="clp-fipe-state">Use a busca para listar versões compatíveis.</div>';
      return;
    }

    const suggestions = state.fipeSuggestions.map((suggestion, index) => {
      const price = numberOrNull(suggestion.price);
      const currentBid = numberOrNull(getCurrentPreviewEvent().bid);
      const percent = calculatePercent(currentBid, price);

      return `
        <button type="button" class="clp-fipe-option" data-role="fipe-apply" data-index="${index}" ${price == null ? "disabled" : ""}>
          <span>
            <strong>${escapeHtml([suggestion.brandName, suggestion.modelName].filter(Boolean).join(" "))}</strong>
            <small>${escapeHtml([suggestion.yearName, suggestion.fuel, suggestion.codeFipe ? `Código ${suggestion.codeFipe}` : null].filter(Boolean).join(" · "))}</small>
          </span>
          <span class="clp-fipe-option-value">
            <strong>${escapeHtml(formatMoneyValue(price))}</strong>
            <small>${percent != null ? `${escapeHtml(percent)}% da FIPE` : "Selecionar"}</small>
          </span>
        </button>
      `;
    }).join("");

    state.fipeResults.innerHTML = `${message}${suggestions}`;
  }

  async function fetchFipeSuggestions() {
    const brand = state.fipeBrandInput?.value.trim() ?? "";
    const model = state.fipeModelInput?.value.trim() ?? "";
    const year = Number(state.fipeYearInput?.value.trim() ?? "");

    state.fipeError = null;
    state.fipeMessage = null;
    if (!brand || !model || !Number.isFinite(year) || year < 1900) {
      state.fipeSuggestions = [];
      state.fipeError = "Informe marca, modelo e ano.";
      renderFipePanel();
      return;
    }

    state.fipeLoading = true;
    state.fipeSuggestions = [];
    renderFipePanel();

    const response = await requestLocalApi("/api/vehicles/live-assistant/fipe-suggestions", {
      method: "POST",
      body: { brand, model, year, limit: 6 },
    });

    state.fipeLoading = false;
    if (!response.ok || !isRecord(response.body)) {
      state.fipeError = getApiErrorMessage(response.body) ?? "Falha ao consultar FIPE.";
      renderFipePanel();
      return;
    }

    state.fipeSuggestions = Array.isArray(response.body.suggestions)
      ? response.body.suggestions.filter(isRecord)
      : [];
    if (state.fipeSuggestions.length === 0) state.fipeError = "Nenhuma versão encontrada.";
    renderFipePanel();
  }

  async function applyFipeSuggestion(target) {
    const index = Number(target?.getAttribute("data-index"));
    const suggestion = Number.isInteger(index) ? state.fipeSuggestions[index] : null;
    const fipe = numberOrNull(suggestion?.price);
    if (!suggestion || fipe == null) return;

    state.fipeError = null;
    state.fipeMessage = null;
    const matchedId = getAssistantVehicleId();
    let persisted = false;

    if (matchedId) {
      const response = await requestLocalApi(`/api/vehicles/${encodeURIComponent(matchedId)}/fipe`, {
        method: "POST",
        body: {
          brandCode: suggestion.brandCode,
          brandName: suggestion.brandName,
          modelCode: suggestion.modelCode,
          modelName: suggestion.modelName,
          yearCode: suggestion.yearCode,
          yearName: suggestion.yearName,
        },
      });
      persisted = response.ok;
      if (!response.ok) state.fipeError = getApiErrorMessage(response.body) ?? "FIPE aplicada somente ao lote atual.";
    }

    applyFipeValue(fipe, suggestion.priceRaw ?? formatMoneyValue(fipe));
    state.fipeMessage = persisted ? "FIPE aplicada e salva na base." : "FIPE aplicada ao lote atual.";
    renderFipePanel();
  }

  async function applyManualFipe() {
    const fipe = parseMoneyInput(state.fipeManualInput?.value ?? "");
    if (fipe == null || fipe <= 0) {
      state.fipeError = "Informe um valor FIPE válido.";
      state.fipeMessage = null;
      renderFipePanel();
      return;
    }

    state.fipeError = null;
    state.fipeMessage = null;
    const matchedId = getAssistantVehicleId();
    let persisted = false;

    if (matchedId) {
      const response = await requestLocalApi(`/api/vehicles/${encodeURIComponent(matchedId)}/edit`, {
        method: "PATCH",
        body: { fipe },
      });
      persisted = response.ok;
      if (!response.ok) state.fipeError = getApiErrorMessage(response.body) ?? "FIPE aplicada somente ao lote atual.";
    }

    applyFipeValue(fipe, formatMoneyValue(fipe));
    state.fipeMessage = persisted ? "FIPE manual salva na base." : "FIPE manual aplicada ao lote atual.";
    renderFipePanel();
  }

  function applyFipeValue(fipe, fipeRaw) {
    const currentEvent = getCurrentPreviewEvent();
    setFipeOverride(currentEvent, fipe, fipeRaw);
    const event = applyFipeOverride(currentEvent);
    state.preview.textContent = JSON.stringify(event, null, 2);
    state.lastSignature = getEventSignature(event);
    state.assistant = null;
    state.assistantSignature = "";
    state.assistantPendingSignature = "";
    renderSummary(event);
    scheduleAssistantRefresh(event, { immediate: true, force: true });
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

  function getAssistantVehicleId() {
    const vehicle = isRecord(state.assistant?.vehicle) ? state.assistant.vehicle : null;
    return typeof vehicle?._id === "string" && vehicle._id ? vehicle._id : null;
  }

  function toggleActive() {
    state.active = !state.active;
    writeStoredBoolean(getStorageKey("active"), state.active);
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
    ensureSodreSynchronization();
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
    return getActiveAdapter().id === "vipleiloes" ? VIP_ACTIVE_DEBOUNCE_MS : DEFAULT_ACTIVE_DEBOUNCE_MS;
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

  function renderModeButton() {
    if (!state.modeButton) return;

    const icon = state.saveMode === SAVE_MODES.DOCUMENT ? "📄" : "🗄️";
    state.modeButton.innerHTML = `<span class="clp-icon" aria-hidden="true">${icon}</span>`;
    state.modeButton.dataset.mode = state.saveMode;
    state.modeButton.title = `Modo: ${getSaveModeLabel()}. Clique para alternar.`;
    state.modeButton.setAttribute("aria-label", state.modeButton.title);
  }

  function renderSoundButton() {
    if (!state.soundButton) return;

    state.soundButton.innerHTML = state.soundEnabled
      ? '<span class="clp-icon" aria-hidden="true">🔔</span>'
      : '<span class="clp-icon" aria-hidden="true">🔕</span>';
    state.soundButton.dataset.active = String(state.soundEnabled);
    state.soundButton.title = state.soundEnabled ? "Desativar avisos sonoros" : "Ativar avisos sonoros";
    state.soundButton.setAttribute("aria-label", state.soundButton.title);
  }

  function toggleSound() {
    state.soundEnabled = !state.soundEnabled;
    writeStoredValue(getStorageKey("sound"), state.soundEnabled ? "1" : "0");
    renderSoundButton();

    if (state.soundEnabled) {
      void unlockAudio().then(() => {
        playBidSound();
      });
    }
  }

  function handleSoundNotifications(event) {
    const lotKey = getDecisionKey(event);
    const bid = numberOrNull(event.bid);
    const saleStatus = event.saleStatus ?? null;

    if (!lotKey) {
      state.lastSoundLotKey = null;
      state.lastSoundBid = null;
      state.lastSoundSaleStatus = null;
      return;
    }

    if (state.lastSoundLotKey !== lotKey) {
      state.lastSoundLotKey = lotKey;
      state.lastSoundBid = bid;
      state.lastSoundSaleStatus = saleStatus;
      return;
    }

    const becameSold = saleStatus === "sold" && state.lastSoundSaleStatus !== "sold";
    const becameConditional = saleStatus === "conditional" && state.lastSoundSaleStatus !== "conditional";
    const becameNotSold = saleStatus === "not_sold" && state.lastSoundSaleStatus !== "not_sold";
    const receivedBid = bid != null && state.lastSoundBid != null && bid > state.lastSoundBid;

    if (state.soundEnabled) {
      if (becameSold) playSoldSound();
      else if (becameConditional) playConditionalSound();
      else if (becameNotSold) playNotSoldSound();
      else if (receivedBid) playBidSound();
    }

    if (bid != null) state.lastSoundBid = bid;
    state.lastSoundSaleStatus = saleStatus;
  }

  async function unlockAudio() {
    const audioContext = getAudioContext();
    if (!audioContext || audioContext.state === "running") return;

    try {
      await audioContext.resume();
    }
    catch {
      // O navegador pode exigir uma nova interação do usuário.
    }
  }

  function getAudioContext() {
    if (state.audioContext) return state.audioContext;

    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof AudioContextClass !== "function") return null;

    try {
      state.audioContext = new AudioContextClass();
      return state.audioContext;
    }
    catch {
      return null;
    }
  }

  function playBidSound() {
    playSoundSequence([
      { frequency: 880, duration: 0.11, gain: 0.1 },
      { frequency: 660, duration: 0.18, gain: 0.08 },
    ]);
  }

  function playSoldSound() {
    playSoundSequence([
      { frequency: 523.25, duration: 0.1, gain: 0.09 },
      { frequency: 659.25, duration: 0.1, gain: 0.1 },
      { frequency: 783.99, duration: 0.12, gain: 0.11 },
      { frequency: 1046.5, duration: 0.26, gain: 0.12 },
    ]);
  }

  function playConditionalSound() {
    playSoundSequence([
      { frequency: 659.25, duration: 0.12, gain: 0.09 },
      { frequency: 587.33, duration: 0.14, gain: 0.08 },
      { frequency: 659.25, duration: 0.2, gain: 0.09 },
    ]);
  }

  function playNotSoldSound() {
    playSoundSequence([
      { frequency: 392, duration: 0.16, gain: 0.09 },
      { frequency: 293.66, duration: 0.28, gain: 0.1 },
    ]);
  }

  function playSoundSequence(notes) {
    const audioContext = getAudioContext();
    if (!audioContext || audioContext.state !== "running") return;

    let startAt = audioContext.currentTime + 0.015;
    for (const note of notes) {
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();
      const endAt = startAt + note.duration;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(note.frequency, startAt);
      gainNode.gain.setValueAtTime(0.0001, startAt);
      gainNode.gain.exponentialRampToValueAtTime(note.gain, startAt + 0.018);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, endAt);
      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);
      oscillator.start(startAt);
      oscillator.stop(endAt + 0.02);
      startAt = endAt + 0.035;
    }
  }

  function toggleSaveMode() {
    state.saveMode = state.saveMode === SAVE_MODES.DOCUMENT ? SAVE_MODES.DATABASE : SAVE_MODES.DOCUMENT;
    writeStoredValue(getStorageKey("saveMode"), state.saveMode);
    state.lastSavedSignature = "";
    state.saveMessage = state.saveMode === SAVE_MODES.DOCUMENT
      ? "Pronto para salvar no documento"
      : "Pronto para salvar no banco";
    renderModeButton();
    renderSummary(getCurrentPreviewEvent());
  }

  function getSaveModeLabel() {
    return state.saveMode === SAVE_MODES.DOCUMENT ? "Documento" : "Banco";
  }

  function toggleSettingsPanel() {
    if (!state.settingsPanel) return;

    const opening = state.settingsPanel.hidden;
    if (opening) {
      if (state.fipePanel && !state.fipePanel.hidden) toggleFipePanel();
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

  function readStoredBoolean(key) {
    try {
      return localStorage.getItem(key) === "1";
    }
    catch {
      return false;
    }
  }

  function readStoredSaveMode() {
    try {
      return localStorage.getItem(getStorageKey("saveMode")) === SAVE_MODES.DOCUMENT
        ? SAVE_MODES.DOCUMENT
        : SAVE_MODES.DATABASE;
    }
    catch {
      return SAVE_MODES.DATABASE;
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

  function writeStoredValue(key, value) {
    try {
      localStorage.setItem(key, value);
    }
    catch {
      // Storage pode estar indisponivel em alguns contextos.
    }
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
      consignor: event.consignor,
      bidRaw: event.bidRaw,
      fipe: event.fipe,
      fipeRaw: event.fipeRaw,
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
    const source = normalizeText(event.source) ?? getActiveAdapter().source;
    const code = normalizeText(event.code);
    if (code) return `${source}:code:${code}`;

    const auctionId = normalizeText(event.auctionId);
    const lot = normalizeText(event.lot);
    if (auctionId && lot) return `${source}:auction:${auctionId}:lot:${lot}`;

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
      const savedLabel = state.saveMode === SAVE_MODES.DOCUMENT ? "Salvo no documento" : "Salvo na base";
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
        logCollector("post_falhou", eventToSave, {
          status: response.status,
          decisionMode: decision.mode,
          message: state.saveMessage,
        });
        return true;
      }

      state.lastSavedSignature = signature;
      state.savedCount += 1;
      state.saveMessage = state.saveMode === SAVE_MODES.DOCUMENT ? "Salvo no documento" : "Salvo na base";
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

  function readStoredSoundEnabled() {
    try {
      return localStorage.getItem(getStorageKey("sound")) !== "0";
    }
    catch {
      return true;
    }
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

  function getSaveDecision(event, options = {}) {
    if (state.saveMode === SAVE_MODES.DOCUMENT) {
      const hardReason = getHardSaveBlockReason(event);

      if (hardReason === "Aguardando resultado") {
        return {
          mode: SAVE_MODES.DOCUMENT,
          manualDecision: "auto",
          shouldSave: false,
          pending: true,
          reason: "Aguardando resultado final",
        };
      }

      if (hardReason) {
        return {
          mode: SAVE_MODES.DOCUMENT,
          manualDecision: "auto",
          shouldSave: false,
          pending: false,
          reason: hardReason,
        };
      }

      return {
        mode: SAVE_MODES.DOCUMENT,
        manualDecision: "auto",
        shouldSave: true,
        pending: false,
        reason: "Todos os filtros automaticos desligados",
      };
    }

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
          reason: softReason,
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

    if (isBlockedDamage(event)) return "Monta descartada";

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

    if (isTruckCategory(normalized)) return state.settings.allowTrucks;
    if (isMotorcycleCategory(normalized)) return state.settings.allowMotorcycles;

    return state.settings.allowedCategories.some((allowed) => normalizeCategory(allowed) === normalized);
  }

  function isTruckCategory(normalizedCategory) {
    return TRUCK_CATEGORY_KEYS.has(normalizedCategory)
      || normalizedCategory.startsWith("CAMINHAO ")
      || normalizedCategory.startsWith("CAMINHOES ");
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
    return state.saveMode === SAVE_MODES.DOCUMENT ? INGEST_ENDPOINT : DATABASE_INGEST_ENDPOINT;
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

  function isBlockedDamage(event) {
    const text = normalizeForMatch([event.damage, event.condition, event.description].filter(Boolean).join(" "));
    return /GRANDE\s+MONTA|SUCATA|PERDA\s+TOTAL|IRRECUPERAVEL|RECUPERACAO\s+IMPOSSIVEL/.test(text);
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
    const auctionLot = parseAuctionAndLot(detail.auctionLotRaw);
    const chat = extractChatState(auctionLot.lot);
    const visibleStatus = findVisibleStatusText();
    const statusText = coalesceText(visibleStatus, chat.message);
    const bidRaw = coalesceText(chat.bidRaw, findCurrentBidRaw());
    const bid = parseMoney(bidRaw);
    const fipe = parseMoney(detail.fipeRaw);
    const saleStatus = inferSaleStatus(statusText);

    return {
      source: "copart",
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
      consignor: detail.consignor ?? null,
      bid,
      bidRaw,
      saleStatus,
      eventType: inferEventType({ bid, saleStatus, message: statusText }),
      fipePercent: bid != null && fipe != null && fipe > 0 ? Math.round((bid / fipe) * 100) : null,
      imageUrl: findImageUrl(),
      vehicleUrl: buildCopartVehicleUrl(detail.code),
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
      consignor: findTextValue(text, /Comitente:\s*(.{2,120}?)(?=\s+(?:Oferta|Lance|Status|Leil[aã]o\s*\/\s*Lote):|$)/i),
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

  function parseMoneyInput(raw) {
    const text = String(raw ?? "").trim().replace(/^R\$\s*/i, "");
    if (!text) return null;

    const normalized = text.includes(",")
      ? text.replace(/\./g, "").replace(",", ".")
      : /^\d{1,3}(?:\.\d{3})+$/.test(text)
        ? text.replace(/\./g, "")
        : text.replace(/[^\d.]/g, "");
    const value = Number.parseFloat(normalized);
    return Number.isFinite(value) ? Math.round(value) : null;
  }

  function formatMoneyValue(value) {
    const number = numberOrNull(value);
    return number != null ? `R$ ${Math.round(number).toLocaleString("pt-BR")}` : "—";
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
