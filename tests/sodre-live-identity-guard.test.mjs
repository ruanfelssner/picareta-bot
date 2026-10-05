import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const content = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')

function loadGuard(items) {
  const window = { setTimeout() { return 0 }, clearTimeout() {} }
  const context = vm.createContext({ window, URL, location: new URL('https://www.copart.com.br/leiloes') })
  vm.runInContext(content.replace('  if (window.top !== window) {', `
    readLocalCaptureItems = () => window.items;
    window.test = { guardSodreLotIdentity, normalizeLotCode, getDecisionKey, buildSodreVehicleUrl };
    return;
    if (window.top !== window) {`), context)
  window.items = items
  return window.test
}

const sodreEvent = overrides => ({
  source: 'sodre',
  auctionId: '29123',
  lot: '0006',
  code: '2809300',
  imageUrl: 'https://cdn.sodresantoro.com.br/veiculos/29123/2809300/foto.jpg',
  vehicleUrl: 'https://leilao.sodresantoro.com.br/leilao/29123/lote/2809300/',
  ...overrides,
})

test('código placeholder não identifica lote', () => {
  const { normalizeLotCode, getDecisionKey } = loadGuard([])
  assert.equal(normalizeLotCode('0'), null)
  assert.equal(normalizeLotCode('000'), null)
  assert.equal(normalizeLotCode('2809287'), '2809287')
  assert.equal(getDecisionKey({ source: 'sodre', code: '0', auctionId: '29123', lot: '0001' }), 'sodre:auction:29123:lot:0001')
})

test('foto atrasada do lote anterior não sobrescreve o lote anterior', () => {
  const { guardSodreLotIdentity } = loadGuard([{ auctionId: '29123', lot: '0005', code: '2809287' }])
  const guarded = guardSodreLotIdentity(sodreEvent({ code: '2809287', imageUrl: 'https://cdn.sodresantoro.com.br/veiculos/29123/2809287/foto.jpg' }))
  assert.equal(guarded.lot, '0006')
  assert.equal(guarded.code, null)
  assert.equal(guarded.imageUrl, null)
  assert.equal(guarded.vehicleUrl, null)
  assert.equal(guarded.identityConflict, true)
})

test('lote já ligado a outro código também é tratado como transição', () => {
  const { guardSodreLotIdentity } = loadGuard([{ auctionId: '29123', lot: '0006', code: '2809300' }])
  const guarded = guardSodreLotIdentity(sodreEvent({ code: '2809301' }))
  assert.equal(guarded.code, null)
})

test('identidade consistente e outras sessões não são alteradas', () => {
  const { guardSodreLotIdentity } = loadGuard([
    { auctionId: '29123', lot: '0006', code: '2809300' },
    { auctionId: '30000', lot: '0001', code: '2809300' },
  ])
  const event = sodreEvent({})
  assert.equal(guardSodreLotIdentity(event), event)
  const copart = { source: 'copart', auctionId: '1', lot: '1', code: '0' }
  assert.equal(guardSodreLotIdentity(copart), copart)
})

test('código placeholder não gera link do veículo', () => {
  const { buildSodreVehicleUrl } = loadGuard([])
  assert.equal(buildSodreVehicleUrl('29123', '0'), null)
  assert.equal(buildSodreVehicleUrl('29123', '2809300'), 'https://leilao.sodresantoro.com.br/leilao/29123/lote/2809300/')
})
