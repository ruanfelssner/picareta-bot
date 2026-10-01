import assert from 'node:assert/strict'
import test from 'node:test'
import type { LiveAuctionAuditEvent } from '../shared/types/live-auction-audit'
import type { LiveAuctionLotEvidence } from '../shared/types/live-auction-reconciliation'
import { applyFinalCapturesToExtensionObservations, lotEvidenceFromEvents, parseLocalAuctionEvidence, reconcileLiveAuctionLots } from '../shared/utils/live-auction-reconciliation'

const evidence = (overrides: Partial<LiveAuctionLotEvidence>): LiveAuctionLotEvidence => ({
  origin: 'server_log',
  source: 'copart',
  sessionKey: 'copart:10412',
  auctionId: '10412',
  lot: '83',
  code: '825567',
  status: 'sold',
  amount: 9_200,
  fipe: 42_000,
  damage: 'Pequena monta',
  title: 'Chevrolet Vectra',
  observedAt: '2026-09-29T17:15:31.412Z',
  url: 'https://www.copart.com.br/lot/825567',
  eventId: null,
  ...overrides,
})

const auditEvent = (overrides: Partial<LiveAuctionAuditEvent>): LiveAuctionAuditEvent => ({
  schemaVersion: 1,
  eventId: 'evento-83',
  sessionKey: 'copart:10412',
  source: 'copart',
  auctionId: '10412',
  sessionLabel: 'Copart 10412',
  sequence: 1,
  observedAt: '2026-09-30T14:16:25.000Z',
  rawText: 'Lote 83',
  normalizedText: 'LOTE 83',
  kind: 'message_unclassified',
  lot: '83',
  code: '825567',
  amount: null,
  parserVersion: 1,
  chassisRaw: null,
  chassisNormalized: null,
  vehicleUrl: null,
  description: null,
  consignor: null,
  yard: null,
  extensionVersion: '0.24.0',
  collectorUserId: null,
  deviceId: null,
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
    lots: [{ source: 'copart', auctionId: '10412', lot: '83', code: '825567', saleStatus: 'sold', bid: 9200, fipe: 42_000, damage: 'Pequena monta' }],
  })

  assert.equal(parsed.events.length, 1)
  assert.equal(parsed.lots.filter(item => item.origin === 'local_log').length, 1)
  assert.equal(parsed.lots.find(item => item.origin === 'local_log')?.code, null)
  assert.equal(parsed.lots.filter(item => item.origin === 'local_capture').length, 1)
  assert.equal(parsed.lots.find(item => item.origin === 'local_capture')?.fipe, 42_000)
  assert.equal(parsed.lots.find(item => item.origin === 'local_capture')?.damage, 'Pequena monta')
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
    evidence({ origin: 'server_log', code: null }),
    evidence({ origin: 'local_capture', code: '111' }),
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

test('consolida o log pelo lote mesmo quando o snapshot gravou um código transitório', () => {
  const parsed = parseLocalAuctionEvidence({
    session: { sessionKey: 'copart:10412', source: 'copart', auctionId: '10412' },
    messages: [{
      eventId: 'evento-lote-61', sessionKey: 'copart:10412', source: 'copart', auctionId: '10412',
      sequence: 10, observedAt: '2026-09-30T13:43:07.000Z', rawText: 'Lote 61 vendido por R$ 26.500',
      normalizedText: 'LOTE 61 VENDIDO POR R$ 26500', kind: 'lot_sold', lot: '61', code: 'codigo-do-lote-62', amount: 26_500,
    }],
    lots: [{ source: 'copart', auctionId: '10412', lot: '61', code: 'codigo-correto-61', saleStatus: 'sold', bid: 26_500 }],
  })
  const rows = reconcileLiveAuctionLots(parsed.lots, {
    localLogImported: true,
    localCaptureImported: true,
    publicHistoryAvailable: false,
  })

  assert.equal(rows.length, 1)
  assert.ok(rows[0]?.evidence.local_log)
  assert.ok(rows[0]?.evidence.local_capture)
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

test('aponta FIPE e monta ausentes ou divergentes entre as etapas detalhadas', () => {
  const divergent = reconcileLiveAuctionLots([
    evidence({ origin: 'local_capture', fipe: 42_000, damage: 'Pequena monta' }),
    evidence({ origin: 'extension_observation', fipe: 43_000, damage: 'GRANDE MONTA' }),
  ], { localLogImported: false, localCaptureImported: true, publicHistoryAvailable: false })
  assert.ok(divergent[0]?.issues.includes('fipe_mismatch'))
  assert.ok(divergent[0]?.issues.includes('damage_mismatch'))

  const missing = reconcileLiveAuctionLots([
    evidence({ origin: 'local_capture', fipe: 42_000, damage: 'Pequena monta' }),
    evidence({ origin: 'bot_capture', fipe: null, damage: null }),
  ], { localLogImported: false, localCaptureImported: true, publicHistoryAvailable: false })
  assert.ok(missing[0]?.issues.includes('missing_fipe'))
  assert.ok(missing[0]?.issues.includes('missing_damage'))
})

test('aplica o resultado final do Bot à última observação aberta da extensão', () => {
  const observations = applyFinalCapturesToExtensionObservations([
    evidence({ origin: 'extension_observation', status: 'open', amount: 22_500, observedAt: '2026-09-30T13:49:13.000Z' }),
  ], [
    evidence({ origin: 'bot_capture', status: 'conditional', amount: 5_500, observedAt: '2026-09-30T13:50:01.000Z' }),
  ])

  assert.equal(observations[0]?.origin, 'extension_observation')
  assert.equal(observations[0]?.status, 'conditional')
  assert.equal(observations[0]?.amount, 5_500)
  assert.equal(observations[0]?.observedAt, '2026-09-30T13:50:01.000Z')
})

test('não converte valor ausente em zero e preserva o resultado terminal no log', () => {
  const rows = lotEvidenceFromEvents([
    auditEvent({ eventId: 'final-83', sequence: 10, kind: 'lot_conditional', amount: 4_900 }),
    auditEvent({ eventId: 'generico-83', sequence: 11, kind: 'message_unclassified', amount: null, observedAt: '2026-09-30T14:16:26.000Z' }),
  ], 'server_log')

  assert.equal(rows[0]?.status, 'conditional')
  assert.equal(rows[0]?.amount, 4_900)

  const withoutAmount = lotEvidenceFromEvents([
    auditEvent({ eventId: 'sem-valor', amount: null }),
  ], 'server_log')
  assert.equal(withoutAmount[0]?.amount, null)
})

test('não marca como conferido quando o resultado final falta nos logs', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'local_log', status: null, amount: null }),
    evidence({ origin: 'server_log', status: null, amount: null }),
    evidence({ origin: 'bot_capture', status: 'conditional', amount: 4_900 }),
  ], { localLogImported: true, localCaptureImported: false, publicHistoryAvailable: false })

  assert.ok(rows[0]?.issues.includes('missing_local_result'))
  assert.ok(rows[0]?.issues.includes('missing_server_result'))
})



