import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
if (!globalThis.File) globalThis.File = class File {}
const { load } = require('cheerio')
const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')
const fixture = readFileSync(new URL('./fixtures/pestana-public-live.html', import.meta.url), 'utf8')
const href = 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/aovivo'

function reader(html = fixture, url = href) {
  const $ = load(html), window = {}, storage = new Map(), sent = []
  const context = vm.createContext({ window, URL, location: new URL(url), document: {}, console, Intl, Date,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  })
  vm.runInContext(script.replace('  if (window.top !== window) {', `
    window.test = { state, buildPreviewEvent, isPestanaHref, isSupportedPage, getActiveAdapter,
      getHardSaveBlockReason, getSoftSaveBlockReason, getSaveDecision, capturePestanaAuditSnapshot,
      captureLocalLot, readLocalCaptureItems, stabilizeCopartLiveEvent,
      rememberPestanaIdentity, getVehicleIdentityKey,
      setElements(reader) { getElements = reader; },
      setSender(sender) { sendRuntimeMessage = sender; },
      visible() { isVisibleElement = el => el.visible; },
    }; return;
    if (window.top !== window) {`), context)
  function element(node) {
    if (!node) return null
    return {
      textContent: $(node).text(), getAttribute: key => $(node).attr(key),
      visible: !$(node).is('[hidden]') && !$(node).parents('[hidden]').length,
      get parentElement() { return element(node.parent) },
      querySelector: selector => element($(node).find(selector).first()[0]),
    }
  }
  window.test.setElements(selectors => [...new Set(selectors.flatMap(selector => $(selector).toArray()))].map(element))
  window.test.visible()
  window.test.state.settings = { autoSaveStates: ['SC'], allowTrucks: false, allowMotorcycles: false, ignoredCategories: [], allowedCategories: [], requireDetectedState: true }
  window.test.setSender(async message => { sent.push(JSON.parse(JSON.stringify(message))); return { ok: true } })
  return { ...window.test, $, sent }
}

test('reconhece apenas salas Pestana oficiais e o exemplo local autorizado', () => {
  const c = reader()
  assert.equal(c.isSupportedPage(), true)
  assert.equal(c.getActiveAdapter().id, 'pestana')
  for (const url of ['https://pestanaleiloes.com.br.evil.test/agenda-de-leiloes/6262/aovivo', 'https://user@www.pestanaleiloes.com.br/agenda-de-leiloes/6262/aovivo', 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443168', 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262']) assert.equal(c.isPestanaHref(url), false)
  const local = reader(fixture, 'file:///tmp/bot-anuncios/data/.aovivo-pestana.html')
  assert.equal(local.isSupportedPage(), true)
  assert.equal(local.buildPreviewEvent().auctionId, null, 'arquivo local não inventa o ID do pregão')
  assert.equal(local.buildPreviewEvent().captureReady, false)
})

test('HTML real: lote atual é Audi 1, lance 43.900; não lê próximo lote, oferta de 44.400 ou total', () => {
  const c = reader(), event = c.buildPreviewEvent()
  assert.equal(event.source, 'pestana')
  assert.equal(event.auctionId, '6262')
  assert.equal(event.lot, '1')
  assert.equal(event.code, null)
  assert.equal(event.vehicleUrl, null)
  assert.equal(event.brand, 'AUDI')
  assert.equal(event.model, 'A3 LM 180CV')
  assert.equal(event.yearModel, '2013/2014')
  assert.equal(event.bid, 43900)
  assert.equal(event.saleStatus, 'open')
  assert.equal(event.category, 'Automóveis')
  assert.equal(event.yard, 'SC')
  assert.equal(event.damage, null)
  assert.equal(event.condition, 'Para circulação · Retomado')
  assert.match(event.consignor, /Bradesco/)
  assert.match(event.imageUrl, /ged\.pestanaleiloes\.com\.br/)
  assert.equal(event.fipe, null)
  assert.equal(event.captureReady, true)
  assert.match(event.auctionUrl, /6262\/aovivo$/)
  assert.equal(c.getHardSaveBlockReason(event), 'Aguardando resultado')
  assert.equal(c.getHardSaveBlockReason({ ...event, saleStatus: 'sold' }), null)
})

