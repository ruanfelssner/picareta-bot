import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pestanaLiveLotIndex, resolvePestanaLiveIdentity } from '../layers/cars/server/utils/pestana-live-identity'

const lots = JSON.parse(readFileSync('tests/fixtures/pestana-live-identities.json', 'utf8')) as Array<Record<string, unknown>>
const input = { auctionId: '6262', lot: '1', code: null, vehicleUrl: null, description: 'Audi A3 LM 180CV 2013 2014 Gasolina' }

test('resolve o ID global real 443168 por leilão/lote, sem usar o número do lote na URL', async () => {
  const result = await resolvePestanaLiveIdentity(input, async url => {
    assert.equal(String(url), 'https://www.pestanaleiloes.com.br/api/v2/lote/por-leilao?idLeilao=6262')
    return Response.json(lots)
  })
  assert.deepEqual(result, { code: '443168', vehicleUrl: 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443168' })
  assert.equal(pestanaLiveLotIndex(lots, '9999').size, 0)
})

test('recusa catálogo ambíguo, título em transição, ID conflitante, erro e CAPTCHA HTTP 200', async () => {
  const current = lots.find(row => row.numero === input.lot)!
  for (const data of [[current, { ...current, id: 99999 }], []]) await assert.rejects(resolvePestanaLiveIdentity(input, async () => Response.json(data)))
  await assert.rejects(resolvePestanaLiveIdentity({ ...input, description: 'Fiat Cronos' }, async () => Response.json(lots)), /transição/)
  await assert.rejects(resolvePestanaLiveIdentity({ ...input, code: '443168', vehicleUrl: 'https://evil.test/agenda-de-leiloes/6262/443168' }))
  await assert.rejects(resolvePestanaLiveIdentity(input, async () => new Response('erro', { status: 503 })), /HTTP 503/)
  await assert.rejects(resolvePestanaLiveIdentity(input, async () => new Response('<html>CAPTCHA</html>')))
  await assert.rejects(resolvePestanaLiveIdentity(input, async () => Response.json({ lotes: lots })))
})
