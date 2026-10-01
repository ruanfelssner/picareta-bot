import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')
const stylesheet = readFileSync(new URL('../.extension/copart-live-collector/content.css', import.meta.url), 'utf8')
const ingestRoute = readFileSync(new URL('../layers/cars/server/api/vehicles/ingest.post.ts', import.meta.url), 'utf8')
const storageKey = 'liveAuctionCollector:copart:capturedLots:v1'
const plain = value => JSON.parse(JSON.stringify(value))

function collector() {
  const storage = new Map()
  const sent = []
  const window = { addEventListener() {} }
  const context = vm.createContext({
    window,
    URL,
    location: { href: 'https://www.copart.com.br/auctionDashboard?auctionId=10412' },
    console: { info() {}, warn() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
  })
  const injected = script.replace('  if (window.top !== window) {', `
    window.test = { state, captureLocalLot, getSaveDecision, maybeSaveEvent,
      readLocalCaptureItems, reconcilePendingChatResults, parseMoney, saveIgnoredEditsLocally,
      getIgnoredStoredEvent, getIgnoredBulkLogEntry, normalizeCopartLotIdentity, parseFinalMessage,
      markLocalCaptureResolved,
      setMessages(messages) { getSystemMessages = () => messages; },
      setLogEvents(events) { canSendRuntimeMessage = () => true;
        sendRuntimeMessage = async message => message.type === 'LIVE_AUCTION_LOG_LIST'
          ? { ok: true, body: { events } } : { ok: true }; },
      setSender(sender) { sendIngestEvent = sender; },
    };
    return;
    if (window.top !== window) {`)
  vm.runInContext(injected, context)
  const api = window.test
  api.state.settings = {
    autoSaveStates: ['PR'], allowedCategories: [], ignoredCategories: [],
    allowTrucks: true, allowMotorcycles: true, ignoreLargeDamage: false, requireDetectedState: true,
  }
  api.setSender(async event => {
    sent.push(plain(event))
    return { ok: true, status: 200, body: { accepted: 1, picaretaSynced: true } }
  })
  return { ...api, sent, storage }
}

function lot(number, extra = {}) {
  const code = String(1150000 + number)
  return {
    source: 'copart', auctionId: '10412', lot: String(number), code,
    brand: 'Renault', model: 'CLIO', description: '2011 Renault Clio', category: 'Automóveis',
    yard: 'Curitiba - PR', consignor: 'HDI SEGUROS SA NOVO', saleStatus: 'open',
    bid: 16000, bidRaw: 'R$ 16.000,00', vehicleUrl: `https://www.copart.com.br/lot/${code}`,
    ...extra,
  }
}

test('não confirma Picareta quando somente o Bot aceitou o lote', async () => {
  const c = collector()
  c.setSender(async event => {
    c.sent.push(plain(event))
    return {
      ok: true,
      status: 200,
      body: { accepted: 1, picaretaSynced: false, picaretaSyncError: 'timeout' },
    }
  })

  await c.maybeSaveEvent(lot(33, { saleStatus: 'conditional', message: 'Condicional' }))

  assert.equal(c.state.saveMessage, 'Salvo no Bot · Picareta aguardando sincronização')
  assert.equal(c.state.savedCount, 0)
  assert.equal(c.readLocalCaptureItems()[0].saveStatus, 'sync-pending')
  assert.equal(c.readLocalCaptureItems()[0].status, 'pending')
})

test('salvamento manual sem resultado continua acompanhando o desfecho', async () => {
  const c = collector()
  await c.maybeSaveEvent(lot(32), { manualSave: true })

  const saved = c.readLocalCaptureItems()[0]
  assert.equal(saved.saveStatus, 'saved-pending')
  assert.equal(saved.pendingFinalUpdate, true)
  assert.equal(saved.status, 'pending')
  assert.match(c.state.saveMessage, /aguardando resultado final/)
})

test('migra salvamento manual legado sem resultado para acompanhamento pendente', () => {
  const c = collector()
  const event = { ...lot(32), manualDecision: 'save' }
  c.storage.set(storageKey, JSON.stringify([{
    ...event,
    _id: 'local:legacy',
    identityKey: `copart:code:${event.code}`,
    status: 'approved',
    saveStatus: 'saved',
    resolvedAt: '2026-09-29T18:10:00.000Z',
    lastEvent: event,
  }]))

  const migrated = c.readLocalCaptureItems()[0]
  assert.equal(migrated.status, 'pending')
  assert.equal(migrated.saveStatus, 'saved-pending')
  assert.equal(migrated.pendingFinalUpdate, true)
  assert.equal(migrated.resolvedAt, undefined)
})

test('não mistura veículos com códigos diferentes que reutilizam temporariamente o mesmo lote', () => {
  const c = collector()
  const kwid = lot(31, { code: '1123666', model: 'KWID', vehicleUrl: 'https://www.copart.com.br/lot/1123666' })
  const clioDuringTransition = lot(31, { code: '1150283', model: 'CLIO', vehicleUrl: 'https://www.copart.com.br/lot/1150283' })

  c.captureLocalLot(kwid, c.getSaveDecision(kwid))
  c.captureLocalLot(clioDuringTransition, c.getSaveDecision(clioDuringTransition))

  const items = c.readLocalCaptureItems()
  assert.equal(items.length, 2)
  assert.deepEqual(new Set(items.map(item => item.code)), new Set(['1123666', '1150283']))
})

test('resultado do chat usa a captura original quando há identidade transitória duplicada', async () => {
  const c = collector()
  const kwid = lot(31, { code: '1123666', model: 'KWID', vehicleUrl: 'https://www.copart.com.br/lot/1123666' })
  const clioDuringTransition = lot(31, { code: '1150283', model: 'CLIO', vehicleUrl: 'https://www.copart.com.br/lot/1150283' })
  c.captureLocalLot(kwid, c.getSaveDecision(kwid))
  await new Promise(resolve => setTimeout(resolve, 5))
  c.captureLocalLot(clioDuringTransition, c.getSaveDecision(clioDuringTransition))
  c.setMessages(['Sistema: Lote 31 vendido por R$ 16.500,00'])

  await c.reconcilePendingChatResults(clioDuringTransition)

  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].code, '1123666')
  assert.equal(c.sent[0].model, 'KWID')
  assert.equal(c.sent[0].bid, 16500)
})

