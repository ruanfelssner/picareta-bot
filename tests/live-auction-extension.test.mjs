import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8');
const stylesheet = readFileSync(new URL('../.extension/copart-live-collector/content.css', import.meta.url), 'utf8');
const backgroundScript = readFileSync(new URL('../.extension/copart-live-collector/background.js', import.meta.url), 'utf8');
const connectionBridgeScript = readFileSync(new URL('../.extension/copart-live-collector/connection-bridge.js', import.meta.url), 'utf8');
const ingestRoute = readFileSync(new URL('../layers/cars/server/api/vehicles/ingest.post.ts', import.meta.url), 'utf8');
const auditIngestRoute = readFileSync(new URL('../layers/cars/server/api/vehicles/live-events/batch.post.ts', import.meta.url), 'utf8');
const storageKey = 'liveAuctionCollector:copart:capturedLots:v1';
const plain = value => JSON.parse(JSON.stringify(value));

function collector({ storage = new Map(), quota = Infinity, AudioContext } = {}) {
  const sent = [];
  const listeners = new Map();
  const window = { addEventListener: (type, listener) => listeners.set(type, listener) };
  const context = vm.createContext({
    window, URL, AudioContext, location: { href: 'https://www.copart.com.br/auctionDashboard?auctionId=10412' },
    console: { info() {}, warn() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        if (value.length > quota) throw new Error('QuotaExceededError');
        storage.set(key, value);
      },
    },
  });
  // Expose the actual collector functions before UI startup; no DOM or backend required.
  const injected = script.replace('  if (window.top !== window) {', `
    window.test = { state, encodeLocalCaptureItems, decodeLocalCaptureItems,
      captureLocalLot, readLocalCaptureItems, writeLocalCaptureItems, getSaveDecision,
      maybeSaveEvent, reconcilePendingChatResults, installFrameBridge, parseFrameMessage,
      stabilizeCopartLiveEvent, isAllowedCategory, registerFavoriteLot, getFavoriteLot,
      getMarketComparison, getBidSimulationValues, parseBidSimulationValue, parseFipeSimulationValue,
      getVehicleIdentityKey, prepareVehicleTransition, setFipeOverride, applyFipeOverride,
      getAuctionSessionKey, buildChatAuditEvent,
      buildFinalCaptureAuditEvent,
      unlockAudioFromUserGesture, playFavoriteSound,
      setMessages(messages) { getSystemMessages = () => messages; },
      setSender(sender) { sendIngestEvent = sender; },
      setPreview(event) { buildPreviewEvent = () => event; },
    };
    return;
    if (window.top !== window) {`);
  vm.runInContext(injected, context);
  const api = window.test;
  api.state.settings = { autoSaveStates: ['PR'], allowedCategories: [], ignoredCategories: [], allowTrucks: true, allowMotorcycles: true, requireDetectedState: true };
  api.setSender(async event => {
    sent.push(plain(event));
    return { ok: true, status: 200, body: { accepted: 1 } };
  });
  return { ...api, storage, sent, listeners, setQuota(value) { quota = value; } };
}

function lot(n, extra = {}) {
  return { source: 'copart', auctionId: '10412', lot: String(n), code: String(1131000 + n),
    brand: 'FOTON', model: 'Tunland', description: '2026 FOTON Tunland', category: 'Picapes Grandes',
    yard: 'Curitiba - PR', saleStatus: 'open', bid: 79200, bidRaw: 'R$ 79.200,00',
    vehicleUrl: `https://www.copart.com.br/lot/${1131000 + n}`, ...extra };
}

test('compacta sem perder campos, diferenças, nulos ou histórico legado', () => {
  const c = collector();
  const event = lot(3, { description: 'Detalhes do veículo '.repeat(60) });
  const items = [{ ...event, _id: 'local:3', bid: 100, lastEvent: { ...event, message: null, extra: { a: 1 } } }, { _id: 'legacy' }];
  assert.deepEqual(plain(c.decodeLocalCaptureItems(JSON.stringify(items))), items);
  const compact = c.encodeLocalCaptureItems(items);
  assert.ok(compact.length < JSON.stringify(items).length * 0.8);
  assert.deepEqual(plain(c.decodeLocalCaptureItems(compact)), items);
});

