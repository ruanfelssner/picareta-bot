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
      maybeSaveEvent, registerFavoriteLot,
      rememberPestanaIdentity, getVehicleIdentityKey, getBidSimulationValues, getFeeEstimateSignature, getAssistantSignature, renderSummary,
      setElements(reader) { getElements = reader; },
      setSender(sender) { sendRuntimeMessage = sender; },
      setIngest(sender) { sendIngestEvent = sender; },
      visible() { isVisibleElement = el => el.visible; },
    };
    renderWhatsappOptIn = renderSaveSignal = renderSaveCurrentButton = renderRefreshButton = applyPanelPosition = () => {};
    return;
    if (window.top !== window) {`), context)
  function element(node) {
    if (!node) return null
    return {
      textContent: $(node).text(), getAttribute: key => $(node).attr(key),
      visible: !$(node).is('[hidden]') && !$(node).parents('[hidden]').length,
      get parentElement() { return element(node.parent) },
      get children() { return $(node).children().toArray().map(element) },
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
  assert.deepEqual(JSON.parse(JSON.stringify(event.publishedFees)), { commissionRate: 0.05, operationalExpenses: 2350 })
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

test('extrai despesas da cotação sem substituir o lance atual e preserva a margem nas simulações', () => {
  const c = reader(), event = c.buildPreviewEvent()
  const base = { source: 'pestana', ...event.publishedFees }
  const result = c.getBidSimulationValues(15300, null, 35944, base, null)
  assert.equal(result.feeEstimate.commission, 765)
  assert.equal(result.total, 18415)
  assert.equal(result.margin, 17529)
  assert.equal(c.getBidSimulationValues(18000, null, 35944, base, null).total, 21250)
  assert.equal(c.getBidSimulationValues(18000, 20000, 35944, base, null).margin, 12594)
  assert.equal(c.getBidSimulationValues(18000, null, null, base, null).margin, null)
  assert.equal(c.getBidSimulationValues(18000, null, 10000, base, null).margin, -11250)
  const feeSignature = c.getFeeEstimateSignature(event), assistantSignature = c.getAssistantSignature(event)
  c.$('.published-total > div').eq(2).children().last().text('R$ 900,00')
  c.$('.valor-total-taxas').children().last().text('R$ 47.520,00*')
  const updated = c.buildPreviewEvent()
  assert.equal(updated.publishedFees.operationalExpenses, 900)
  assert.notEqual(c.getFeeEstimateSignature(updated), feeSignature)
  assert.equal(c.getAssistantSignature(updated), assistantSignature, 'taxas novas não recarregam a análise histórica')
  assert.equal(c.getFeeEstimateSignature({ ...updated, bid: 45000 }), c.getFeeEstimateSignature(updated))
})

test('cotação incompleta não inventa taxa; resultado mantém termos já observados somente para o mesmo lote', () => {
  const c = reader(), event = c.buildPreviewEvent()
  c.captureLocalLot(event, c.getSaveDecision(event))
  c.$('.published-total').remove()
  assert.equal(c.buildPreviewEvent().publishedFees.operationalExpenses, 2350)
  c.$('#loteHeader .lote-numero').text('Lote 2')
  assert.equal(c.buildPreviewEvent().publishedFees, null)
  const invalid = reader()
  invalid.$('.valor-total-taxas').children().last().text('R$ 1,00')
  assert.equal(invalid.buildPreviewEvent().publishedFees, null)
  invalid.$('.right').remove()
  invalid.$('.lote-lista-container').append('<div class="valor-total-taxas"><div>Despesas Operacionais</div><div>R$ 2.350,00</div></div>')
  assert.equal(invalid.buildPreviewEvent().publishedFees, null)
})

test('o painel mostra margem com FIPE de referência e descarta taxas antigas quando o lote muda de despesas', () => {
  const c = reader(), event = { ...c.buildPreviewEvent(), bid: 18000 }
  c.state.summary = { innerHTML: '', dataset: {}, querySelector() { return null } }
  c.state.assistant = { matched: true, vehicle: { fipe: 35944, fipeOrigin: 'database_reference', fipeReference: { year: 2017 } },
    metrics: { feeEstimate: { source: 'pestana', ...event.publishedFees } } }
  c.state.assistantSignature = c.getAssistantSignature(event)
  c.state.assistantFeeSignature = c.getFeeEstimateSignature(event)
  c.renderSummary(event)
  let html = load(c.state.summary.innerHTML)
  assert.equal(html('.clp-margin-value strong').text(), 'R$ 14.694')
  assert.equal(html('.clp-total-percent-metric .clp-metric-reference strong').text(), 'R$ 21.250')
  assert.match(html('.clp-total-percent-metric .clp-metric-reference').attr('title'), /Comissão: R\$ 900.*Despesas operacionais: R\$ 2\.350/)
  c.renderSummary({ ...event, bid: 19000 })
  c.renderSummary({ ...event, bid: null })
  assert.equal(load(c.state.summary.innerHTML)('.clp-margin-value strong').text(), 'R$ 13.644', 'fechamento sem lance mantém o último lance observado, sem voltar ao preço inicial do assistente')
  const updated = { ...event, publishedFees: { ...event.publishedFees, operationalExpenses: 900 } }
  c.renderSummary(updated)
  html = load(c.state.summary.innerHTML)
  assert.equal(html('.clp-margin-value strong').text(), '—', 'resposta do lote com despesas antigas não reaparece no painel')
  c.state.feeEstimateContext = { signature: c.getFeeEstimateSignature(updated), estimate: { source: 'pestana', ...updated.publishedFees } }
  c.renderSummary(updated)
  assert.equal(load(c.state.summary.innerHTML)('.clp-margin-value strong').text(), 'R$ 16.144')
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
  modules.set('#shared/utils/copart-auction-room', { copartAuctionRoomUrl: value => value })
  const { normalizeVehicle, preserveKnownFinalSale } = compile('../layers/cars/server/api/vehicles/ingest.post.ts', '\nexport { normalizeVehicle, preserveKnownFinalSale }\n')
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
  for (const category of ['Camionete', 'Caminhonete', 'Camioneta', 'Camionetes', 'Caminhonetes']) assert.equal((await normalizeVehicle({ ...event, category })).ok, true)
  assert.equal((await normalizeVehicle({ ...event, source: 'copart', category: 'Camionete' })).reason, 'categoria_descartada', 'o vocabulário Pestana não altera as regras Copart')
  const correctedPrice = { price: 45000, soldPrice: 45000 }
  preserveKnownFinalSale({ saleStatus: 'sold', soldPrice: 43900, price: 43900 }, { ...event, bid: 45000 }, correctedPrice)
  assert.equal(correctedPrice.soldPrice, 45000, 'confirmação Pestana sem valor no texto aceita o lance observado corrigido')
  assert.equal((await normalizeVehicle({ ...event, yard: 'MG' })).reason, 'estado_ignorado_mg')
  assert.equal((await normalizeVehicle({ ...event, saleStatus: 'open', message: 'Lance atual' })).reason, 'status_nao_finalizado')
  assert.equal(network.calls, 1, 'índice do pregão é reutilizado')
  network.valid = false
  assert.equal((await normalizeVehicle({ ...event, auctionId: '9999' })).reason, 'identidade_pestana_indisponivel')
})

function resultIngest() {
  const ts = require('typescript'), modules = new Map(), synced = [], messages = [], received = []
  // Identificadores sintéticos em memória: nenhum acesso à base ou ao lote público.
  const doc = { _id: 'favorite-amarok', source: 'pestana', brand: 'VOLKSWAGEN', model: 'Amarok V6 EXTRA AC4', year: 2019,
    url: 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/900112', saleStatus: 'unknown', soldPrice: null,
    fipe: 138137, imageUrls: [], lot: '112', price: 68900 }
  let payload, syncOk = true
  function compile(path, globals = {}) {
    const context = vm.createContext({ exports: {}, URL, Date, TextEncoder, crypto: globalThis.crypto, AbortSignal,
      console: { info() {}, error() {} }, require: id => { assert.ok(modules.has(id), id); return modules.get(id) }, ...globals })
    vm.runInContext(ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, context)
    return context.exports
  }
  const query = value => ({ sort() { return this }, select() { return this }, limit() { return this }, lean: async () => value })
  const VehicleModel = {
    findOne: () => query({ ...doc }), findById: () => query({ ...doc }), find: () => query([{ _id: doc._id }]),
    updateOne: async (_filter, update) => { Object.assign(doc, update.$set); return { matchedCount: 1 } },
    db: { db: { collection: () => ({ find: () => ({ toArray: async () => [{ userId: 'owner', opportunityId: doc._id }] }) }) } },
    collection: { updateOne: async (filter, update) => {
      const key = filter.favoriteResultSharedKey
      if (key?.$ne && doc.favoriteResultSharedKey === key.$ne) return { modifiedCount: 0 }
      Object.assign(doc, update.$set)
      for (const key of Object.keys(update.$unset ?? {})) delete doc[key]
      return { modifiedCount: 1 }
    } },
  }
  modules.set('./pestana-url', compile('../shared/utils/pestana-url.ts'))
  for (const path of ['hash', 'damage', 'vehicle-retention', 'auction-fees']) modules.set(`#shared/utils/${path}`, compile(`../shared/utils/${path}.ts`))
  modules.set('#shared/constants/sources', compile('../shared/constants/sources.ts'))
  modules.set('../../utils/sodre-live-identity', compile('../layers/cars/server/utils/sodre-live-identity.ts'))
  modules.set('../../utils/pestana-live-identity', compile('../layers/cars/server/utils/pestana-live-identity.ts', { fetch() { throw new Error('Sem rede neste teste') } }))
  modules.set('../../utils/live-auction-extension-auth', { assertLiveAuctionExtensionAuthorized: async () => ({ kind: 'service' }) })
  modules.set('../../utils/schemas/vehicle', { VehicleModel })
  modules.set('./schemas/vehicle', { VehicleModel })
  modules.set('./vehicle-market-analysis', { loadMarketHistory: async () => [], buildVehicleMarketAnalysis: () => null })
  modules.set('./picareta-sync', { createPicaretaShortLink: async () => null })
  modules.set('./zapi', { sendVehicleToZApi: async (_vehicle, caption) => { messages.push(caption); return { ok: true } } })
  modules.set('../../utils/favorite-lot-result', compile('../layers/cars/server/utils/favorite-lot-result.ts'))
  modules.set('../../utils/live-vehicle-sync-outbox', { syncLiveVehicleReliably: async item => { synced.push(item); return syncOk } })
  modules.set('../../utils/live-auction-capture', { recordLiveAuctionCapture: async () => true })
  modules.set('#shared/utils/copart-auction-room', {})
  const route = compile('../layers/cars/server/api/vehicles/ingest.post.ts', {
    defineEventHandler: handler => handler, useDb() {}, readBody: async () => payload,
    createError: value => Object.assign(new Error(value.message), value),
  }).default
  return { doc, synced, messages, received, setSyncOk(value) { syncOk = value }, async send(event) {
    payload = event; received.push(event)
    try { return { ok: true, status: 200, body: await route({}) } }
    catch (error) { return { ok: false, status: error.statusCode ?? 500, body: { message: error.message, data: error.data } } }
  } }
}

