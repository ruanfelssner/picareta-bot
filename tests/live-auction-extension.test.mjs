import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8');
const stylesheet = readFileSync(new URL('../.extension/copart-live-collector/content.css', import.meta.url), 'utf8');
const ingestRoute = readFileSync(new URL('../layers/cars/server/api/vehicles/ingest.post.ts', import.meta.url), 'utf8');
const storageKey = 'liveAuctionCollector:copart:capturedLots:v1';
const plain = value => JSON.parse(JSON.stringify(value));

function collector({ storage = new Map(), quota = Infinity } = {}) {
  const sent = [];
  const listeners = new Map();
  const window = { addEventListener: (type, listener) => listeners.set(type, listener) };
  const context = vm.createContext({
    window, URL, location: { href: 'https://www.copart.com.br/auctionDashboard?auctionId=10412' },
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
      stabilizeCopartLiveEvent, isAllowedCategory,
      getMarketComparison, getBidSimulationValues, parseBidSimulationValue,
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
  const event = lot(4, { saleStatus: 'sold', message: 'Vendido' });
  const first = c.stabilizeCopartLiveEvent(event);
  assert.equal(first.saleStatus, 'open');
  assert.equal(first.bid, null);
  assert.equal(c.stabilizeCopartLiveEvent(event).bid, 79200);
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
  const comparison = plain(c.getMarketComparison(76400, 85780, 158991, marketAnalysis));
  assert.deepEqual(comparison, {
    historicalSaleValue: 79178,
    status: 'within',
    statusLabel: 'Lance atual abaixo da média histórica',
    bidDifference: 2778,
    totalDifference: 6602,
  });
  assert.equal(c.getMarketComparison(79179, 88650, 158991, marketAnalysis).status, 'above');
});

test('texto da análise não usa altura fixa nem corte de linhas', () => {
  const slotRule = stylesheet.match(/\.clp-ai-slot\s*\{([^}]*)\}/)?.[1] ?? '';
  const metaRule = stylesheet.match(/\.clp-ai-meta\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(slotRule, /(?:^|;)\s*height:\s*86px/);
  assert.doesNotMatch(metaRule, /line-clamp/);
  assert.match(metaRule, /overflow-wrap:\s*anywhere/);
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
  assert.equal(simulation.fipePercent, 50);
  assert.equal(simulation.totalFipePercent, 56);
  assert.equal(simulation.marketComparison.status, 'above');
  assert.equal(simulation.marketComparison.bidDifference, -822);
});

test('entrada da simulação aceita valor simples e moeda brasileira', () => {
  const c = collector();
  assert.equal(c.parseBidSimulationValue('80000'), 80000);
  assert.equal(c.parseBidSimulationValue('R$ 80.000,00'), 80000);
  assert.equal(c.parseBidSimulationValue(''), null);
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