test('backend não preserva resultado final identificado para outro número de lote', () => {
  assert.match(ingestRoute, /existingResultLot\s*&&\s*incomingLot\s*&&\s*existingResultLot\s*!==\s*incomingLot/)
})

test('histórico local usa a chave esperada pela extensão', () => {
  const c = collector()
  c.captureLocalLot(lot(1), c.getSaveDecision(lot(1)))
  assert.ok(c.storage.has(storageKey))
})

test('FIPE digitada sem separador preserva todos os dígitos', () => {
  const c = collector()

  assert.equal(c.parseMoney('29343'), 29343)
  assert.equal(c.parseMoney('R$ 29.343,00'), 29343)
})

test('salvar alterações atualiza somente o JSON local e marca Sync pendente', async () => {
  const c = collector()
  const event = lot(53, { fipe: null, fipeRaw: null })
  c.captureLocalLot(event, c.getSaveDecision(event))
  const item = c.readLocalCaptureItems()[0]

  const result = c.saveIgnoredEditsLocally(item, {
    ...item.lastEvent,
    fipe: c.parseMoney('29343'),
    fipeRaw: 'R$ 29.343',
    manualDecision: 'save',
  })

  const stored = c.readLocalCaptureItems()[0]
  assert.equal(result.persisted, true)
  assert.equal(stored.fipe, 29343)
  assert.equal(stored.lastEvent.fipe, 29343)
  assert.equal(stored.saveStatus, 'local-edits-pending-sync')
  assert.equal(stored.status, 'pending')
  assert.equal(stored.resolvedAt, undefined)
  assert.equal(c.sent.length, 0)

  await c.maybeSaveEvent({ ...event, fipe: 100, fipeRaw: 'R$ 100' })
  assert.equal(c.sent.length, 0)
  assert.equal(c.readLocalCaptureItems()[0].fipe, 29343)
})