function amarok(c) {
  c.$('#loteHeader .lote-numero').text('Lote 112')
  c.$('h1.descricao').text('Volkswagen Amarok V6 EXTRA AC4 2019 2019 Diesel')
  for (const [label, value] of [['Marca', 'Volkswagen'], ['Modelo', 'Amarok'], ['Versão', 'V6 EXTRA AC4'], ['Ano', '2019'], ['Mod.', '2019'], ['Tipo', 'Camionete']]) {
    c.$('.carateristica-item').filter((_, node) => c.$(node).text().trim().startsWith(`${label}:`)).text(`${label}: ${value}`)
  }
  c.$('.valorLance').text('R$ 68.900,00')
  const event = c.buildPreviewEvent()
  c.rememberPestanaIdentity(event, 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/900112')
  return c.buildPreviewEvent()
}

test('Pestana: favorito Camionete fecha sem lance visível, chega à API/sync e avisa WhatsApp sem checkbox', async () => {
  const c = reader(), server = resultIngest(), open = amarok(c)
  c.setIngest(server.send)
  c.registerFavoriteLot(open, { isFavorite: true, count: 1 })
  c.captureLocalLot(open, c.getSaveDecision(open))
  c.$('.numeroLanceVencedor').remove()
  c.$('.right').append('<h2>Este lote foi vendido!</h2>')
  const sold = c.buildPreviewEvent()
  assert.equal(sold.bid, null)
  assert.equal(sold.saleStatus, 'sold')
  await c.maybeSaveEvent(sold)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(server.received.length, 1)
  assert.equal(server.received[0].bid, 68900)
  assert.equal(server.received[0].shareFinalResult, false, 'favorito não exige opt-in manual de WhatsApp')
  assert.equal(server.doc.saleStatus, 'sold')
  assert.equal(server.doc.soldPrice, 68900)
  assert.equal(server.synced[0].saleStatus, 'sold')
  assert.equal(server.synced[0].auctionStatus, 'finished')
  assert.equal(server.synced[0].soldPrice, 68900)
  assert.equal(server.messages.length, 1)
  assert.match(server.messages[0], /FAVORITO VENDIDO/)
  assert.match(server.messages[0], /Vendido por: R\$ 68\.900/)
  assert.equal(c.readLocalCaptureItems()[0].saveStatus, 'saved')
  await c.maybeSaveEvent(sold)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(server.messages.length, 1)
})

test('resultado Pestana explícito atualiza condicional já salvo para vendido', async () => {
  const c = reader(), server = resultIngest(), open = amarok(c)
  c.setIngest(server.send)
  c.captureLocalLot(open, c.getSaveDecision(open))
  c.$('.right').append('<h2>Este lote está pendente de homologação!</h2>')
  await c.maybeSaveEvent(c.buildPreviewEvent())
  assert.equal(c.readLocalCaptureItems()[0].lastEvent.saleStatus, 'conditional')
  c.$('.right h2').text('Este lote foi vendido!')
  c.$('.numeroLanceVencedor').remove()
  const sold = c.buildPreviewEvent()
  // O ciclo ativo captura o DOM antes do POST; não pode restaurar o condicional antigo.
  c.captureLocalLot(sold, c.getSaveDecision(sold))
  assert.equal(c.readLocalCaptureItems()[0].lastEvent.saleStatus, 'sold')
  await c.maybeSaveEvent(sold)
  assert.equal(server.doc.saleStatus, 'sold')
  assert.equal(server.synced.at(-1).soldPrice, 68900)
})

test('falha de sincronização não é apresentada como resultado entregue ao Picareta', async () => {
  const c = reader(), server = resultIngest(), open = amarok(c)
  c.setIngest(server.send)
  c.captureLocalLot(open, c.getSaveDecision(open))
  c.$('.right').append('<h2>Este lote foi vendido!</h2>')
  server.setSyncOk(false)
  await c.maybeSaveEvent(c.buildPreviewEvent())
  assert.equal(c.readLocalCaptureItems()[0].saveStatus, 'sync-pending')
  server.setSyncOk(true)
  await c.maybeSaveEvent(c.buildPreviewEvent(), { retryDelivery: true })
  assert.equal(c.readLocalCaptureItems()[0].saveStatus, 'saved')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(server.messages.length, 1, 'retry de sincronização não duplica aviso do favorito')
})
