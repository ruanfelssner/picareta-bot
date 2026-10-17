import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveMatch, archivePage, archivePipeline } from '../layers/cars/server/utils/live-auction-archive-query'

test('busca numérica não confunde o leilão 112097 com o código 1120971', () => {
  assert.deepEqual(archiveMatch({ q: '112097' }), {
    $or: [{ auctionId: '112097' }, { lot: '112097' }, { code: '112097' }],
  })
  assert.deepEqual(archiveMatch({ q: 'lote 61' }), { lot: '61' })
  assert.deepEqual(archiveMatch({ q: 'leilão: 112097' }), { auctionId: '112097' })
  assert.deepEqual(archiveMatch({ q: 'codigo #1162845' }), { code: '1162845' })
})

test('link Copart identifica código completo mesmo com query, fragmento e barra final', () => {
  assert.deepEqual(archiveMatch({ q: 'https://www.copart.com.br/lot/1162845/?x=1#fotos' }), { code: '1162845' })
  assert.ok(archiveMatch({ q: 'https://copart.com.br.evil.test/lot/1162845' }).$or)
})

test('busca textual trata caracteres especiais como texto e preserva o escopo da sessão', () => {
  const result = archiveMatch({ q: 'BORA (2.0)+', source: 'copart', sessionKey: 'copart:112097', origin: 'capture' })
  assert.equal(result.sessionKey, 'copart:112097')
  assert.equal(result.source, 'copart')
  assert.equal(result.origin, 'capture')
  const regex = result.$or[0].sessionKey.$regex
  assert.ok(new RegExp(regex, 'i').test('BORA (2.0)+'))
  assert.equal(new RegExp(regex, 'i').test('BORA 200'), false)
})

test('datas de Brasília e filtros continuam aplicados em buscas específicas', () => {
  const from = new Date('2026-10-06T00:00:00-03:00')
  const to = new Date('2026-10-06T23:59:59.999-03:00')
  assert.deepEqual(archiveMatch({ q: 'lote 61', from, to }), { lot: '61', observedAt: { $gte: from, $lte: to } })
  assert.equal(from.toISOString(), '2026-10-06T03:00:00.000Z')
  assert.equal(to.toISOString(), '2026-10-07T02:59:59.999Z')
})

test('todo o histórico não impõe janela de sete dias; paginação rejeita entradas inválidas', () => {
  assert.deepEqual(archiveMatch({}), {})
  for (const value of [undefined, 'NaN', -1, 0, 1.5, Infinity]) assert.equal(archivePage(value), 1)
  assert.equal(archivePage('2'), 2)
  assert.equal(archivePage(100_001), 10_000)
})

test('consulta une fontes preservadas sem depender de existir log bruto', () => {
  const stages = archivePipeline({}, true)
  const sources = stages.filter(stage => stage.$unionWith).map(stage => stage.$unionWith.coll)
  assert.ok(sources.includes('scraped_vehicles'))
  assert.ok(sources.includes('live_auction_capture_observations'))
  assert.ok(sources.includes('auction_sessions'))
  assert.ok(sources.includes('auction_lot_results'))
  assert.ok(sources.includes('live_auction_event_outbox'))
  const serialized = JSON.stringify(stages)
  for (const privateField of ['captureUserIds', 'lastCapturedBy', 'collectorUserId', 'deviceId', 'imageUrls']) assert.equal(serialized.includes(privateField), false)
})
