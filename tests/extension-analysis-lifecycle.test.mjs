import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')
const tick = () => new Promise(resolve => setImmediate(resolve))
const plain = value => JSON.parse(JSON.stringify(value))
const lot = (source = 'pestana', n = 1, patch = {}) => ({ source, auctionId: '6262', lot: String(n), code: null,
  brand: 'AUDI', model: 'A3', yearModel: '2013/2014', description: 'Audi A3 2013 2014', bid: null,
  fipe: null, damage: null, publishedFees: null, vehicleUrl: null, captureReady: true, ...patch })
const result = event => ({ ok: true, body: { matched: true, vehicle: { fipe: 35944, fipeOrigin: 'database_reference' },
  metrics: { marketAnalysis: { averagePct: 40, sampleSize: 31 }, feeEstimate: null } } })

function collector(api = async (_path, { body }) => result(body)) {
  const timers = new Map(), calls = [], frames = []
  let now = 10000, timerId = 0
  const window = { setTimeout(fn, delay) { timers.set(++timerId, { fn, at: now + delay }); return timerId }, clearTimeout(id) { timers.delete(id) } }
  const context = vm.createContext({ window, URL, Intl, console, location: new URL('https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/aovivo'),
    Date: class extends Date { static now() { return now } }, localStorage: { getItem() { return null }, setItem() {} } })
  vm.runInContext(script.replace('  if (window.top !== window) {', `
    window.test = { state, prepareVehicleTransition, scheduleAssistantRefresh, getAssistantSignature, getFeeEstimateSignature,
      stabilizeCopartLiveEvent, getBidSimulationValues, renderAuthentication, refreshPreview,
      setReader(event) { buildPreviewEvent = () => event; },
      setApi(api) { requestLocalApi = api; }, setRenderer(renderer) { renderSummary = renderer; } };
    waitForFrameDocuments = async () => {};
    requestFrameSnapshots = async () => [];
    return;
    if (window.top !== window) {`), context)
  const c = window.test
  c.state.authenticated = true
  c.state.preview = { textContent: '{}' }
  c.state.status = { textContent: '' }
  c.setApi(async (path, options) => { calls.push(plain(options.body)); return api(path, options) })
  c.setRenderer(() => frames.push({ loading: c.state.assistantLoading, analysis: c.state.assistant, signature: c.state.assistantSignature }))
  return { ...c, calls, frames, timers,
    update(event, options) {
      c.state.preview.textContent = JSON.stringify(event)
      c.prepareVehicleTransition(event)
      c.scheduleAssistantRefresh(event, options)
    },
    async read(event) { c.setReader(event); return c.refreshPreview({ skipSave: true }) },
    async advance(ms = 500) {
      now += ms
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn() }
      await tick()
    },
    get analyses() { return calls.filter(body => !body.feesOnly) },
    get fees() { return calls.filter(body => body.feesOnly) },
  }
}

for (const source of ['pestana', 'copart', 'sodre', 'vipleiloes']) test(`${source}: análise única com lance, código, FIPE e taxas chegando depois`, async () => {
  const c = collector(), first = lot(source)
  c.update(first)
  c.update(first)
  assert.equal(c.timers.size, 1, 'segunda leitura não cancela nem duplica o timer pendente')
  await c.advance()
  const analysis = c.state.assistant
  assert.ok(analysis)
  const key = c.getAssistantSignature(first)
  for (const patch of [{ bid: 15300 }, { bid: 18000, code: '443168', vehicleUrl: 'https://example.test/443168' },
    { bid: 18500, fipe: 35944, publishedFees: { commissionRate: 0.05, operationalExpenses: 2350 } }, { bid: 19000, saleStatus: 'sold' }]) {
    c.update({ ...first, ...patch })
    await c.advance()
    assert.equal(c.getAssistantSignature({ ...first, ...patch }), key)
    assert.equal(c.state.assistant, analysis)
    assert.equal(c.state.assistantLoading, false)
  }
  assert.equal(c.analyses.length, 1)
  assert.ok(c.fees.length > 0, 'primeiro lance libera taxas sem repetir histórico')
})