test('lista e modal usam uma única ação explícita de Sync por lote', () => {
  assert.match(script, /data-role="ignored-sync"/)
  assert.doesNotMatch(script, /data-role="ignored-reprocess"/)
  assert.doesNotMatch(script, /data-role="ignored-recapture"/)
  assert.doesNotMatch(script, /title="Lote salvo"/)
})

test('Sync pela lista transforma a ação em decisão manual explícita', () => {
  const c = collector()
  const event = lot(176, { saleStatus: 'open', decisionMode: 'auto', manualDecision: 'auto' })
  c.captureLocalLot(event, c.getSaveDecision(event))

  const eventToSync = c.getIgnoredStoredEvent(c.readLocalCaptureItems()[0])
  assert.equal(eventToSync.saleStatus, 'open')
  assert.equal(eventToSync.manualDecision, 'save')
  assert.equal(eventToSync.decisionMode, 'manual')
})

test('reprocessamento exibe log detalhado e separa visualmente os botões', () => {
  const c = collector()
  const entry = c.getIgnoredBulkLogEntry(lot(176), { status: 'skipped', message: 'Ignorado: status_nao_finalizado' })

  assert.equal(entry.status, 'skipped')
  assert.match(entry.label, /Lote 176/)
  assert.match(script, /Ver logs \(\$\{state\.ignoredBulkLogs\.length\}\)/)
  assert.match(stylesheet, /\.clp-ignored-heading-actions\s*\{[^}]*gap:\s*8px/s)
})


test('corrige lotes já salvos conforme os quatro resultados reportados na Copart', async () => {
  const c = collector()
  const cases = [
    { number: 165, code: '1067057', oldStatus: 'not_sold', oldBid: 4000, status: 'sold', bid: 7194 },
    { number: 52, code: '1164865', oldStatus: 'not_sold', oldBid: null, status: 'sold', bid: 15883 },
    { number: 122, code: '1158175', oldStatus: 'not_sold', oldBid: 8500, status: 'sold', bid: 11467 },
    { number: 114, code: '1137596', oldStatus: 'conditional', oldBid: 9000, status: 'conditional', bid: 4000 },
  ]
  for (const item of cases) {
    const event = lot(item.number, { code: item.code, vehicleUrl: `https://www.copart.com.br/lot/${item.code}`,
      saleStatus: item.oldStatus, bid: item.oldBid, message: item.oldStatus === 'conditional' ? `Sistema: Venda condicional para o lote ${item.number} por R$ 9.000,00` : `Sistema: Lote ${item.number} não foi vendido` })
    await c.maybeSaveEvent(event)
  }
  // Reproduz JSON legado que concatenava lote + código antes da correção.
  const values = c.readLocalCaptureItems()
  for (const value of values) {
    value.lot = `${value.lot}${value.code}`
    value.lastEvent.lot = value.lot
  }
  c.storage.set(storageKey, JSON.stringify(values))
  c.sent.length = 0
  c.setMessages([
    'Sistema: Lote 165 não foi vendido',
    'Sistema: Lote 52 não foi vendido',
    'Sistema: Lote 122 não foi vendido',
    'Sistema: Venda condicional para o lote 114 por R$ 9.000,00',
    'Sistema: Lote 165 vendido por R$ 7.194,00',
    'Sistema: Lote 52 vendido por R$ 15.883,00',
    'Sistema: Lote 122 vendido por R$ 11.467,00',
    'Sistema: Venda condicional para o lote 114 por R$ 4.000,00',
  ])
  await c.reconcilePendingChatResults(lot(170))
  assert.equal(c.sent.length, 4)
  for (const item of cases) {
    const sent = c.sent.find(event => event.code === item.code)
    const local = c.readLocalCaptureItems().find(event => event.code === item.code)
    assert.equal(sent.lot, String(item.number))
    assert.equal(sent.saleStatus, item.status)
    assert.equal(sent.bid, item.bid)
    assert.equal(local.lot, String(item.number))
    assert.equal(local.lastEvent.saleStatus, item.status)
    assert.equal(local.lastEvent.bid, item.bid)
    assert.equal(local.saveStatus, 'saved')
  }
  await c.reconcilePendingChatResults(lot(170))
  assert.equal(c.sent.length, 4, 'reler o chat não reenvia correções já sincronizadas')
})

