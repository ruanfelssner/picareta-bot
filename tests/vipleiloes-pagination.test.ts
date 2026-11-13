import assert from 'node:assert/strict'
import test from 'node:test'
import { vipDelayAfterRateLimit, vipPageLimit } from '../src/scrapers/vipleiloes.js'

test('limite de páginas acompanha o total reportado pelo site', () => {
  // 13/11/2026: PR reportou 529 lotes e a coleta parou nas 40 páginas padrão (472/529).
  assert.ok(vipPageLimit(40, 529) * 12 >= 529)
  assert.equal(vipPageLimit(40, 529), 69)
  assert.equal(vipPageLimit(40, 100), 40)
  assert.equal(vipPageLimit(40, null), 40)
  assert.equal(vipPageLimit(40, 5000), 160)
})

test('cada HTTP 429 aumenta o intervalo entre páginas até o teto', () => {
  assert.equal(vipDelayAfterRateLimit(1_500), 2_250)
  assert.equal(vipDelayAfterRateLimit(2_250), 3_375)
  assert.equal(vipDelayAfterRateLimit(5_000), 6_000)
  assert.equal(vipDelayAfterRateLimit(0), 1_500)
})