test('histórico cheio continua do lote 3 ao 9 sem excluir capturas antigas', async () => {
  const old = Array.from({ length: 1390 }, (_, n) => {
    const event = lot(n + 100, { description: 'Detalhes do veículo '.repeat(15) });
    return { ...event, identityKey: `copart:code:${event.code}`, lastEvent: event };
  });
  const raw = JSON.stringify(old);
  const storage = new Map([[storageKey, raw]]);
  const c = collector({ storage, quota: raw.length + 1 });
  for (let n = 3; n <= 9; n++) await c.maybeSaveEvent(lot(n));
  const reloaded = collector({ storage });
  assert.equal(reloaded.readLocalCaptureItems().length, 1397);
  for (let n = 3; n <= 9; n++) assert.ok(reloaded.readLocalCaptureItems().some(item => item.code === lot(n).code));
  assert.equal(c.sent.length, 0, 'lances abertos ficam locais');
  assert.equal(c.state.localCaptureError, null);
});

test('falha de escrita conserva lotes na aba e repete a gravação idêntica', async () => {
  const c = collector({ quota: 0 });
  await c.maybeSaveEvent(lot(4));
  assert.equal(c.readLocalCaptureItems().length, 1);
  assert.match(c.state.localCaptureError, /só nesta aba/);
  assert.equal(c.state.observedSignatures.size, 0);
  c.setQuota(Infinity);
  await c.maybeSaveEvent(lot(4));
  assert.equal(c.state.localCaptureError, null);
  assert.equal(collector({ storage: c.storage }).readLocalCaptureItems().length, 1);
});

test('não sobrescreve armazenamento ilegível com histórico vazio', async () => {
  const storage = new Map([[storageKey, '{invalid']]);
  const c = collector({ storage });
  await c.maybeSaveEvent(lot(4));
  assert.equal(storage.get(storageKey), '{invalid');
  assert.equal(c.readLocalCaptureItems().length, 1);
  assert.ok(c.state.localCaptureError);
});

test('reconcilia resultados anteriores pelo lote e mantém último lance e valor final', async () => {
  const c = collector();
  for (let n = 3; n <= 9; n++) await c.maybeSaveEvent(lot(n));
  c.setMessages([
    'Sistema: Lote 3 não foi vendido',
    'Sistema: Lote 4 vendido por R$ 81.000,00',
    'Sistema: Venda condicional para o lote 5 por R$ 82.000,00',
  ]);
  await c.reconcilePendingChatResults(lot(9));
  assert.deepEqual(c.sent.map(({ lot, saleStatus, bid }) => ({ lot, saleStatus, bid })), [
    { lot: '3', saleStatus: 'not_sold', bid: 79200 },
    { lot: '4', saleStatus: 'sold', bid: 81000 },
    { lot: '5', saleStatus: 'conditional', bid: 82000 },
  ]);
  await c.reconcilePendingChatResults(lot(9));
  assert.equal(c.sent.length, 3, 'resultado não é reenviado sem mudança');
  const saved = collector({ storage: c.storage }).readLocalCaptureItems();
  assert.equal(saved.filter(item => item.saveStatus === 'saved').length, 3);
});

test('quarentena não transfere lance e resultado do lote anterior', () => {
  const c = collector();
  const event = lot(4, { saleStatus: 'sold', message: 'Vendido', fipe: 158991, fipeRaw: 'R$ 158.991,00' });
  const first = c.stabilizeCopartLiveEvent(event);
  assert.equal(first.saleStatus, 'open');
  assert.equal(first.bid, null);
  assert.equal(first.fipe, null);
  const confirmed = c.stabilizeCopartLiveEvent(event);
  assert.equal(confirmed.bid, 79200);
  assert.equal(confirmed.fipe, 158991);
});

