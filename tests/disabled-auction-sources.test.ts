import assert from 'node:assert/strict'
import test from 'node:test'
import { ACTIVE_AUCTION_SOURCES, SOURCE_META, isAuctionSourceDisabled, assertAuctionSourceEnabled } from '../shared/constants/sources'
import { canSendVehicleToWhatsapp } from '../layers/cars/server/utils/auction-lifecycle'
import type { VehicleRecord } from '../shared/types/vehicle'
import { buildVehicleMarketAnalysis } from '../layers/cars/server/utils/vehicle-market-analysis'

test('Pampa Sul não é selecionável para coleta, mas mantém identidade dos registros antigos', () => {
  assert.equal(ACTIVE_AUCTION_SOURCES.includes('pampasul'), false)
  assert.equal(SOURCE_META.pampasul.name, 'Pampa Sul Leilões')
  assert.equal(isAuctionSourceDisabled('pampasul'), true)
  for (const alias of ['PAMPASUL', 'Pampa Sul', 'Pampa Sul Leilões']) assert.equal(isAuctionSourceDisabled(alias), true)
  assert.throws(() => assertAuctionSourceEnabled('pampasul'), /fonte desativada/i)
  for (const source of ['copart', 'sodre', 'freitas'] as const) {
    assert.ok(ACTIVE_AUCTION_SOURCES.includes(source))
    assert.doesNotThrow(() => assertAuctionSourceEnabled(source))
  }
})

test('Pampa Sul não pode enviar lote ativo ou resultado antigo pelo WhatsApp', () => {
  for (const saleStatus of ['unknown', 'sold', 'conditional', 'not_sold'] as const) {
    assert.equal(canSendVehicleToWhatsapp({ source: 'pampasul', saleStatus } as VehicleRecord), false)
    assert.equal(canSendVehicleToWhatsapp({ source: 'copart', saleStatus } as VehicleRecord), true)
  }
})

test('dados Pampa Sul não alimentam a referência de preço de outras fontes', () => {
  const vehicle = { source: 'copart', brand: 'Volkswagen', model: 'Polo', year: 2022, damage: 'Pequena monta', price: 20_000, fipe: 100_000 } as VehicleRecord
  const history = Array.from({ length: 3 }, () => ({ ...vehicle, source: 'pampasul' as const, saleStatus: 'sold' as const, soldPrice: 50_000 }))
  assert.equal(buildVehicleMarketAnalysis(vehicle, history), null)
})
