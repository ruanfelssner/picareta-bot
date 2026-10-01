import assert from 'node:assert/strict'
import test from 'node:test'
import { isSameLiveAssistantLot } from '../layers/cars/server/utils/live-assistant-lot-identity'

const input = { source: 'copart', code: '1163026', vehicleUrl: null, auctionId: '10477', lot: '51' }
const candidate = { source: 'copart', url: 'https://www.copart.com.br/lot/9999999', title: 'BMW SERIE 3', description: '2022 BMW', auctionId: '10476', lot: '51' }

test('BMW de outro lote não fornece identidade para moto BMW mesmo com lote 51', () => {
  assert.equal(isSameLiveAssistantLot(input, candidate), false)
})
test('código oficial integral identifica o registro e rejeita coincidência parcial', () => {
  assert.equal(isSameLiveAssistantLot(input, { ...candidate, url: 'https://www.copart.com.br/lot/1163026' }), true)
  assert.equal(isSameLiveAssistantLot(input, { ...candidate, url: 'https://www.copart.com.br/lot/11630260' }), false)
})
test('código informado prevalece sobre leilão/lote ou URL coincidentes', () => {
  assert.equal(isSameLiveAssistantLot({ ...input, vehicleUrl: candidate.url }, { ...candidate, auctionId: input.auctionId }), false)
})
test('sem código aceita URL exata ou leilão e lote completos, nunca lote isolado', () => {
  assert.equal(isSameLiveAssistantLot({ ...input, code: null, vehicleUrl: candidate.url }, candidate), true)
  assert.equal(isSameLiveAssistantLot({ ...input, code: null }, { ...candidate, auctionId: input.auctionId }), true)
  assert.equal(isSameLiveAssistantLot({ ...input, code: null }, candidate), false)
  assert.equal(isSameLiveAssistantLot({ ...input, code: null, auctionId: null }, { ...candidate, auctionId: null }), false)
})
test('não associa código de outra origem', () => {
  assert.equal(isSameLiveAssistantLot(input, { ...candidate, source: 'sodre', description: input.code }), false)
})