test('troca de veículo limpa assistente e simulações financeiras anteriores', () => {
  const c = collector();
  assert.equal(c.prepareVehicleTransition(lot(4)), false);
  c.state.assistant = { vehicle: { fipe: 158991 } };
  c.state.assistantSignature = 'anterior';
  c.state.assistantPendingSignature = 'anterior';
  c.state.bidSimulationKey = c.getVehicleIdentityKey(lot(4));
  c.state.bidSimulationBid = 80000;
  c.state.fipeSimulationKey = c.getVehicleIdentityKey(lot(4));
  c.state.fipeSimulationFipe = 160000;

  assert.equal(c.prepareVehicleTransition(lot(5)), true);
  assert.equal(c.state.assistant, null);
  assert.equal(c.state.assistantSignature, '');
  assert.equal(c.state.assistantPendingSignature, '');
  assert.equal(c.state.bidSimulationBid, null);
  assert.equal(c.state.fipeSimulationFipe, null);
});

test('FIPE auxiliar não passa para outro veículo com a mesma identidade temporária', () => {
  const c = collector();
  const previous = lot(4, { fipe: null, fipeRaw: null });
  c.setFipeOverride(previous, 158991, 'R$ 158.991,00');
  assert.equal(c.applyFipeOverride(previous).fipe, 158991);

  const next = { ...previous, brand: 'FORD', model: 'Ranger', description: '2026 FORD Ranger' };
  assert.equal(c.applyFipeOverride(next).fipe, null);
});

test('aceita SUV Grandes e Utilitários Grandes mesmo com lista personalizada', () => {
  const c = collector();
  c.state.settings.allowedCategories = ['Automóveis'];
  assert.equal(c.isAllowedCategory('SUV Grandes'), true);
  assert.equal(c.isAllowedCategory('Utilitários Grandes'), true);
  assert.equal(c.isAllowedCategory('Máquinas'), false);
  c.state.settings.ignoredCategories = ['UTILITARIOS GRANDES'];
  assert.equal(c.isAllowedCategory('Utilitários Grandes'), false, 'bloqueio explícito do operador continua valendo');
});

test('backend permite as duas categorias recebidas da extensão', () => {
  assert.match(ingestRoute, /'SUV GRANDES'/);
  assert.match(ingestRoute, /'UTILITARIOS GRANDES'/);
});

test('análise ao vivo compara lance sem taxas com a venda histórica', () => {
  const c = collector();
  const marketAnalysis = { averagePct: 49.8, maxTotal: 79101 };
  const baseFeeEstimate = {
    mode: 'auction', fixedFees: 260, logistics: 800,
    basePrice: 76400, commission: 3820, dsal: 4500, feesTotal: 9380, total: 85780,
  };
  const comparison = plain(c.getMarketComparison(76400, 85780, 158991, marketAnalysis, baseFeeEstimate));
  assert.deepEqual(comparison, {
    historicalSaleValue: 79178,
    historicalTotalValue: 88697,
    status: 'within',
    statusLabel: 'Lance atual abaixo da média histórica',
    bidDifference: 2778,
    totalDifference: -2917,
  });
  assert.equal(c.getMarketComparison(79179, 88698, 158991, marketAnalysis, baseFeeEstimate).status, 'above');

  const screenshotComparison = c.getMarketComparison(76900, 86305, 158991, marketAnalysis, baseFeeEstimate);
  assert.equal(screenshotComparison.historicalTotalValue, 88697);
  assert.equal(screenshotComparison.totalDifference, -2392);
});

test('texto da análise não usa altura fixa nem corte de linhas', () => {
  const slotRule = stylesheet.match(/\.clp-ai-slot\s*\{([^}]*)\}/)?.[1] ?? '';
  const metaRule = stylesheet.match(/\.clp-ai-meta\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(slotRule, /(?:^|;)\s*height:\s*86px/);
  assert.doesNotMatch(metaRule, /line-clamp/);
  assert.match(metaRule, /overflow-wrap:\s*anywhere/);
});

