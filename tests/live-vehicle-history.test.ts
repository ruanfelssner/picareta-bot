import assert from 'node:assert/strict'
import test from 'node:test'
import { buildLiveDamageHistory, completeLiveChassis, conflictingLiveChassis, liveDamageObservedAt, liveOccurrenceExternalId, liveVehicleSyncIdentity, sameLiveOccurrence } from '../shared/utils/live-vehicle-history'
import type { VehicleRecord } from '../shared/types/vehicle'

export function vehicle(overrides: Partial<VehicleRecord> = {}): Partial<VehicleRecord> {
  return {
    source: 'copart', externalId: 'extension-old', collectedVia: 'extension', url: 'https://www.copart.com.br/lot/12345',
    chassisRaw: '9BWZZZ377VT004251', chassisNormalized: '9BWZZZ377VT004251', damage: 'Média monta', lot: '120', auctionId: '10',
    auctionDate: new Date('2026-11-03T15:00:00Z'), scrapedAt: new Date('2026-11-03T16:00:00Z'), saleStatus: 'not_sold',
    ...overrides,
  }
}

test('chassi completo é normalizado sem aceitar máscara, parcial ou placeholders', () => {
  assert.equal(completeLiveChassis('9bw zzz377-vt004251'), '9BWZZZ377VT004251')
  for (const raw of ['9BW*****4251', '00000000000000000', '9BWZZZ377', '9BWZZZ377VT00425I']) assert.equal(completeLiveChassis(raw), null)
  assert.equal(completeLiveChassis('9BW*****4251', '9BWZZZ377VT004251'), null, 'máscara não pode ser removida para fabricar um VIN completo')
  assert.equal(conflictingLiveChassis(vehicle(), vehicle({ chassisRaw: '9BWZZZ377VT004252' })), true)
})

test('o mesmo carro tem ocorrências diferentes por pregão, data ou lote, sem depender do chassi', () => {
  const first = vehicle()
  assert.equal(sameLiveOccurrence(first, vehicle({ auctionDate: new Date('2026-11-03T17:00:00Z') })), true)
  for (const next of [vehicle({ lot: '87' }), vehicle({ auctionId: '20' }), vehicle({ auctionDate: new Date('2026-11-10T15:00:00Z') })]) {
    assert.notEqual(liveOccurrenceExternalId(first), liveOccurrenceExternalId(next))
    assert.equal(sameLiveOccurrence(first, next), false)
  }
})

test('instante da classificação permanece nas recapturas e muda na alteração/reversão', () => {
  const first = vehicle()
  const recaptured = vehicle({ scrapedAt: new Date('2026-11-03T17:00:00Z') })
  assert.equal(liveDamageObservedAt(first, recaptured).toISOString(), '2026-11-03T16:00:00.000Z')
  const changed = vehicle({ damage: 'Grande monta', scrapedAt: new Date('2026-11-03T18:00:00Z') })
  changed.damageObservedAt = liveDamageObservedAt(first, changed)
  assert.equal(changed.damageObservedAt.toISOString(), '2026-11-03T18:00:00.000Z')
  changed.damageHistory = buildLiveDamageHistory(first, changed)
  const reversed = vehicle({ scrapedAt: new Date('2026-11-03T19:00:00Z') })
  reversed.damageObservedAt = liveDamageObservedAt(changed, reversed)
  const history = buildLiveDamageHistory(changed, reversed)
  assert.deepEqual(history.map(point => point.damage), ['Média monta', 'Grande monta', 'Média monta'])
  assert.equal(new Set(history.map(point => point.damageObservedAt)).size, 3)
  assert.ok(history.every(point => !('expiresAt' in point) && !('lastCapturedBy' in point)))
})

test('fila separa montas e ocorrências, permitindo reunir somente recapturas equivalentes', () => {
  const before = { ...vehicle(), damageObservedAt: '2026-11-03T16:00:00Z' }
  const changed = { ...before, damage: 'Grande monta', damageObservedAt: '2026-11-03T17:00:00Z' }
  const nextAuction = { ...before, auctionId: '20' }
  assert.equal(new Set([before, changed, nextAuction].map(liveVehicleSyncIdentity)).size, 3)
  assert.equal(liveVehicleSyncIdentity(before), liveVehicleSyncIdentity({ ...before, scrapedAt: new Date('2026-11-03T17:00:00Z') }))
})
