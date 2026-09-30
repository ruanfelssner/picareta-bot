import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveAuctionLotEvidence } from '../shared/types/live-auction-reconciliation'
import { parseLocalAuctionEvidence, reconcileLiveAuctionLots } from '../shared/utils/live-auction-reconciliation'

const evidence = (overrides: Partial<LiveAuctionLotEvidence>): LiveAuctionLotEvidence => ({
  origin: 'server_log',
  source: 'copart',
  sessionKey: 'copart:10412',
  auctionId: '10412',
  lot: '83',
  code: '825567',
  status: 'sold',
  amount: 9_200,
  title: 'Chevrolet Vectra',
  observedAt: '2026-09-29T17:15:31.412Z',
  url: 'https://www.copart.com.br/lot/825567',
  eventId: null,
  ...overrides,
})

test('lê conjuntamente a exportação de log e os lotes locais', () => {
  const parsed = parseLocalAuctionEvidence({
    session: { sessionKey: 'copart:10412', source: 'copart', auctionId: '10412' },
    messages: [{
      eventId: 'evento-com-identificador-valido', sessionKey: 'copart:10412', source: 'copart', auctionId: '10412',
      sequence: 10, observedAt: '2026-09-29T17:15:31.412Z', rawText: 'Lote 83 vendido por R$ 9.200',
      normalizedText: 'LOTE 83 VENDIDO POR R$ 9200', kind: 'lot_sold', lot: '83', code: '825567', amount: 9200,
    }],
    lots: [{ source: 'copart', auctionId: '10412', lot: '83', code: '825567', saleStatus: 'sold', bid: 9200 }],
  })

  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.lots.filter(item => item.origin === 'local_log').length, 1)
  assert.equal(parsed.lots.filter(item => item.origin === 'local_capture').length, 1)
  assert.deepEqual(parsed.sessionKeys, ['copart:10412'])
})

test('identifica ausência no histórico e divergência de valor', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'local_capture' }),
    evidence({ origin: 'server_log' }),
    evidence({ origin: 'bot_capture', amount: 9_500 }),
  ], { localLogImported: false, localCaptureImported: true, publicHistoryAvailable: true })

  assert.equal(rows.length, 1)
  assert.ok(rows[0]?.issues.includes('missing_public_history'))
  assert.ok(rows[0]?.issues.includes('amount_mismatch'))
})

test('não acusa fontes locais quando nenhum arquivo foi importado', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'server_log' }),
    evidence({ origin: 'bot_capture' }),
    evidence({ origin: 'public_history' }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })

  assert.deepEqual(rows[0]?.issues, [])
})

test('não consolida códigos de veículo diferentes pelo mesmo número de lote', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'server_log', code: '111' }),
    evidence({ origin: 'public_history', code: '222' }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })

  assert.equal(rows.length, 2)
})

test('consolida a mesma sessão sem diferenciar maiúsculas e minúsculas', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'local_capture', code: null, sessionKey: 'vipleiloes:300926BSPI' }),
    evidence({ origin: 'server_log', code: null, sessionKey: 'vipleiloes:300926bspi' }),
  ], { localLogImported: false, localCaptureImported: true, publicHistoryAvailable: true })

  assert.equal(rows.length, 1)
})

test('não exige captura final ou histórico público enquanto o lote está aberto', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'local_capture', status: 'open' }),
    evidence({ origin: 'server_log', status: null }),
    evidence({ origin: 'extension_observation', status: 'open' }),
  ], { localLogImported: true, localCaptureImported: true, publicHistoryAvailable: true })

  assert.ok(!rows[0]?.issues.includes('missing_bot_capture'))
  assert.ok(!rows[0]?.issues.includes('missing_public_history'))
})

test('ordena os lotes pela evidência mais recente primeiro', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ lot: '10', code: '10', observedAt: '2026-09-30T12:00:00.000Z' }),
    evidence({ lot: '11', code: '11', observedAt: '2026-09-30T12:05:00.000Z' }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: false })

  assert.deepEqual(rows.map(row => row.lot), ['11', '10'])
})

