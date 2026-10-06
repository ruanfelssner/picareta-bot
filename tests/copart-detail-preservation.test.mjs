import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const content = read('../.extension/copart-live-collector/content.js')
const background = read('../.extension/copart-live-collector/background.js')
const plain = value => JSON.parse(JSON.stringify(value))
const loadTsModule = (path, require = () => { throw new Error('require inesperado') }) => {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(read(path), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports: module.exports, module, require })
  return module.exports
}
const damageModule = loadTsModule('../shared/utils/damage.ts')
const { buildLiveAuctionCaptureFields } = loadTsModule('../layers/cars/server/utils/live-auction-capture-fields.ts', (id) => {
  if (id === '#shared/utils/damage') return damageModule
  throw new Error(`Módulo não previsto no teste: ${id}`)
})

function reader() {
  const timers = []
  const window = { setTimeout(callback, delay) { timers.push(delay); return timers.length }, clearTimeout() {} }
  const context = vm.createContext({ window, URL, location: { href: 'https://www.copart.com.br/lot/1157950' } })
  vm.runInContext(content.replace('  if (window.top !== window) {', `
    window.test = { extractDetailRows, extractDetailFromText, extractCurrentVehicleDetail, parseMoney, scheduleCopartDetailSettling, state,
      setTables(tables) { getElements = selectors => selectors.includes("table") ? tables : []; getVehicleDetailMarkup = () => ""; getSearchText = () => ""; htmlToText = value => value; },
      setRoots() { getReadableRoots = root => [root]; } };
    return;
    if (window.top !== window) {`), context)
  window.test.setRoots()
  return { ...window.test, timers }
}

function snapshotPublisher() {
  const storage = {}
  const noOp = () => {}
  const context = vm.createContext({ URL, chrome: {
    action: { onClicked: { addListener: noOp } },
    runtime: { onStartup: { addListener: noOp }, onInstalled: { addListener: noOp }, onMessage: { addListener: noOp } },
    alarms: { onAlarm: { addListener: noOp }, create: noOp, clear: async () => true },
    tabs: { onUpdated: { addListener: noOp }, onRemoved: { addListener: noOp }, get: async () => { throw new Error('Sem abas no teste') } },
    storage: {
      local: {
        async get(key) { return { [key]: plain(storage[key] ?? {}) } },
        async set(values) { Object.assign(storage, plain(values)) },
      },
      // O worker de condicionais roda em segundo plano; sem sessão ativa ele não faz nada.
      session: { async get() { return {} }, async set() {} },
    },
  } })
  vm.runInContext(background.replace('void ensureConditionalWorker();\n\nchrome.runtime.onMessage', 'chrome.runtime.onMessage'), context)
  return (message, sender = { url: 'https://www.copart.com.br/lot/1157950' }) => context.publishLiveAuctionLocalSnapshots(message, sender)
    .then(() => plain(storage['liveAuctionLocalSnapshots:v2']))
}

const captured = {
  source: 'copart', auctionId: '10477', lot: '38', code: '1157950',
  brand: 'Renault', model: 'Clio', description: 'Renault Clio', fipe: 29343,
  saleStatus: 'sold', bid: 8650, message: 'Sistema: Lote 38 vendido por R$ 8.650',
}

test('leitura parcial não apaga identificação, FIPE ou sessão já capturadas', () => {
  const fields = buildLiveAuctionCaptureFields({ ...captured, auctionId: null, lot: null, brand: '', model: null, fipe: null })
  for (const key of ['auctionId', 'lot', 'brand', 'model', 'lastEvent.fipe']) assert.equal(Object.hasOwn(fields, key), false)
  assert.equal(fields['lastEvent.bid'], 8650)
})

test('detalhes enriquecem FIPE sem trocar sessão ou resultado vendido de R$ 8.650', () => {
  const fields = buildLiveAuctionCaptureFields({ ...captured, captureContext: 'vehicle_detail', auctionId: '999', lot: '1', fipe: 30000, saleStatus: 'open', bid: 100, message: 'Dar lance' })
  assert.equal(fields['lastEvent.fipe'], 30000)
  for (const key of ['auctionId', 'lot', 'lastEvent.auctionId', 'lastEvent.lot', 'lastEvent.saleStatus', 'lastEvent.bid', 'lastEvent.message']) assert.equal(Object.hasOwn(fields, key), false)
})

test('"Aguardando classificação" da página do lote não substitui a monta capturada', () => {
  for (const damage of ['Aguardando Classificação', 'AGUARDANDO CLASSIFICACAO', 'Em classificação']) {
    const fields = buildLiveAuctionCaptureFields({ ...captured, captureContext: 'vehicle_detail', damage })
    assert.equal(Object.hasOwn(fields, 'lastEvent.damage'), false, damage)
  }
  assert.equal(buildLiveAuctionCaptureFields({ ...captured, damage: 'Grande monta' })['lastEvent.damage'], 'Grande monta')
  assert.equal(damageModule.normalizeDamage('Aguardando Classificação'), null)
  assert.equal(damageModule.classifyDamage('Aguardando Classificação'), 'sem_info')
  assert.equal(damageModule.normalizeDamage('media monta'), 'Média monta')
})

