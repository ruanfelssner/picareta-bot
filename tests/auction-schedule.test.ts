import assert from 'node:assert/strict'
import test from 'node:test'
import { parseBrazilAuctionDate, hasAuctionTime } from '../shared/utils/auction-schedule.js'

test('preserva horário Sodré no fuso brasileiro em workers de qualquer timezone', () => {
  assert.equal(parseBrazilAuctionDate('2026-10-06 13:30:00')?.toISOString(), '2026-10-06T16:30:00.000Z')
  assert.equal(parseBrazilAuctionDate('2026-10-06T13:30:00.123456-03:00')?.toISOString(), '2026-10-06T16:30:00.123Z')
  assert.equal(parseBrazilAuctionDate('2026-10-06T16:30:00Z')?.toISOString(), '2026-10-06T16:30:00.000Z')
  assert.equal(parseBrazilAuctionDate('2026-10-06T13:30:00-03:00')?.toISOString(), '2026-10-06T16:30:00.000Z')
  assert.equal(parseBrazilAuctionDate('2026-10-06')?.toISOString(), '2026-10-06T03:00:00.000Z')
})

test('rejeita datas impossíveis e distingue dia civil de horário confirmado', () => {
  for (const value of ['2026-02-30', '2026-10-06 25:30:00', '2026-10-06 13:60:00', 'inválida']) assert.equal(parseBrazilAuctionDate(value), null)
  assert.equal(hasAuctionTime('2026-10-06'), false)
  assert.equal(hasAuctionTime('2026-10-06 13:30:00'), true)
  assert.equal(hasAuctionTime(1790096400000), true)
})