test('última mensagem prevalece sem enviar resultados antigos durante a releitura', async () => {
  const c = collector()
  await c.maybeSaveEvent(lot(165, { saleStatus: 'not_sold', message: 'Sistema: Lote 165 não foi vendido' }))
  c.sent.length = 0
  c.setMessages(['Sistema: Lote 165 não foi vendido', 'Sistema: Lote 165 vendido por R$ 7.194,00'])
  await c.reconcilePendingChatResults(lot(166))
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].saleStatus, 'sold')
  // O painel ainda exibe o estado/valor antigos: não pode voltar a enviá-los.
  await c.maybeSaveEvent(lot(165, { saleStatus: 'not_sold', bid: 4000, message: 'Repasse' }))
  assert.equal(c.sent.length, 1)
  assert.equal(c.readLocalCaptureItems().find(item => item.lot === '165').lastEvent.bid, 7194)
})

test('não reconcilia mensagem de outra sessão nem divide código não comprovado', async () => {
  const c = collector()
  await c.maybeSaveEvent(lot(165, { auctionId: 'outra-sessao', saleStatus: 'not_sold' }))
  c.sent.length = 0
  c.setMessages(['Sistema: Lote 165 vendido por R$ 7.194,00'])
  await c.reconcilePendingChatResults(lot(166))
  assert.equal(c.sent.length, 0)
  assert.equal(c.normalizeCopartLotIdentity('1651067057', '1067057'), '165')
  assert.equal(c.normalizeCopartLotIdentity('1651067057', '9999999'), '1651067057')
  assert.equal(c.normalizeCopartLotIdentity('1067057', '1067057'), '1067057')
})

test('mensagem final usa o valor depois de por, não outro valor anterior no texto', () => {
  const c = collector()
  assert.equal(c.parseFinalMessage('Sistema: Taxa R$ 100,00 | Venda condicional para o lote 114 por R$ 4.000,00').bidRaw, 'R$ 4.000,00')
})


test('log persistido corrige lote salvo mesmo quando a mensagem já saiu do chat', async () => {
  const c = collector()
  const old = 'Sistema: Lote 165 não foi vendido'
  await c.maybeSaveEvent(lot(165, { saleStatus: 'not_sold', bid: 4000, message: old }))
  c.sent.length = 0
  c.setMessages([old])
  c.setLogEvents([
    { sessionKey: 'copart:10412', rawText: old, observedAt: '2026-10-01T14:41:24Z', sequence: 1 },
    { sessionKey: 'copart:10412', rawText: 'Sistema: Lote 165 vendido por R$ 7.194,00', observedAt: '2026-10-01T14:49:27Z', sequence: 2 },
    { sessionKey: 'copart:outra', rawText: 'Sistema: Lote 165 vendido por R$ 100.000,00', observedAt: '2026-10-01T14:50:00Z', sequence: 3 },
  ])
  await c.reconcilePendingChatResults(lot(166))
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].saleStatus, 'sold')
  assert.equal(c.sent[0].bid, 7194)
  assert.equal(c.sent[0].observedAt, '2026-10-01T14:49:27.000Z')
  await c.reconcilePendingChatResults(lot(166))
  assert.equal(c.sent.length, 1)
})


test('lote zero não é válido e não é reconciliado com o lote atual', async () => {
  const c = collector()
  assert.equal(c.normalizeCopartLotIdentity('0', null), null)
  assert.equal(c.normalizeCopartLotIdentity('000', '1157562'), null)
  await c.maybeSaveEvent(lot(181, { saleStatus: 'not_sold' }))
  c.sent.length = 0
  c.setMessages(['Sistema: Lote 0 vendido por R$ 7.173,00'])
  await c.reconcilePendingChatResults(lot(182))
  assert.equal(c.sent.length, 0)
})
