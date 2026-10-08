import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Cheerio's fetch dependency expects File on Node 20+, which the app requires.
if (!globalThis.File) globalThis.File = class File {}
const { load } = require('cheerio')
const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')
const fixture = readFileSync(new URL('./fixtures/sodre-public-detail.html', import.meta.url), 'utf8')
const url = 'https://leilao.sodresantoro.com.br/leilao/29127/lote/2812414/'

function reader(html = fixture, href = url) {
  const $ = load(html)
  const window = { setTimeout() {}, clearTimeout() {}, setInterval() { return 1 } }
  const context = vm.createContext({ window, URL, location: new URL(href), document: { hidden: false } })
  vm.runInContext(script.replace('  if (window.top !== window) {', `
    window.test = { state, isSodreHref, isIndividualLotPage, buildSodrePreviewEvent,
      startActiveLoop, startDetailPreviewWatcher, refreshPreview,
      setElements(reader) { getElements = reader; },
      setRefresh(reader) { refreshPreview = reader; },
      isVisible(element) { isVisibleElement = element => element.visible; },
    };
    return;
    if (window.top !== window) {`), context)
  window.test.setElements(selectors => [...new Set(selectors.flatMap(selector => $(selector).toArray()))].map(node => ({
    textContent: $(node).text(), getAttribute: key => $(node).attr(key),
    visible: !$(node).is('[hidden]') && !/display:\s*none/.test($(node).attr('style') ?? ''),
  })))
  window.test.isVisible()
  return { ...window.test, $, window }
}

test('habilita a página individual e mantém suporte à sala e à Copart', () => {
  const c = reader()
  assert.equal(c.isIndividualLotPage(), true)
  assert.equal(c.isSodreHref(url), true)
  assert.equal(c.isSodreHref('https://www.sodresantoro.com.br/app/telao/29127/'), true)
  assert.equal(c.isSodreHref('https://leilao.sodresantoro.com.br/leilao/29127/lote/0/'), false)
  assert.equal(c.isSodreHref('https://evil.example/leilao/29127/lote/2812414/'), false)
  assert.equal(reader(fixture, 'https://www.copart.com.br/lot/1234567').isIndividualLotPage(), true)
})

test('lê o DOM público do lote 0091 sem confundir código, número ou próximo lance', () => {
  const c = reader()
  const event = c.buildSodrePreviewEvent()
  assert.equal(event.source, 'sodre')
  assert.equal(event.auctionId, '29127')
  assert.equal(event.code, '2812414')
  assert.equal(event.lot, '0091')
  assert.equal(event.bid, 4500)
  assert.equal(event.brand, 'BMW')
  assert.equal(event.model, '330E')
  assert.equal(event.yearModel, '2025/2026')
  assert.equal(event.damage, 'Média Monta')
  assert.equal(event.fipe, null, 'logística de R$ 350 da descrição não é FIPE')
  assert.equal(event.vehicleUrl, url)
  assert.match(event.imageUrl, /\/29127\/2812414\//)
})

test('lance atual muda de forma reativa e ausência mantém preço nulo', () => {
  const c = reader()
  c.$('#currentBid').text('R$ 20.500,00')
  assert.equal(c.buildSodrePreviewEvent().bid, 20500)
  c.$('#currentBid').remove()
  assert.equal(c.buildSodrePreviewEvent().bid, null)
  const partial = reader('<div id="titleLot">BMW 330E 25/26</div><span id="currentBid">R$ 0</span><span id="fipeLot">R$ 0</span>')
  assert.equal(partial.buildSodrePreviewEvent().model, '330E')
  assert.equal(partial.buildSodrePreviewEvent().bid, null)
  assert.equal(partial.buildSodrePreviewEvent().fipe, null)
})

test('foto de outro lote não substitui a identidade nem a imagem atual', () => {
  const c = reader(fixture.replaceAll('/29127/2812414/', '/29127/2812320/'))
  const event = c.buildSodrePreviewEvent()
  assert.equal(event.code, '2812414')
  assert.equal(event.imageUrl, null)
})

test('FIPE visível é usada; campos ocultos e formulários não são referências', () => {
  const c = reader(fixture + '<span hidden id="fipeLot">R$ 999.999</span><span data-lot-target="fipe">R$ 320.000</span>')
  assert.equal(c.buildSodrePreviewEvent().fipe, 320000)
  c.$('[data-lot-target="fipe"]').remove()
  assert.equal(c.buildSodrePreviewEvent().fipe, null)
})

test('encerramento não comprova venda; status finais explícitos permanecem distintos', () => {
  for (const [status, expected] of [['Leilão finalizado', null], ['Vendido', 'sold'], ['Não vendido', 'not_sold'], ['Condicional', 'conditional']]) {
    const event = reader(fixture + `<div id="detail_info_lot_status">${status}</div>`).buildSodrePreviewEvent()
    assert.equal(event.saleStatus, expected)
  }
})

test('página individual acompanha indicadores sem iniciar coleta nem ingestão automática', async () => {
  const c = reader()
  c.state.authenticated = true
  c.startActiveLoop()
  assert.equal(c.state.activeTimer, null)
  let timer
  c.window.setInterval = callback => { timer = callback; return 1 }
  const requests = []
  c.setRefresh(async options => requests.push(options))
  c.startDetailPreviewWatcher()
  await timer()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].skipSave, true)
  c.state.authenticated = false
  await timer()
  assert.equal(requests.length, 1)
})