test('mutações sintéticas: preço ausente não usa inicial, oferta, taxas ou valor de outro lote', () => {
  const c = reader()
  c.$('.valorLance').text('R$ 45.100,00')
  assert.equal(c.buildPreviewEvent().bid, 45100)
  c.$('.numeroLanceVencedor').remove()
  c.$('.lote-lista-container').append('<div class="valorLance">R$ 900.000,00</div>')
  assert.equal(c.buildPreviewEvent().bid, null)
})

test('identidade retornada pelo backend corrige o link sem trocar a chave local ou contaminar o próximo lote', () => {
  const c = reader(), first = c.buildPreviewEvent()
  const key = c.getVehicleIdentityKey(first)
  c.rememberPestanaIdentity(first, 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443168')
  const updated = c.buildPreviewEvent()
  assert.equal(updated.code, '443168')
  assert.equal(updated.vehicleUrl, 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443168')
  assert.equal(c.getVehicleIdentityKey(updated), key)
  c.$('#loteHeader .lote-numero').text('Lote 2')
  assert.equal(c.buildPreviewEvent().code, null)
  c.rememberPestanaIdentity({ ...first, lot: '2' }, 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/9999/443168')
  assert.equal(c.buildPreviewEvent().code, null)
})

test('mutações sintéticas: somente resultados explícitos encerram, repasse/encerramento não confirmam venda', () => {
  const c = reader()
  for (const [label, status] of [['Vendido', 'sold'], ['Arrematado', 'sold'], ['Condicional', 'conditional'], ['Não vendido', 'not_sold'], ['Aguardando repasse', 'open'], ['Encerrado', 'open']]) {
    c.$('#label-lance').text(label)
    assert.equal(c.buildPreviewEvent().saleStatus, status)
  }
  c.$('h1.descricao').text('Fiat Cronos DRIVE 2022 2022 Gas/Alc')
  assert.equal(c.buildPreviewEvent().captureReady, false, 'título novo com características antigas fica em transição')
})

test('mensagens finais do portal encerram sem depender do rótulo Lance atual', () => {
  const c = reader()
  c.$('#content-leilao-live').append('<div class="right"><h2></h2></div>')
  for (const [message, status] of [['Este lote foi vendido!', 'sold'], ['Este lote está pendente de homologação!', 'conditional'], ['Este lote não foi vendido!', 'not_sold'], ['Este lote foi cancelado!', 'open'], ['Este lote foi retirado do leilão!', 'open']]) {
    c.$('.right h2').text(message)
    assert.equal(c.buildPreviewEvent().saleStatus, status)
  }
  c.$('.right h2').text('Este lote foi vendido!').attr('hidden', '')
  c.$('.lote-lista-container').append('<h2>Este lote foi vendido!</h2>')
  assert.equal(c.buildPreviewEvent().saleStatus, 'open', 'resultado oculto ou da lista lateral não encerra o lote atual')
})

test('segue filtros existentes de estado, motos, pesados e monta; evento aberto permanece local', () => {
  const c = reader(), event = c.buildPreviewEvent()
  c.captureLocalLot(event, c.getSaveDecision(event))
  assert.equal(c.readLocalCaptureItems().length, 1)
  assert.equal(c.sent.length, 0)
  assert.match(c.getSoftSaveBlockReason({ ...event, category: 'Motocicletas' }), /Categoria/)
  assert.match(c.getSoftSaveBlockReason({ ...event, category: 'Caminhões' }), /Categoria/)
  assert.match(c.getSoftSaveBlockReason({ ...event, yard: 'MG' }), /Estado/)
})

test('audita abertura, lance, resultado e reabertura sem licitantes; aguarda confirmação local', async () => {
  const c = reader(), event = c.buildPreviewEvent()
  await c.capturePestanaAuditSnapshot(event)
  await c.capturePestanaAuditSnapshot(event)
  await c.capturePestanaAuditSnapshot({ ...event, bid: 45000 })
  await c.capturePestanaAuditSnapshot({ ...event, saleStatus: 'sold' })
  await c.capturePestanaAuditSnapshot(event)
  assert.deepEqual(c.sent.map(row => row.events[0].kind), ['lot_opened', 'bid_updated', 'lot_sold', 'bid_updated'])
  assert.ok(c.sent.every(row => row.events[0].source === 'pestana' && row.events[0].lot === '1'))
  assert.ok(c.sent.every(row => !row.events[0].rawText.includes('********')))
  const retry = reader(); let attempts = 0
  retry.setSender(async () => ({ ok: ++attempts > 1 }))
  await retry.capturePestanaAuditSnapshot(event)
  assert.equal(retry.state.pestanaAuditSignature, null)
  await retry.capturePestanaAuditSnapshot(event)
  assert.notEqual(retry.state.pestanaAuditSignature, null)
})

test('ingestão resolve o lote real, conserva a identidade do scraper e bloqueia erro de catálogo antes de persistir', async () => {
  const ts = require('typescript'), modules = new Map()
  const lots = JSON.parse(readFileSync(new URL('./fixtures/pestana-live-identities.json', import.meta.url), 'utf8'))
  const network = { calls: 0, valid: true }
  function compile(path, suffix = '') {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8') + suffix
    const context = vm.createContext({ exports: {}, URL, Date, TextEncoder, crypto: globalThis.crypto, AbortSignal,
      fetch: async () => { network.calls++; return network.valid ? Response.json(lots) : new Response('CAPTCHA') },
      require: id => { assert.ok(modules.has(id), `dependência inesperada ${id}`); return modules.get(id) },
      defineEventHandler: handler => handler,
    })
    vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context)
    return context.exports
  }
  modules.set('./pestana-url', compile('../shared/utils/pestana-url.ts'))
  modules.set('#shared/utils/hash', compile('../shared/utils/hash.ts'))
  modules.set('#shared/utils/damage', compile('../shared/utils/damage.ts'))
  modules.set('#shared/utils/vehicle-retention', compile('../shared/utils/vehicle-retention.ts'))
  modules.set('../../utils/sodre-live-identity', compile('../layers/cars/server/utils/sodre-live-identity.ts'))
  modules.set('../../utils/pestana-live-identity', compile('../layers/cars/server/utils/pestana-live-identity.ts'))
  for (const id of ['../../utils/live-auction-extension-auth', '../../utils/schemas/vehicle', '../../utils/live-vehicle-sync-outbox', '../../utils/favorite-lot-result', '../../utils/live-auction-capture', '#shared/utils/copart-auction-room']) modules.set(id, {})
  const { normalizeVehicle } = compile('../layers/cars/server/api/vehicles/ingest.post.ts', '\nexport { normalizeVehicle }\n')
  const event = { ...reader().buildPreviewEvent(), allowedStates: ['SC'], saleStatus: 'sold', message: 'Este lote foi vendido!' }
  const result = await normalizeVehicle(event)
  assert.equal(result.ok, true)
  assert.equal(result.vehicle.source, 'pestana')
  assert.equal(result.vehicle.url, 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443168')
  assert.equal(result.vehicle.soldPrice, 43900)
  assert.equal(result.vehicle.state, 'SC')
  assert.equal(result.vehicle.year, 2014)
  assert.equal(result.vehicle.externalId, await modules.get('#shared/utils/hash').buildExternalId('pestana', 'https://www.pestanaleiloes.com.br/lote/6262/443168'))
  const noPrice = await normalizeVehicle({ ...event, bid: null, bidRaw: null })
  assert.equal(noPrice.vehicle.soldPrice, null)
  assert.equal((await normalizeVehicle({ ...event, category: 'Imóveis' })).reason, 'categoria_descartada')
  assert.equal((await normalizeVehicle({ ...event, yard: 'MG' })).reason, 'estado_ignorado_mg')
  assert.equal((await normalizeVehicle({ ...event, saleStatus: 'open', message: 'Lance atual' })).reason, 'status_nao_finalizado')
  assert.equal(network.calls, 1, 'índice do pregão é reutilizado')
  network.valid = false
  assert.equal((await normalizeVehicle({ ...event, auctionId: '9999' })).reason, 'identidade_pestana_indisponivel')
})
