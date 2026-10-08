import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const feeEstimate = { mode: 'auction', fixedFees: 260, logistics: 500, total: 212635 }
const lot = (patch = {}) => ({
  source: 'sodre', auctionId: '29125', lot: '1026', code: '987654',
  brand: 'Mercedes-Benz', model: 'AMG C43', description: 'Mercedes-Benz AMG C43',
  yearModel: '2020', category: 'Automóveis', yard: 'Curitiba - PR', damage: null,
  bid: 197500, bidRaw: 'R$ 197.500,00', fipe: null, fipeRaw: null, saleStatus: 'open',
  vehicleUrl: 'https://leilao.sodresantoro.com.br/leilao/29125/lote/987654/', ...patch,
})

function collector() {
  const window = { addEventListener() {}, setTimeout() {}, clearTimeout() {} }
  const storage = new Map()
  const sent = []
  const context = vm.createContext({
    window, URL, location: { href: 'https://www.sodresantoro.com.br/app/telao/29125/' },
    console: { info() {}, warn() {} },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  })
  const injected = script.replace('  if (window.top !== window) {', `
    window.test = { state, getBidSimulationKey, getVehicleIdentityKey, getFeeEstimateSignature,
      getCurrentFeeEstimate, refreshFeeEstimate, getBidSimulationValues, saveCurrentLot,
      maybeSaveEvent, applyFipeOverride, prepareVehicleTransition, getWhatsappOptInKey,
      readLocalCaptureItems,
      setPreview(event) { state.preview = { textContent: JSON.stringify(event) }; },
      setReader(reader) { refreshPreview = reader; },
      setApi(api) { requestLocalApi = api; },
      setSender(sender) { sendIngestEvent = sender; },
    };
    renderSummary = () => {};
    scheduleAssistantRefresh = () => {};
    startPendingFinalWatcher = () => {};
    return;
    if (window.top !== window) {`)
  vm.runInContext(injected, context)
  const c = window.test
  c.state.authenticated = true
  c.state.settings = { autoSaveStates: ['PR'], allowedCategories: [], ignoredCategories: [], allowTrucks: true, allowMotorcycles: true, ignoreLargeDamage: false, requireDetectedState: true }
  c.setSender(async event => {
    sent.push(plain(event))
    return { ok: true, status: 200, body: { accepted: 1, picaretaSynced: true } }
  })
  c.setPreview(lot())
  c.setReader(async () => lot())
  return { ...c, storage, sent }
}

function editFipe(c, value = 336000) {
  c.state.fipeSimulationKey = c.getBidSimulationKey(lot())
  c.state.fipeSimulationFipe = value
  c.state.fipeSimulationDraft = String(value)
}

test('FIPE digitada recalcula margem e percentual sem FIPE original nem histórico', async () => {
  const c = collector()
  const event = lot()
  const signature = c.getFeeEstimateSignature(event)
  c.state.feeEstimateRequestId = 1
  c.setApi(async (path, options) => {
    assert.equal(path, '/api/vehicles/live-assistant')
    assert.equal(options.body.feesOnly, true)
    return { ok: true, body: { metrics: { feeEstimate } } }
  })
  await c.refreshFeeEstimate(event, signature, 1)
  const result = c.getBidSimulationValues(event.bid, null, null, c.getCurrentFeeEstimate(event), null, 336000)
  assert.equal(result.total, 212635)
  assert.equal(result.margin, 123365)
  assert.equal(result.totalFipePercent, 63)
  assert.equal(result.fipePercent, 59)
})

test('taxas do lote atual continuam disponíveis enquanto a consulta completa está carregando', async () => {
  const c = collector()
  const event = lot()
  c.state.assistantLoading = true
  c.state.assistant = null
  c.state.feeEstimateContext = { signature: c.getFeeEstimateSignature(event), estimate: feeEstimate }
  assert.equal(c.getCurrentFeeEstimate(event).total, 212635)
  assert.equal(c.getCurrentFeeEstimate(lot({ lot: '1027', code: '987655' })), null)
  assert.equal(c.getBidSimulationValues(null, null, 336000, feeEstimate, null).margin, null)
})

test('resposta de taxas atrasada não entra no novo lote', async () => {
  const c = collector()
  const event = lot()
  c.state.feeEstimateRequestId = 1
  let resolve
  c.setApi(() => new Promise(done => { resolve = done }))
  const pending = c.refreshFeeEstimate(event, c.getFeeEstimateSignature(event), 1)
  c.setPreview(lot({ lot: '1027', code: '987655' }))
  resolve({ ok: true, body: { metrics: { feeEstimate } } })
  await pending
  assert.equal(c.state.feeEstimateContext, null)
})

