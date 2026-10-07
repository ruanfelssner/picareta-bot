import assert from 'node:assert/strict'
import test from 'node:test'
import { copartAuctionRoomUrl, findCopartRoomLink } from '../shared/utils/copart-auction-room.js'

const room = 'https://www.copart.com.br/auctionDashboard?auctionDetails=53-9551&auctionId=112097'
const sale = 'https://www.copart.com.br/saleListResult/auctionId/9551'

test('mantém os parâmetros reais da sala Copart e recusa lote/inventário', () => {
  assert.equal(copartAuctionRoomUrl(room), room)
  assert.equal(copartAuctionRoomUrl('/auctionDashboard?auctionDetails=53-9551&auctionId=112097'), room)
  for (const value of [sale, 'https://www.copart.com.br/lot/123', 'https://www.copart.com.br/saleListResult/inventory/53', 'https://www.copart.com.br/auctionDashboard', 'https://evil.test/auctionDashboard?auctionId=112097']) assert.equal(copartAuctionRoomUrl(value), null)
})

test('associa link capturado ao mesmo item sem transformar ID de catálogo em ID de sala', () => {
  assert.equal(findCopartRoomLink([{ roomUrl: room, saleUrls: [sale] }], sale, '9551'), room)
  assert.equal(findCopartRoomLink([{ roomUrl: room, saleUrls: [] }], sale, '9551'), null)
  assert.equal(findCopartRoomLink([{ roomUrl: room, saleUrls: [] }], sale, '112097'), room)
})

test('links de sala ambíguos não abrem um leilão arbitrário', () => {
  assert.equal(findCopartRoomLink([{ roomUrl: room, saleUrls: [sale] }, { roomUrl: room.replace('112097', '112098'), saleUrls: [sale] }], sale, '9551'), null)
  assert.equal(findCopartRoomLink([{ roomUrl: room, saleUrls: [sale] }, { roomUrl: room, saleUrls: [sale] }], sale, '9551'), room)
})
