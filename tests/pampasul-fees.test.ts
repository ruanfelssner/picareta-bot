import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateVehicleFees, formatVehicleFeeEstimateTitle } from '../shared/utils/auction-fees.js'

const vehicle = { source: 'pampasul', price: 88_900, soldPrice: null, brand: 'BMW', model: 'SERIE 3',
  title: 'BMW SERIE 3', description: '', damage: null, fipe: 199_761,
} as const

test('Pampa Sul usa comissão e pátio próprios, sem DSAL, logística ou operacionais de outra fonte', () => {
  const result = estimateVehicleFees(vehicle)!
  assert.equal(result.commission, 4445)
  assert.equal(result.yardFee, 800)
  assert.equal(result.feesTotal, 5245)
  assert.equal(result.total, 94145)
  assert.equal(result.dsal, 0)
  assert.equal(result.logistics, 0)
  assert.equal(result.fixedFees, 0)
  assert.match(formatVehicleFeeEstimateTitle(result)!, /Comissão 5%: R\$ 4\.445.*Taxa do pátio: R\$ 800/)
  assert.doesNotMatch(formatVehicleFeeEstimateTitle(result)!, /DSAL|Logística|Operacionais/)
})

test('simulação e preço vendido atualizam comissão e total', () => {
  assert.equal(estimateVehicleFees(vehicle, 89_900)!.feesTotal, 5295)
  assert.equal(estimateVehicleFees({ ...vehicle, soldPrice: 100_000 })!.feesTotal, 5800)
})

test('lance com centavos mantém precisão monetária na comissão e no total', () => {
  const result = estimateVehicleFees(vehicle, 88_900.49)!
  assert.equal(result.basePrice, 88_900.49)
  assert.equal(result.commission, 4445.02)
  assert.equal(result.feesTotal, 5245.02)
  assert.equal(result.total, 94_145.51)
})

test('preço ausente ou inválido não fabrica estimativa; regras anteriores permanecem', () => {
  for (const price of [null, 0, -1, NaN, Infinity]) assert.equal(estimateVehicleFees({ ...vehicle, price }), null)
  assert.equal(estimateVehicleFees({ ...vehicle, source: 'vs-veiculos' })!.feesTotal, 800)
  assert.equal(estimateVehicleFees({ ...vehicle, source: 'copart' })!.feesTotal, 9705)
  assert.equal(estimateVehicleFees({ ...vehicle, source: 'pestana' }), null)
})