test('só digitar é simulação; salvar cadastra FIPE sem persistir lance simulado', async () => {
  const c = collector()
  editFipe(c)
  c.state.bidSimulationKey = c.getBidSimulationKey(lot())
  c.state.bidSimulationBid = 250000
  assert.equal(c.applyFipeOverride(lot()).fipe, null)
  await c.saveCurrentLot()
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].fipe, 336000)
  assert.match(c.sent[0].fipeRaw, /336\.000/)
  assert.equal(c.sent[0].bid, 197500)
  assert.equal(c.sent[0].shareFinalResult, false)
  assert.equal(c.state.fipeSimulationFipe, null)
  assert.equal(c.readLocalCaptureItems()[0].lastEvent.fipe, 336000)
})

test('resultado final leva a FIPE salva e respeita o opt-in do WhatsApp', async () => {
  const c = collector()
  editFipe(c)
  await c.saveCurrentLot()
  c.state.fipeOverrides.clear() // Reabre a página e restaura a edição confirmada da captura local.
  const final = lot({ saleStatus: 'sold', message: 'Vendido', observedAt: new Date().toISOString() })
  c.storage.set(c.getWhatsappOptInKey(final), '1')
  await c.maybeSaveEvent(final)
  assert.equal(c.sent.at(-1).fipe, 336000)
  assert.equal(c.sent.at(-1).shareFinalResult, true)
  assert.equal(c.applyFipeOverride(lot({ code: '123456', lot: '1027' })).fipe, null)
})

test('troca de veículo durante a leitura cancela o salvamento da FIPE', async () => {
  const c = collector()
  editFipe(c)
  c.setReader(async () => lot({ lot: '1027', code: '987655' }))
  await c.saveCurrentLot()
  assert.equal(c.sent.length, 0)
  assert.match(c.state.saveMessage, /O lote mudou/)
})

test('duplo clique não duplica ingestão e falha não confirma FIPE salva', async () => {
  const c = collector()
  editFipe(c)
  let resolve
  c.setReader(() => new Promise(done => { resolve = done }))
  const saving = c.saveCurrentLot()
  await c.saveCurrentLot()
  resolve(lot())
  await saving
  assert.equal(c.sent.length, 1)
  const failing = collector()
  editFipe(failing)
  failing.setSender(async () => ({ ok: false, status: 503, body: { message: 'Backend indisponível' } }))
  await failing.saveCurrentLot()
  assert.equal(failing.state.fipeSimulationFipe, 336000)
  assert.match(failing.state.saveMessage, /Backend indisponível/)
  assert.equal(failing.state.saveCurrentLoading, false)
})

test('modo financeiro usa a regra compartilhada e não aguarda consultas à base ou histórico', async () => {
  const require = createRequire(import.meta.url)
  const ts = require('typescript')
  function compile(path, globals = {}) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8')
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const context = vm.createContext({ exports: {}, ...globals })
    vm.runInContext(code, context)
    return context.exports
  }
  const fees = compile('../shared/utils/auction-fees.ts')
  let authorized = false
  const forbidden = () => { throw new Error('não deve consultar histórico, modelo ou capturas') }
  const modules = {
    '#shared/utils/auction-fees': fees,
    '#shared/utils/damage': { normalizeDamage: value => value },
    '../../utils/live-auction-extension-auth': { assertLiveAuctionExtensionAuthorized: async () => { authorized = true; return { kind: 'user' } } },
    '../../utils/vehicle-market-analysis': { loadMarketHistory: forbidden },
    '../../utils/schemas/vehicle': { VehicleModel: { find: forbidden } },
    '../../utils/sodre-live-identity': { normalizeSodreLiveIdentity: value => value },
    '#shared/utils/vehicle-retention': { getVehicleRetentionDate: () => new Date() },
    '../../utils/live-assistant-lot-identity': {},
    '../../utils/favorite-lot-result': { findFavoriteLot: forbidden },
    '../../utils/live-auction-capture': { recordLiveAuctionCapture: forbidden },
    '../../utils/live-assistant-fipe-reference': {},
  }
  const route = compile('../layers/cars/server/api/vehicles/live-assistant.post.ts', {
    require: id => { assert.ok(id in modules, id); return modules[id] },
    defineEventHandler: handler => handler, useDb() {},
    readBody: async () => ({ ...lot(), feesOnly: true }),
  })
  const response = await route.default({})
  assert.equal(authorized, true)
  assert.equal(response.metrics.feeEstimate.total, 212635)
})
