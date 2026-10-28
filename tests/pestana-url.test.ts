import assert from 'node:assert/strict'
import test from 'node:test'
import { pestanaIdentityUrl, pestanaLotUrl, pestanaUrlAliases } from '../shared/utils/pestana-url'
import { buildExternalId, sha1 } from '../shared/utils/hash'
import { formatAuctionCardCaption, type AuctionVehicle } from '../src/formatters/auction-card'

const old = 'https://www.pestanaleiloes.com.br/lote/6262/443345'
const current = 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6262/443345'

test('corrige a navegação da Pestana preservando os IDs oficiais e aceitando slug opcional', () => {
  assert.equal(pestanaLotUrl(old), current)
  assert.equal(pestanaLotUrl(current), current)
  assert.equal(pestanaLotUrl('https://www.pestanaleiloes.com.br/agenda-de-leiloes/6289/443208/honda-hr-v-advance-2023-2024-gas-alc'), 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6289/443208')
  assert.deepEqual(pestanaUrlAliases(current), [current, old])
})

test('a correção da URL não muda o externalId Nuxt nem a base da identidade cloud', async () => {
  assert.equal(await buildExternalId('pestana', current), await sha1('pestana' + old))
  assert.equal(await buildExternalId('pestana', current + '/titulo-corrigido'), await buildExternalId('pestana', old))
  assert.equal(pestanaIdentityUrl(current), old)
  assert.notEqual(await buildExternalId('pestana', current), await buildExternalId('pestana', current.replace('6262', '6289')))
  assert.equal(await buildExternalId('copart', old), await sha1('copart' + old))
})

test('não reinterpreta salas, catálogo, hosts semelhantes, credenciais ou protocolos distintos', () => {
  for (const url of ['https://www.pestanaleiloes.com.br/6289/aovivo', 'https://www.pestanaleiloes.com.br/agenda-de-leiloes/6289', 'https://pestanaleiloes.com.br.evil.test/lote/6262/443345', 'https://user:pass@www.pestanaleiloes.com.br/lote/6262/443345', 'http://www.pestanaleiloes.com.br/lote/6262/443345', 'https://www.pestanaleiloes.com.br/lote/6262/443345/extra/path', '']) {
    assert.equal(pestanaLotUrl(url), url)
    assert.equal(pestanaIdentityUrl(url), url)
    assert.deepEqual(pestanaUrlAliases(url), [url])
  }
})

test('a legenda CLI de um registro antigo já aponta para a rota válida', () => {
  const vehicle: AuctionVehicle = { source: 'pestana', brand: 'VOLKSWAGEN', model: 'Saveiro', year: 2007, damage: null, price: null, priceRaw: null, imageUrls: [], description: '', url: old, auctionDate: null }
  assert.match(formatAuctionCardCaption(vehicle), /https:\/\/www\.pestanaleiloes\.com\.br\/agenda-de-leiloes\/6262\/443345/)
})