test('resultado transportado nos dois logs continua alertando capturas ausentes', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'local_log', code: null }), evidence({ origin: 'server_log', code: null }),
  ], { localLogImported: true, localCaptureImported: true, publicHistoryAvailable: true })
  assert.ok(rows[0]?.issues.includes('missing_local_capture'))
  assert.ok(rows[0]?.issues.includes('missing_bot_capture'))
  assert.ok(rows[0]?.issues.includes('missing_public_history'))
})

test('resultado observado sem snapshot local também alerta falta de captura', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'server_log', code: null }), evidence({ origin: 'extension_observation' }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })
  assert.ok(rows[0]?.issues.includes('missing_bot_capture'))
  assert.ok(rows[0]?.issues.includes('missing_public_history'))
  assert.ok(!rows[0]?.issues.includes('missing_local_capture'))
})

test('descarte explícito pelos filtros não exige captura ou histórico público', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'server_log', code: null }), evidence({ origin: 'local_capture', captureExpected: false }),
  ], { localLogImported: false, localCaptureImported: true, publicHistoryAvailable: true })
  assert.ok(!rows[0]?.issues.includes('missing_bot_capture'))
  assert.ok(!rows[0]?.issues.includes('missing_public_history'))
})

test('lote zero fica sem identificação e com alerta sem ser associado ao veículo atual', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'server_log', lot: '0', code: null, url: null, eventId: 'lote-zero', amount: 7173 }),
    evidence({ origin: 'extension_observation', lot: '3', code: '761756', status: 'open', amount: null }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })
  assert.equal(rows.length, 2)
  const zero = rows.find(row => row.evidence.server_log)
  assert.equal(zero?.lot, null)
  assert.ok(zero?.issues.includes('unidentified_lot'))
})

test('reúne lote concatenado e log oficial só quando o código comprova o sufixo', () => {
  for (const [lot, code] of [['181', '1157562'], ['180', '1159817'], ['176', '1144068']]) {
    const rows = reconcileLiveAuctionLots([
      evidence({ origin: 'server_log', lot, code: null }),
      evidence({ origin: 'extension_observation', lot: lot + code, code }),
    ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.lot, lot)
    assert.ok(rows[0]?.issues.includes('missing_bot_capture'))
  }
  const unknown = reconcileLiveAuctionLots([
    evidence({ origin: 'extension_observation', lot: '1811157562', code: null, url: null }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })
  assert.equal(unknown[0]?.lot, '1811157562')
})


test('log legado concatenado depende de captura independente na mesma sessão para ser normalizado', () => {
  const rows = reconcileLiveAuctionLots([
    evidence({ origin: 'server_log', lot: '1811157562', code: null, url: null }),
    evidence({ origin: 'extension_observation', lot: '1811157562', code: '1157562', url: null }),
  ], { localLogImported: false, localCaptureImported: false, publicHistoryAvailable: true })
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.lot, '181')
  assert.equal(rows[0]?.evidence.server_log?.code, null)
})