test('Pestana espera estabilizar e aprender o ID global não inicia outra transição', async () => {
  const c = collector(), first = lot('pestana', 1, { bid: 15300 })
  c.update(c.stabilizeCopartLiveEvent(first))
  await c.advance(1000)
  assert.equal(c.calls.length, 0, 'não consulta o lote em quarentena')
  c.update(c.stabilizeCopartLiveEvent(first))
  await c.advance()
  assert.equal(c.analyses.length, 1)
  const enriched = c.stabilizeCopartLiveEvent({ ...first, code: '443168', vehicleUrl: 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443168' })
  assert.equal(enriched.captureReady, true)
  c.update(enriched)
  await c.advance()
  assert.equal(c.analyses.length, 1)
  assert.equal(c.state.assistantLoading, false)
})

test('pipeline atualiza o preview ao estabilizar mesmo quando o lote ainda não tem lance', async () => {
  const c = collector(), first = lot()
  await c.read(first)
  assert.equal(JSON.parse(c.state.preview.textContent).captureReady, false)
  await c.advance(1000)
  await c.read(first)
  assert.equal(JSON.parse(c.state.preview.textContent).captureReady, true)
  await c.advance()
  assert.equal(c.analyses.length, 1)
  await c.read(first)
  await c.advance()
  assert.equal(c.analyses.length, 1)
})

test('timer usa a leitura completa mais recente, sem reiniciar com cada mutação', async () => {
  const c = collector(), first = lot('copart')
  c.update(first)
  c.update({ ...first, code: '443168', fipe: 35944 })
  await c.advance()
  assert.equal(c.analyses.length, 1)
  assert.equal(c.analyses[0].code, '443168')
  assert.equal(c.analyses[0].fipe, 35944)
})

test('cache distingue fonte e leilão mesmo com o mesmo número de lote', async () => {
  const c = collector(), first = lot()
  for (const event of [first, lot('copart'), { ...first, auctionId: '9999' }]) {
    c.update(event); await c.advance()
  }
  assert.equal(c.analyses.length, 3)
  c.update(first); await c.advance()
  assert.equal(c.analyses.length, 3)
  assert.equal(c.state.assistantSignature, c.getAssistantSignature(first))
})

test('resposta atrasada não substitui o lote atual; voltar ao anterior usa o cache', async () => {
  let finishFirst
  const c = collector(async (_path, { body }) => body.lot === '1' ? new Promise(resolve => { finishFirst = resolve }) : result(body))
  const first = lot(), next = lot('pestana', 2)
  c.update(first); await c.advance()
  c.update(next); await c.advance()
  const nextAnalysis = c.state.assistant
  finishFirst(result(first)); await tick()
  assert.equal(c.state.assistant, nextAnalysis)
  assert.equal(c.state.assistantSignature, c.getAssistantSignature(next))
  c.update(first); await c.advance()
  assert.equal(c.analyses.length, 2)
  assert.equal(c.state.assistantSignature, c.getAssistantSignature(first))
})

test('voltar ao lote com consulta ainda em andamento compartilha a mesma requisição', async () => {
  let finishFirst
  const c = collector(async (_path, { body }) => body.lot === '1' ? new Promise(resolve => { finishFirst = resolve }) : result(body))
  const first = lot()
  c.update(first); await c.advance()
  c.update(lot('pestana', 2)); await c.advance()
  c.update(first); await c.advance()
  assert.equal(c.analyses.filter(body => body.lot === '1').length, 1)
  finishFirst(result(first)); await tick()
  assert.equal(c.state.assistantSignature, c.getAssistantSignature(first))
  assert.equal(c.state.assistantLoading, false)
})

test('recarregamento explícito renova a análise; logout invalida cache e respostas pendentes', async () => {
  const c = collector(), first = lot()
  c.update(first); await c.advance()
  c.update(first, { force: true }); await c.advance()
  assert.equal(c.analyses.length, 2)
  c.renderAuthentication(false, null, '')
  assert.equal(c.state.assistantCache.size, 0)
  assert.equal(c.state.assistant, null)
  let finish
  const pending = collector(async () => new Promise(resolve => { finish = resolve }))
  pending.update(first); await pending.advance()
  pending.renderAuthentication(false, null, '')
  finish(result(first)); await tick()
  assert.equal(pending.state.assistantCache.size, 0)
  assert.equal(pending.state.assistant, null)
})

test('falha permite retry sem reiniciar o carregamento a cada leitura da página', async () => {
  let valid = false
  const c = collector(async () => valid ? result(lot()) : { ok: false, body: { message: 'Indisponível' } })
  c.update(lot()); await c.advance()
  assert.equal(c.state.assistantError, 'Indisponível')
  c.update(lot()); await c.advance()
  assert.equal(c.analyses.length, 1)
  assert.equal(c.state.assistantLoading, false)
  valid = true
  await c.advance(15000)
  c.update(lot()); await c.advance()
  assert.equal(c.analyses.length, 2)
  assert.ok(c.state.assistant)
})
