import assert from 'node:assert/strict'
import test from 'node:test'
import { enrichPublicAuctionFipe } from '../layers/cars/server/utils/public-auction-fipe.js'

test('FIPE Vardana consulta referência ausente, preserva valor publicado e reutiliza cache', async () => {
  const originalFetch = globalThis.fetch
  const keys = ['FIPE_API_BASE_URL', 'FIPE_API_ENABLED', 'MONGO_DATA_URI', 'MONGO_URI'] as const
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  process.env.FIPE_API_BASE_URL = 'https://fipe-auction.test/api/v2'
  process.env.FIPE_API_ENABLED = 'true'
  delete process.env.MONGO_URI
  delete process.env.MONGO_DATA_URI
  let detailCalls = 0
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname
    if (path.endsWith('/references')) return new Response(JSON.stringify([{ code: 300, month: 'outubro/2026' }]))
    if (path.endsWith('/brands')) return new Response(JSON.stringify([{ code: '23', name: 'Mercedes-Benz' }]))
    if (path.endsWith('/models')) return new Response(JSON.stringify([{ code: '999', name: 'GLA 200 FF' }]))
    if (path.endsWith('/years')) return new Response(JSON.stringify([{ code: '2018-1', name: '2018 Gasolina' }]))
    detailCalls++
    return new Response(JSON.stringify({ price: 'R$ 120.000,00', modelYear: 2018, brand: 'Mercedes-Benz', model: 'GLA 200 FF', fuel: 'Gasolina', codeFipe: '001234-5', referenceMonth: 'outubro/2026' }))
  }
  try {
    const vehicles = [{ brand: 'MERCEDES-BENZ', model: 'GLA 200 FF', year: 2018, fipe: null }, { brand: 'MERCEDES-BENZ', model: 'GLA 200 FF', year: 2018, fipe: 110_000 }]
    const enriched = await enrichPublicAuctionFipe(vehicles, () => {})
    assert.equal(enriched[0]!.fipe, 120_000)
    assert.equal(enriched[0]!.fipeCode, '001234-5')
    assert.equal(enriched[1]!.fipe, 110_000)
    await enrichPublicAuctionFipe(vehicles, () => {})
    assert.equal(detailCalls, 1)
    const differentYear = await enrichPublicAuctionFipe([{ ...vehicles[0]!, year: 2017 }], () => {})
    assert.equal(differentYear[0]!.fipe, null)
    process.env.FIPE_API_ENABLED = 'false'
    const original = await enrichPublicAuctionFipe(vehicles, () => {})
    assert.deepEqual(original, vehicles)
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) { if (saved[key] == null) delete process.env[key]; else process.env[key] = saved[key] }
  }
})
