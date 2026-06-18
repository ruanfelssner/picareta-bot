(() => {
  if (window.__copartLiveCollector) return;

  const STORAGE_KEY = "copartLiveCollector.config";
  const DEFAULT_API_URL = "http://localhost:3000/api/copart-live/events";
  const MAX_LOGS = 80;

  const FIELD_DEFS = [
    { key: "auctionId", label: "ID do leilao", parser: "text", attribute: "textContent" },
    { key: "lot", label: "Lote ao vivo", parser: "text", attribute: "textContent" },
    { key: "code", label: "Codigo Copart", parser: "text", attribute: "textContent" },
    { key: "description", label: "Descricao", parser: "text", attribute: "textContent" },
    { key: "version", label: "Versao", parser: "text", attribute: "textContent" },
    { key: "yearModel", label: "Ano/modelo", parser: "text", attribute: "textContent" },
    { key: "bidRaw", label: "Lance atual", parser: "money", attribute: "textContent" },
    { key: "fipeRaw", label: "FIPE", parser: "money", attribute: "textContent" },
    { key: "damage", label: "Tipo de monta", parser: "text", attribute: "textContent" },
    { key: "yard", label: "Patio", parser: "text", attribute: "textContent" },
    { key: "statusText", label: "Status/mensagem", parser: "text", attribute: "textContent" },
    { key: "imageUrl", label: "Imagem", parser: "url", attribute: "src" },
    { key: "vehicleUrl", label: "URL do lote", parser: "url", attribute: "href" },
  ];

  const ATTRIBUTE_OPTIONS = [
    "textContent",
    "href",
    "src",
    "currentSrc",
    "alt",
    "title",
    "aria-label",
    "value",
  ];

  const PARSER_OPTIONS = ["text", "money", "integer", "url"];

  const state = {
    config: getDefaultConfig(),
    running: false,
    pickerField: null,
    observer: null,
    intervalId: null,
    pendingEvents: [],
    lastSignature: "",
    stats: {
      captured: 0,
      sent: 0,
      pending: 0,
    },
    logs: [],
    elements: {},
  };

  window.__copartLiveCollector = state;

  init().catch((error) => {
    console.error("[copart-collector] falha ao iniciar", error);
  });

  async function init() {
    state.config = await loadConfig();
    injectUi();
    bindPickerEvents();
    render();
    log("Extensao iniciada.");
  }

  function getDefaultConfig() {
    const fields = {};

    for (const field of FIELD_DEFS) {
      fields[field.key] = {
        selector: "",
        attribute: field.attribute,
        parser: field.parser,
      };
    }

    return {
      apiUrl: DEFAULT_API_URL,
      apiToken: "",
      intervalMs: 1500,
      fields,
    };
  }

  function loadConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (result) => {
        resolve(mergeConfig(result[STORAGE_KEY]));
      });
    });
  }

  function saveConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: state.config }, resolve);
    });
  }

  function mergeConfig(value) {
    const base = getDefaultConfig();
    const source = isRecord(value) ? value : {};
    const sourceFields = isRecord(source.fields) ? source.fields : {};

    return {
      apiUrl: typeof source.apiUrl === "string" ? source.apiUrl : base.apiUrl,
      apiToken: typeof source.apiToken === "string" ? source.apiToken : base.apiToken,
      intervalMs: toPositiveInteger(source.intervalMs, base.intervalMs),
      fields: FIELD_DEFS.reduce((acc, field) => {
        const saved = isRecord(sourceFields[field.key]) ? sourceFields[field.key] : {};

        acc[field.key] = {
          selector: typeof saved.selector === "string" ? saved.selector : "",
          attribute: ATTRIBUTE_OPTIONS.includes(saved.attribute) ? saved.attribute : field.attribute,
          parser: PARSER_OPTIONS.includes(saved.parser) ? saved.parser : field.parser,
        };

        return acc;
      }, {}),
    };
  }

  function injectUi() {
    const root = document.createElement("div");
    root.className = "clc-root";
    root.innerHTML = `
      <button type="button" class="clc-toggle" data-role="toggle">
        <span>Copart Coletor</span>
        <span data-role="toggle-count">0</span>
      </button>

      <div class="clc-panel" data-role="panel" hidden>
        <div class="clc-header">
          <div class="clc-title">
            <strong>Copart Live Collector</strong>
            <span data-role="status">Parado</span>
          </div>
          <button type="button" class="clc-close" data-role="close">x</button>
        </div>

        <div class="clc-body">
          <section class="clc-section">
            <div class="clc-section-title">Conexao</div>
            <div class="clc-input-row">
              <label for="clc-api-url">Endpoint</label>
              <input id="clc-api-url" class="clc-input" data-role="api-url" type="text">
            </div>
            <div class="clc-input-row">
              <label for="clc-api-token">Token opcional</label>
              <input id="clc-api-token" class="clc-input" data-role="api-token" type="password" autocomplete="off">
            </div>
            <div class="clc-input-row">
              <label for="clc-interval">Intervalo de leitura em ms</label>
              <input id="clc-interval" class="clc-input" data-role="interval" type="number" min="500" step="100">
            </div>
          </section>

          <section class="clc-section">
            <div class="clc-actions">
              <button type="button" class="clc-button" data-variant="primary" data-role="start">Iniciar</button>
              <button type="button" class="clc-button" data-variant="danger" data-role="stop">Parar</button>
              <button type="button" class="clc-button" data-role="capture">Capturar</button>
              <button type="button" class="clc-button" data-role="flush">Enviar fila</button>
              <button type="button" class="clc-button" data-role="preview">Preview</button>
              <button type="button" class="clc-button" data-role="export">Exportar</button>
            </div>
          </section>

          <section class="clc-section">
            <div class="clc-stats">
              <div class="clc-stat"><span>Capturados</span><strong data-role="captured">0</strong></div>
              <div class="clc-stat"><span>Enviados</span><strong data-role="sent">0</strong></div>
              <div class="clc-stat"><span>Fila</span><strong data-role="pending">0</strong></div>
            </div>
          </section>

          <section class="clc-section">
            <div class="clc-section-title">Mapeamento</div>
            <div class="clc-field-list" data-role="fields"></div>
          </section>

          <section class="clc-section">
            <div class="clc-section-title">Preview</div>
            <pre class="clc-preview" data-role="preview-output">{}</pre>
          </section>

          <section class="clc-section">
            <div class="clc-section-title">Logs</div>
            <pre class="clc-log" data-role="logs"></pre>
          </section>
        </div>
      </div>

      <div class="clc-picker-banner" data-role="picker-banner" hidden></div>
      <div class="clc-highlight" data-role="highlight" hidden></div>
    `;

    document.documentElement.appendChild(root);

    state.elements = {
      root,
      toggle: root.querySelector('[data-role="toggle"]'),
      toggleCount: root.querySelector('[data-role="toggle-count"]'),
      panel: root.querySelector('[data-role="panel"]'),
      status: root.querySelector('[data-role="status"]'),
      fields: root.querySelector('[data-role="fields"]'),
      preview: root.querySelector('[data-role="preview-output"]'),
      logs: root.querySelector('[data-role="logs"]'),
      highlight: root.querySelector('[data-role="highlight"]'),
      pickerBanner: root.querySelector('[data-role="picker-banner"]'),
      apiUrl: root.querySelector('[data-role="api-url"]'),
      apiToken: root.querySelector('[data-role="api-token"]'),
      interval: root.querySelector('[data-role="interval"]'),
      captured: root.querySelector('[data-role="captured"]'),
      sent: root.querySelector('[data-role="sent"]'),
      pending: root.querySelector('[data-role="pending"]'),
    };

    root.addEventListener("click", onRootClick);
    root.addEventListener("change", onRootChange);
    root.addEventListener("input", onRootInput);
  }

  function onRootClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const roleElement = target.closest("[data-role]");
    if (!(roleElement instanceof HTMLElement)) return;

    const role = roleElement.dataset.role;

    if (role === "toggle") togglePanel();
    if (role === "close") closePanel();
    if (role === "start") startCollection();
    if (role === "stop") stopCollection();
    if (role === "capture") collectNow("manual");
    if (role === "flush") void flushEvents();
    if (role === "preview") renderPreview();
    if (role === "export") exportConfig();
    if (role === "pick") startPicker(roleElement.dataset.field ?? "");
    if (role === "clear-field") clearField(roleElement.dataset.field ?? "");
  }

  function onRootChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement)) return;

    const fieldKey = target.dataset.field;
    const prop = target.dataset.prop;

    if (!fieldKey || !prop || !state.config.fields[fieldKey]) return;

    state.config.fields[fieldKey][prop] = target.value;
    void saveConfig().then(() => {
      renderPreview();
      renderFields();
      log(`Campo ${fieldKey} atualizado.`);
    });
  }

  function onRootInput(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.dataset.role === "api-url") state.config.apiUrl = target.value.trim();
    if (target.dataset.role === "api-token") state.config.apiToken = target.value.trim();
    if (target.dataset.role === "interval") {
      state.config.intervalMs = toPositiveInteger(target.value, state.config.intervalMs);
    }

    void saveConfig();
  }

  function render() {
    state.elements.apiUrl.value = state.config.apiUrl;
    state.elements.apiToken.value = state.config.apiToken;
    state.elements.interval.value = String(state.config.intervalMs);
    renderStats();
    renderFields();
    renderPreview();
    renderLogs();
  }

  function renderStats() {
    state.stats.pending = state.pendingEvents.length;
    state.elements.captured.textContent = String(state.stats.captured);
    state.elements.sent.textContent = String(state.stats.sent);
    state.elements.pending.textContent = String(state.stats.pending);
    state.elements.toggleCount.textContent = `${state.stats.sent}/${state.stats.captured}`;
    state.elements.toggle.dataset.running = String(state.running);
    state.elements.status.textContent = state.running ? "Capturando" : "Parado";
  }

  function renderFields() {
    state.elements.fields.innerHTML = "";

    for (const field of FIELD_DEFS) {
      const config = state.config.fields[field.key];
      const value = readConfiguredField(field.key);
      const row = document.createElement("div");

      row.className = "clc-field";
      row.innerHTML = `
        <div class="clc-field-main">
          <div class="clc-field-label">
            <span>${escapeHtml(field.label)}</span>
          </div>
          <div class="clc-field-value">${escapeHtml(value.raw ?? "-")}</div>
          <div class="clc-field-selector">${escapeHtml(config.selector || "Nao mapeado")}</div>
          <div class="clc-actions">
            <select class="clc-select" data-field="${field.key}" data-prop="attribute">
              ${ATTRIBUTE_OPTIONS.map((option) => `<option value="${option}">${option}</option>`).join("")}
            </select>
            <select class="clc-select" data-field="${field.key}" data-prop="parser">
              ${PARSER_OPTIONS.map((option) => `<option value="${option}">${option}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="clc-actions" style="grid-template-columns: 1fr;">
          <button type="button" class="clc-field-button" data-role="pick" data-field="${field.key}">Selecionar</button>
          <button type="button" class="clc-field-button" data-role="clear-field" data-field="${field.key}">Limpar</button>
        </div>
      `;

      const attrSelect = row.querySelector(`[data-field="${field.key}"][data-prop="attribute"]`);
      const parserSelect = row.querySelector(`[data-field="${field.key}"][data-prop="parser"]`);
      if (attrSelect instanceof HTMLSelectElement) attrSelect.value = config.attribute;
      if (parserSelect instanceof HTMLSelectElement) parserSelect.value = config.parser;

      state.elements.fields.appendChild(row);
    }
  }

  function renderPreview() {
    const event = buildEvent("preview");
    state.elements.preview.textContent = JSON.stringify(event, null, 2);
  }

  function renderLogs() {
    state.elements.logs.textContent = state.logs.join("\n");
  }

  function togglePanel() {
    state.elements.panel.hidden = !state.elements.panel.hidden;
    if (!state.elements.panel.hidden) render();
  }

  function closePanel() {
    state.elements.panel.hidden = true;
  }

  function startPicker(fieldKey) {
    if (!state.config.fields[fieldKey]) return;

    state.pickerField = fieldKey;
    state.elements.pickerBanner.hidden = false;
    state.elements.pickerBanner.textContent = `Clique no campo da pagina para mapear: ${fieldKey}. Esc cancela.`;
    state.elements.panel.hidden = true;
    log(`Picker iniciado para ${fieldKey}.`);
  }

  function stopPicker() {
    state.pickerField = null;
    state.elements.pickerBanner.hidden = true;
    hideHighlight();
  }

  function bindPickerEvents() {
    document.addEventListener("mousemove", onPickerMouseMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerKeyDown, true);
  }

  function onPickerMouseMove(event) {
    if (!state.pickerField) return;

    const target = event.target;
    if (!(target instanceof Element) || isCollectorElement(target)) {
      hideHighlight();
      return;
    }

    showHighlight(target);
  }

  function onPickerClick(event) {
    if (!state.pickerField) return;

    const target = event.target;
    if (!(target instanceof Element) || isCollectorElement(target)) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const fieldKey = state.pickerField;
    const selector = getCssSelector(target);

    if (!selector) {
      log(`Nao foi possivel gerar seletor para ${fieldKey}.`);
      stopPicker();
      return;
    }

    state.config.fields[fieldKey].selector = selector;
    stopPicker();

    void saveConfig().then(() => {
      state.elements.panel.hidden = false;
      render();
      log(`Campo ${fieldKey} mapeado: ${selector}`);
    });
  }

  function onPickerKeyDown(event) {
    if (!state.pickerField || event.key !== "Escape") return;
    event.preventDefault();
    stopPicker();
    state.elements.panel.hidden = false;
    log("Picker cancelado.");
  }

  function isCollectorElement(element) {
    return Boolean(element.closest(".clc-root"));
  }

  function showHighlight(element) {
    const rect = element.getBoundingClientRect();
    const highlight = state.elements.highlight;

    highlight.hidden = false;
    highlight.style.left = `${Math.max(0, rect.left)}px`;
    highlight.style.top = `${Math.max(0, rect.top)}px`;
    highlight.style.width = `${Math.max(0, rect.width)}px`;
    highlight.style.height = `${Math.max(0, rect.height)}px`;
  }

  function hideHighlight() {
    state.elements.highlight.hidden = true;
  }

  function startCollection() {
    if (state.running) return;

    state.running = true;
    state.observer = new MutationObserver(() => collectNow("mutation"));
    state.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    state.intervalId = window.setInterval(() => collectNow("interval"), state.config.intervalMs);
    collectNow("start");
    renderStats();
    log("Coleta iniciada.");
  }

  function stopCollection() {
    if (state.observer) state.observer.disconnect();
    if (state.intervalId) window.clearInterval(state.intervalId);

    state.observer = null;
    state.intervalId = null;
    state.running = false;
    renderStats();
    log("Coleta parada.");
  }

  function collectNow(reason) {
    const event = buildEvent(reason);
    const signature = getEventSignature(event);

    if (!hasUsefulData(event)) {
      log("Snapshot ignorado: nenhum campo mapeado com valor.");
      return;
    }

    if (signature === state.lastSignature) return;

    state.lastSignature = signature;
    state.pendingEvents.push(event);
    state.stats.captured += 1;

    log(`Snapshot salvo #${state.stats.captured}: ${event.lot ?? event.code ?? event.description ?? "sem lote"}`);
    renderStats();
    renderFields();
    renderPreview();
    void flushEvents();
  }

  function buildEvent(reason) {
    const values = {};

    for (const field of FIELD_DEFS) {
      values[field.key] = readConfiguredField(field.key);
    }

    const bidRaw = getRaw(values.bidRaw);
    const fipeRaw = getRaw(values.fipeRaw);
    const message = getRaw(values.statusText);
    const bid = parseMoney(bidRaw);
    const fipe = parseMoney(fipeRaw);
    const saleStatus = inferSaleStatus(message);

    return {
      source: "copart-live",
      auctionId: getRaw(values.auctionId),
      lot: getRaw(values.lot),
      code: getRaw(values.code),
      description: getRaw(values.description),
      version: getRaw(values.version),
      yearModel: getRaw(values.yearModel),
      fipe,
      fipeRaw,
      damage: getRaw(values.damage),
      yard: getRaw(values.yard),
      bid,
      bidRaw,
      saleStatus,
      eventType: inferEventType({ bid, message, saleStatus, reason }),
      fipePercent: bid != null && fipe != null && fipe > 0 ? Math.round((bid / fipe) * 100) : null,
      imageUrl: absolutizeUrl(getRaw(values.imageUrl)),
      vehicleUrl: absolutizeUrl(getRaw(values.vehicleUrl)),
      message,
      observedAt: new Date().toISOString(),
    };
  }

  function readConfiguredField(fieldKey) {
    const config = state.config.fields[fieldKey];
    if (!config || !config.selector) return { raw: null, value: null };

    let element = null;

    try {
      element = document.querySelector(config.selector);
    }
    catch {
      return { raw: null, value: null };
    }

    if (!element) return { raw: null, value: null };

    const raw = readElementValue(element, config.attribute);

    return {
      raw,
      value: parseFieldValue(raw, config.parser),
    };
  }

  function readElementValue(element, attribute) {
    if (attribute === "textContent") return normalizeText(element.textContent);
    if (attribute === "currentSrc" && "currentSrc" in element) return normalizeText(element.currentSrc);
    if (attribute === "value" && "value" in element) return normalizeText(element.value);

    return normalizeText(element.getAttribute(attribute));
  }

  function parseFieldValue(raw, parser) {
    if (raw == null) return null;
    if (parser === "money") return parseMoney(raw);
    if (parser === "integer") return parseInteger(raw);
    if (parser === "url") return absolutizeUrl(raw);
    return raw;
  }

  function flushEvents() {
    if (state.pendingEvents.length === 0) return Promise.resolve();

    const events = state.pendingEvents.slice(0, 25);

    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "COPART_LIVE_SEND_EVENTS",
          apiUrl: state.config.apiUrl,
          apiToken: state.config.apiToken,
          events,
        },
        (response) => {
          if (chrome.runtime.lastError) {
            log(`Falha ao enviar: ${chrome.runtime.lastError.message}`);
            renderStats();
            resolve();
            return;
          }

          if (!response || !response.ok) {
            const message =
              response && typeof response.error === "string"
                ? response.error
                : "resposta invalida do background";

            log(`Falha ao enviar: ${message}`);
            renderStats();
            resolve();
            return;
          }

          state.pendingEvents.splice(0, events.length);
          state.stats.sent += events.length;
          log(`Enviado para API: ${events.length} evento(s).`);
          renderStats();
          resolve();
        },
      );
    });
  }

  function clearField(fieldKey) {
    if (!state.config.fields[fieldKey]) return;

    state.config.fields[fieldKey].selector = "";
    void saveConfig().then(() => {
      render();
      log(`Campo ${fieldKey} limpo.`);
    });
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(state.config, null, 2)], {
      type: "application/json",
    });
    const anchor = document.createElement("a");

    anchor.href = URL.createObjectURL(blob);
    anchor.download = `copart-live-contract-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(anchor.href);
    log("Contrato exportado.");
  }

  function getCssSelector(element) {
    if (!(element instanceof Element)) return "";

    if (element.id) {
      const selector = `#${CSS.escape(element.id)}`;
      if (isUniqueSelector(selector)) return selector;
    }

    const parts = [];
    let current = element;

    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      parts.unshift(getSelectorPart(current));

      const selector = parts.join(" > ");
      if (isUniqueSelector(selector)) return selector;

      current = current.parentElement;
    }

    return parts.join(" > ");
  }

  function getSelectorPart(element) {
    const stableAttrs = ["data-testid", "data-test", "data-cy", "aria-label", "name", "title"];
    const tagName = element.tagName.toLowerCase();

    for (const attr of stableAttrs) {
      const value = element.getAttribute(attr);
      if (value) return `${tagName}[${attr}="${cssString(value)}"]`;
    }

    const classes = Array.from(element.classList)
      .filter((name) => !name.includes(":"))
      .slice(0, 2);

    let selector = tagName;

    if (classes.length > 0) {
      selector += classes.map((name) => `.${CSS.escape(name)}`).join("");
    }

    const parent = element.parentElement;
    if (!parent) return selector;

    const siblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
    if (siblings.length > 1) selector += `:nth-of-type(${siblings.indexOf(element) + 1})`;

    return selector;
  }

  function isUniqueSelector(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    }
    catch {
      return false;
    }
  }

  function cssString(value) {
    return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function getEventSignature(event) {
    return JSON.stringify({
      auctionId: event.auctionId,
      lot: event.lot,
      code: event.code,
      description: event.description,
      bid: event.bid,
      bidRaw: event.bidRaw,
      saleStatus: event.saleStatus,
      message: event.message,
    });
  }

  function hasUsefulData(event) {
    return Boolean(
      event.auctionId ||
      event.lot ||
      event.code ||
      event.description ||
      event.bidRaw ||
      event.message,
    );
  }

  function inferEventType(input) {
    const text = normalizeForMatch(input.message ?? "");

    if (input.saleStatus === "sold" || input.saleStatus === "conditional") return "sale";
    if (text.includes("VENDIDO") || text.includes("CONDICIONAL")) return "sale";
    if (text.includes("FECHADO") || text.includes("ENCERRADO")) return "closed";
    if (input.bid != null || text.includes("LANCE")) return "bid";
    if (input.reason === "status") return "status";

    return "snapshot";
  }

  function inferSaleStatus(message) {
    const text = normalizeForMatch(message ?? "");

    if (text.includes("CONDICIONAL")) return "conditional";
    if (text.includes("VENDIDO") || text.includes("ARREMATADO")) return "sold";
    if (text.includes("ABERTO") || text.includes("LANCE")) return "open";

    return null;
  }

  function parseMoney(raw) {
    if (typeof raw !== "string") return null;

    const compact = raw.replace(/\s+/g, " ").trim();
    const match = compact.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/);
    if (!match) return null;

    const normalized = match[1].replace(/\./g, "").replace(",", ".");
    const value = Number.parseFloat(normalized);

    return Number.isFinite(value) ? Math.round(value) : null;
  }

  function parseInteger(raw) {
    if (typeof raw !== "string") return null;

    const value = Number.parseInt(raw.replace(/[^\d-]+/g, ""), 10);
    return Number.isFinite(value) ? value : null;
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

  function getRaw(value) {
    if (!isRecord(value)) return null;
    return typeof value.raw === "string" && value.raw.trim() ? value.raw.trim() : null;
  }

  function normalizeText(value) {
    if (typeof value !== "string") return null;

    const text = value.replace(/\s+/g, " ").trim();
    return text || null;
  }

  function normalizeForMatch(value) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function isRecord(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
  }

  function toPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function log(message) {
    const line = `[${new Date().toLocaleTimeString()}] ${message}`;
    state.logs.unshift(line);
    state.logs = state.logs.slice(0, MAX_LOGS);
    console.info("[copart-collector]", message);
    if (state.elements.logs) renderLogs();
  }
})();