test('análise organiza média e valor com taxas na mesma grade compacta', () => {
  assert.match(script, /<h4>Média<\/h4>/);
  assert.doesNotMatch(script, /<h4>C\/ taxas<\/h4>/);
  assert.match(script, /class="clp-ai-grid"/);
  assert.match(script, /<span>Condicional<\/span>/);
  assert.match(script, /<p>c\/ taxas:/);
  assert.match(script, /<span>Chassi<\/span>|<b>Chassi<\/b>/);
  assert.match(script, /Média R\$/);
  const gridRule = stylesheet.match(/\.clp-ai-grid\s*\{([^}]*)\}/)?.[1] ?? '';
  const headingRule = stylesheet.match(/\.clp-ai-grid\s*>\s*h4\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(gridRule, /grid-template-columns:\s*minmax\(58px,\s*0\.68fr\)\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(headingRule, /justify-content:\s*center/);
});

test('indicadores omitem instrução repetitiva e análise conserva a descrição da amostra', () => {
  assert.doesNotMatch(script, /Clique e digite para simular/);
  assert.match(script, /marketAnalysis\.basisLabel/);
  assert.match(script, /clp-ai-sample/);
});

test('indicadores compactos deixam explícita a margem após taxas sem repetir as taxas', () => {
  assert.match(script, /margin: fipe != null && total != null \? fipe - total : null/);
  assert.match(script, /class="clp-margin-value"/);
  assert.match(script, /<small>c\/ taxas<\/small>/);
  assert.match(script, /class="clp-percent-value"/);
  assert.match(script, /<small>total<\/small>/);
  assert.match(script, /<span>Valor total<\/span>/);
  assert.doesNotMatch(script, /taxas \+ \$\{escapeHtml/);
  assert.doesNotMatch(script, /const totalMetricMeta/);
  const metricsRule = stylesheet.match(/\.clp-metrics\s*>\s*div\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(metricsRule, /gap:\s*2px/);
  assert.match(metricsRule, /min-height:\s*74px/);
  assert.match(metricsRule, /grid-template-rows:\s*11px 28px 18px auto/);
  for (const selector of ['.clp-bid-editor', '.clp-margin-value', '.clp-percent-value']) {
    const rule = stylesheet.match(new RegExp(`${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    assert.match(rule, /height:\s*28px/);
    assert.match(rule, /align-items:\s*flex-end/);
  }
});

test('FIPE de referência usa ícone informativo sem criar uma quarta linha', () => {
  assert.match(script, /class="clp-fipe-info"/);
  assert.match(script, /FIPE obtida da base a partir de/);
  assert.match(script, /Correspondência não exata/);
  assert.doesNotMatch(script, /<small>Base: /);
  assert.match(stylesheet, /\.clp-fipe-editor\s*>\s*\.clp-fipe-info/);
});

test('comitente e pátio ocupam uma linha e continuam copiáveis', () => {
  assert.match(script, /data-copy-label="Comitente"/);
  assert.match(script, /data-copy-label="Pátio"/);
  assert.match(script, /navigator\.clipboard\.writeText\(value\)/);
  const copyRule = stylesheet.match(/\.clp-detail-copy\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(copyRule, /text-overflow:\s*ellipsis/);
  assert.match(copyRule, /white-space:\s*nowrap/);
  assert.match(copyRule, /overflow:\s*hidden/);
});

test('áudio só é criado após gesto confiável do usuário', async () => {
  let instances = 0;
  class FakeAudioContext {
    constructor() {
      instances += 1;
      this.state = 'suspended';
      this.currentTime = 0;
      this.destination = {};
    }
    async resume() { this.state = 'running'; }
    createOscillator() {
      return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
    }
    createGain() {
      return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} };
    }
  }

  const c = collector({ AudioContext: FakeAudioContext });
  c.playFavoriteSound();
  assert.equal(instances, 0, 'fluxo automático não pode criar AudioContext');
  assert.equal(c.state.pendingFavoriteSound, true);
  assert.equal(await c.unlockAudioFromUserGesture({ isTrusted: false }), false);
  assert.equal(instances, 0, 'evento sintético não pode liberar áudio');
  assert.equal(await c.unlockAudioFromUserGesture({ isTrusted: true }), true);
  assert.equal(instances, 1);
  assert.equal(c.state.pendingFavoriteSound, false);
});

test('simulação de lance recalcula taxas, FIPE e histórico sem alterar o lance real', () => {
  const c = collector();
  const baseFeeEstimate = {
    mode: 'auction', fixedFees: 260, logistics: 800,
    basePrice: 76400, commission: 3820, dsal: 4500, feesTotal: 9380, total: 85780,
  };
  const simulation = plain(c.getBidSimulationValues(
    76400,
    80000,
    158991,
    baseFeeEstimate,
    { averagePct: 49.8, maxTotal: 79101 },
  ));

  assert.equal(simulation.bid, 80000);
  assert.equal(simulation.isSimulated, true);
  assert.equal(simulation.feeEstimate.commission, 4000);
  assert.equal(simulation.feeEstimate.dsal, 4500);
  assert.equal(simulation.feeEstimate.feesTotal, 9560);
  assert.equal(simulation.total, 89560);
  assert.equal(simulation.margin, 69431);
  assert.equal(simulation.fipePercent, 50);
  assert.equal(simulation.totalFipePercent, 56);
  assert.equal(simulation.marketComparison.status, 'above');
  assert.equal(simulation.marketComparison.bidDifference, -822);
  assert.equal(simulation.marketComparison.historicalTotalValue, 88697);
  assert.equal(simulation.marketComparison.totalDifference, 863);
});

test('entrada da simulação aceita valor simples e moeda brasileira', () => {
  const c = collector();
  assert.equal(c.parseBidSimulationValue('80000'), 80000);
  assert.equal(c.parseBidSimulationValue('R$ 80.000,00'), 80000);
  assert.equal(c.parseBidSimulationValue(''), null);
});

test('simulação de FIPE recalcula margem, percentuais e referência histórica', () => {
  const c = collector();
  const baseFeeEstimate = {
    mode: 'auction', fixedFees: 260, logistics: 800,
    basePrice: 76400, commission: 3820, dsal: 4500, feesTotal: 9380, total: 85780,
  };
  const simulation = plain(c.getBidSimulationValues(
    76400,
    null,
    158991,
    baseFeeEstimate,
    { averagePct: 49.8, maxTotal: 79101 },
    160000,
  ));

  assert.equal(simulation.fipe, 160000);
  assert.equal(simulation.isFipeSimulated, true);
  assert.equal(simulation.margin, 74220);
  assert.equal(simulation.fipePercent, 48);
  assert.equal(simulation.totalFipePercent, 54);
  assert.equal(simulation.marketComparison.historicalSaleValue, 79680);
  assert.equal(simulation.marketComparison.status, 'within');
});

test('entrada da FIPE simulada aceita moeda brasileira', () => {
  const c = collector();
  assert.equal(c.parseFipeSimulationValue('R$ 160.000,00'), 160000);
  assert.equal(c.parseFipeSimulationValue(''), null);
});

test('painel destaca percentual total e move status para a barra de ações', () => {
  const percentRule = stylesheet.match(/\.clp-total-percent-metric strong\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(percentRule, /font-size:\s*22px/);
  assert.match(script, /data-role="action-status"/);
  assert.match(script, /data-role="fipe-simulator"/);
  assert.match(stylesheet, /\.clp-fipe-editor/);
  assert.doesNotMatch(script, /\$\{collectorNote\}/);
});

test('ponte aceita JSON textual, objetos antigos e descarta mensagens inválidas', () => {
  const c = collector();
  const message = { type: 'LIVE_AUCTION_PREVIEW_REQUEST', requestId: '123' };
  assert.deepEqual(plain(c.parseFrameMessage(JSON.stringify(message))), message);
  assert.deepEqual(c.parseFrameMessage(message), message);
  assert.equal(c.parseFrameMessage('[object Object]'), null);
});


test('resposta do iframe usa JSON textual para os listeners da Copart', () => {
  const c = collector();
  c.setPreview(lot(9));
  c.installFrameBridge();
  let response;
  c.listeners.get('message')({
    data: JSON.stringify({ type: 'LIVE_AUCTION_PREVIEW_REQUEST', requestId: '123' }),
    source: { postMessage(value) { response = value; } },
  });
  assert.equal(typeof response, 'string');
  assert.equal(JSON.parse(response).event.lot, '9');
  assert.equal(JSON.parse(response).requestId, '123');
});

test('releitura do mesmo resultado mantém diagnóstico salvo sem novo envio', async () => {
  const c = collector();
  const event = lot(4, { saleStatus: 'sold' });
  await c.maybeSaveEvent(event);
  await c.maybeSaveEvent(event);
  assert.equal(c.sent.length, 1);
  assert.equal(c.readLocalCaptureItems()[0].saveStatus, 'saved');
});

test('lote favorito ignora filtros fracos e salva como favorito no resultado final', () => {
  const c = collector();
  const outOfState = lot(21, { yard: 'Itaquaquecetuba - SP', saleStatus: 'sold' });
  assert.equal(c.getSaveDecision(outOfState).shouldSave, false);

  c.registerFavoriteLot(outOfState, { isFavorite: true, count: 2, opportunityId: 'abc' });
  assert.equal(c.getFavoriteLot(outOfState).count, 2);
  const decision = c.getSaveDecision(outOfState);
  assert.equal(decision.shouldSave, true);
  assert.equal(decision.mode, 'favorite');
  assert.equal(decision.manualDecision, 'save');
  assert.equal(c.getSaveDecision({ ...outOfState, saleStatus: 'open' }).reason, 'Aguardando resultado final');

  c.registerFavoriteLot(outOfState, { isFavorite: false });
  assert.equal(c.getFavoriteLot(outOfState), null);
  assert.equal(ingestRoute.includes("value['decisionMode'] === 'favorite'"), true);
});

test('favorito usa somente tag e borda sem banner redundante', () => {
  assert.match(script, /clp-favorite-tag/);
  assert.match(stylesheet, /\.clp-summary\[data-favorite="true"\]/);
  assert.doesNotMatch(script, /clp-favorite-banner/);
  assert.doesNotMatch(script, /O resultado final será enviado ao WhatsApp/);
  assert.doesNotMatch(stylesheet, /\.clp-favorite-banner/);
});

test('auditoria grava mensagens em IndexedDB antes do sync e preserva não classificadas', () => {
  assert.match(backgroundScript, /indexedDB\.open\(LIVE_AUCTION_EVENT_DB/);
  assert.match(backgroundScript, /LIVE_AUCTION_LOG_EVENTS/);
  assert.match(backgroundScript, /await idbRequest\(db\.transaction\(LIVE_AUCTION_EVENT_STORE, "readwrite"\)/);
  assert.match(script, /message_unclassified/);
  assert.match(script, /MutationObserver/);
  assert.match(auditIngestRoute, /persistLiveAuctionEventBatch/);
});

test('painel oferece log, sync e WhatsApp opt-in desativado por sessão', () => {
  assert.match(script, /Log do leilão/);
  assert.match(script, /LIVE_AUCTION_LOG_SYNC/);
  assert.match(script, /Exportar mensagens em JSON/);
  assert.match(script, /shareFinalResult/);
  assert.match(script, /readStoredBoolean\(getStorageKey\(`whatsapp:/);
  assert.match(script, /clp-vehicle-actions/);
  assert.match(script, /<span>WhatsApp<\/span>/);
  assert.doesNotMatch(script, /Enviar resultado no WhatsApp<\/strong>/);
  assert.doesNotMatch(script, /Somente ao confirmar vendido/);
  assert.doesNotMatch(script, /Favorito · salvará e enviará ao WhatsApp/);
  assert.match(stylesheet, /\.clp-whatsapp-optin/);
  assert.match(stylesheet, /\.clp-audit-panel/);
});

test('snapshot leva sessão oficial e chassi para a ingestão final', () => {
  assert.match(script, /auctionSessionKey/);
  assert.match(script, /chassisRaw/);
  assert.match(script, /chassisNormalized/);
  assert.match(ingestRoute, /normalizeChassis/);
});

test('encerramento do leilão fecha a sessão sem inventar venda do lote atual', () => {
  const c = collector();
  const event = c.buildChatAuditEvent({
    snapshot: lot(53),
    sessionKey: 'copart:10412',
    source: 'copart',
    auctionId: '10412',
    rawText: 'Leilão finalizado',
    dedupeKey: 'id:fim',
    sequence: 10,
  });
  assert.equal(event.kind, 'session_finished');
});

test('mensagem histórica não herda o código do lote atual', () => {
  const c = collector();
  const historical = c.buildChatAuditEvent({
    snapshot: lot(62),
    sessionKey: 'copart:10412',
    source: 'copart',
    auctionId: '10412',
    rawText: 'Lote 61 vendido por R$ 26.500,00',
    dedupeKey: 'id:lote-61',
    sequence: 10,
  });
  assert.equal(historical.lot, '61');
  assert.equal(historical.code, null);

  const current = c.buildChatAuditEvent({
    snapshot: lot(62),
    sessionKey: 'copart:10412',
    source: 'copart',
    auctionId: '10412',
    rawText: 'Lote 62 vendido por R$ 8.100,00',
    dedupeKey: 'id:lote-62',
    sequence: 11,
  });
  assert.equal(current.code, lot(62).code);
});

test('sessão sem número oficial recebe chave de fallback estável', () => {
  const c = collector();
  const first = c.getAuctionSessionKey({ source: 'copart', auctionId: null });
  const second = c.getAuctionSessionKey({ source: 'copart', auctionId: null });
  assert.equal(first, second);
  assert.match(first, /^copart:live:\d{4}-\d{2}-\d{2}:/);
});

test('normaliza o identificador oficial da sessão sem diferenciar maiúsculas', () => {
  const c = collector();
  assert.equal(c.getAuctionSessionKey({ source: 'vipleiloes', auctionId: '300926BSPI' }), 'vipleiloes:300926bspi');
});

test('publica o snapshot local e permite leitura pela ponte da auditoria', () => {
  assert.match(script, /LIVE_AUCTION_LOCAL_SNAPSHOT_PUBLISH/);
  assert.match(backgroundScript, /publishLiveAuctionLocalSnapshots/);
  assert.match(backgroundScript, /PICARETA_LIVE_AUCTION_LOCAL_STATE/);
  assert.match(backgroundScript, /chrome\.storage\.local/);
  assert.match(backgroundScript, /publisherKey/);
  assert.match(connectionBridgeScript, /PICARETA_LIVE_AUCTION_LOCAL_STATE/);
});

test('resultado final também atualiza a observação usada pela auditoria', () => {
  assert.match(ingestRoute, /recordLiveAuctionCapture\(rawItem, actor\)/);
});

test('resultado final gera evento de auditoria idempotente mesmo sem mensagem do chat', () => {
  const c = collector();
  const event = lot(124, {
    saleStatus: 'conditional',
    bid: 3_500,
    bidRaw: 'R$ 3.500,00',
    observedAt: '2026-09-30T14:25:47.000Z',
  });
  const audit = plain(c.buildFinalCaptureAuditEvent(event));
  const repeated = plain(c.buildFinalCaptureAuditEvent(event));

  assert.equal(audit.kind, 'lot_conditional');
  assert.equal(audit.amount, 3_500);
  assert.equal(audit.lot, '124');
  assert.match(audit.rawText, /Resultado confirmado pela captura da extensão/);
  assert.equal(audit.eventId, repeated.eventId);
  assert.equal(c.buildFinalCaptureAuditEvent({ ...event, saleStatus: 'open' }), null);
  assert.match(script, /backfillFinalCaptureAuditEvents\(state\.ignoredItems\)/);
});