test('abrir a página do lote não altera a observação ao vivo sem recaptura', () => {
  const capture = read('../layers/cars/server/utils/live-auction-capture.ts')
  assert.match(capture, /input\['captureContext'\] === 'vehicle_detail' && !options\.explicit/)
  const recapture = read('../layers/cars/server/api/vehicles/recapture.post.ts')
  assert.match(recapture, /recordLiveAuctionCapture\([\s\S]*\{ explicit: true \}/)
})

test('resultado final da sala continua atualizando status e valor', () => {
  const fields = buildLiveAuctionCaptureFields(captured)
  assert.equal(fields.auctionId, '10477')
  assert.equal(fields['lastEvent.saleStatus'], 'sold')
  assert.equal(fields['lastEvent.bid'], 8650)
})

test('FIPE inválida ou zerada não substitui valor válido', () => {
  for (const fipe of [0, -1, NaN, Infinity, null]) assert.equal(Object.hasOwn(buildLiveAuctionCaptureFields({ fipe }), 'lastEvent.fipe'), false)
})

test('lê FIPE e Valor FIPE em linhas de dados e tabelas', () => {
  const c = reader()
  for (const label of ['FIPE:', 'Valor FIPE', 'Valor FIPE:']) {
    const row = { querySelector: selector => ({ textContent: selector.includes('data-title') ? label : 'R$ 29.343,00' }) }
    const root = { querySelectorAll: selector => selector.includes('tr') ? [row] : [] }
    const detail = c.extractDetailRows(root)
    assert.equal(c.parseMoney(detail.fipeRaw), 29343)
  }
})

test('lê FIPE do texto com ou sem dois-pontos', () => {
  const c = reader()
  for (const label of ['FIPE:', 'Valor FIPE:', 'Valor FIPE']) {
    assert.equal(c.parseMoney(c.extractDetailFromText(`${label} R$ 29.343,00`).fipeRaw), 29343)
  }
})

test('abrir detalhes ou publicar outra sessão preserva o snapshot do lote 38', async () => {
  const publish = snapshotPublisher()
  const message = items => ({ source: 'copart', snapshots: items })
  await publish(message([{ sessionKey: 'copart:10477', updatedAt: Date.now(), items: [captured] }]))
  const afterEmpty = await publish(message([]))
  assert.equal(Object.values(afterEmpty)[0].items[0].lot, '38')
  const afterOther = await publish(message([{ sessionKey: 'copart:999', items: [{ lot: '1' }] }]))
  assert.equal(Object.keys(afterOther).length, 2)
})

test('publicações simultâneas de abas preservam ambas as sessões', async () => {
  const publish = snapshotPublisher()
  const messages = ['10477', '10478'].map(id => ({ source: 'copart', snapshots: [{ sessionKey: `copart:${id}`, items: [captured] }] }))
  await Promise.all(messages.map(message => publish(message)))
  const snapshots = await publish({ source: 'copart', snapshots: [] })
  assert.equal(Object.keys(snapshots).length, 2)
})


test('extrator da página individual usa somente tabela com código 1157950', () => {
  const c = reader()
  const row = (label, value) => ({ querySelector: selector => ({ textContent: selector.includes('data-title') ? label : value }) })
  const table = (code, fipe) => ({ querySelectorAll: selector => selector.includes('tr') ? [row('Código:', code), row('Valor FIPE:', fipe)] : [] })
  c.setTables([table('1157950', 'R$ 29.343,00'), table('9999999', 'R$ 100.000,00')])
  const values = c.extractCurrentVehicleDetail()
  assert.equal(values.code, '1157950')
  assert.equal(c.parseMoney(values.fipeRaw), 29343)
})

test('página individual repete leitura enquanto FIPE ainda carrega', () => {
  const c = reader()
  c.scheduleCopartDetailSettling({ code: '1157950', fipeRaw: null })
  assert.deepEqual(c.timers, [250])
})


test('leitura da FIPE prioriza texto visível e ignora conteúdo oculto concatenado', () => {
  const c = reader()
  const row = { querySelector: selector => selector.includes('data-title')
    ? { textContent: 'FIPE:' }
    : { innerText: 'R$ 41.302,00', textContent: 'R$ 41.302,00R$ 31.143,00' } }
  const root = { querySelectorAll: selector => selector.includes('tr') ? [row] : [] }
  assert.equal(c.parseMoney(c.extractDetailRows(root).fipeRaw), 41302)
})
