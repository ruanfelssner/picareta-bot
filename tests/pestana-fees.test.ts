import assert from 'node:assert/strict'
import test from 'node:test'
import { estimateVehicleFees, formatVehicleFeeEstimateTitle } from '../shared/utils/auction-fees'

const vehicle = { source: 'pestana', price: 15300, soldPrice: null, brand: 'Renault', model: 'Logan',
  title: 'Renault Logan', description: '', damage: null, fipe: 35944 } as const
const terms = { commissionRate: 0.05, operationalExpenses: 2350 }

test('Pestana usa a comissão e as despesas publicadas para calcular o total do exemplo', () => {
  const result = estimateVehicleFees(vehicle, null, terms)!
  assert.equal(result.commission, 765)
  assert.equal(result.operationalExpenses, 2350)
  assert.equal(result.feesTotal, 3115)
  assert.equal(result.total, 18415)
  assert.equal(result.dsal + result.fixedFees + result.logistics, 0)
  assert.equal(vehicle.fipe - result.total, 17529)
  assert.match(formatVehicleFeeEstimateTitle(result)!, /Comissão 5%.*Despesas operacionais/)
  assert.doesNotMatch(formatVehicleFeeEstimateTitle(result)!, /DSAL|Logística/)
})

test('taxas são específicas do lote e acompanham lance atual, simulação e arremate', () => {
  assert.equal(estimateVehicleFees(vehicle, 18000, terms)!.total, 21250)
  assert.equal(estimateVehicleFees(vehicle, 18000, { ...terms, operationalExpenses: 900 })!.total, 19800)
  assert.equal(estimateVehicleFees(vehicle, 18000, { ...terms, commissionRate: 0.1 })!.total, 22150)
  assert.equal(estimateVehicleFees({ ...vehicle, soldPrice: 20000 }, null, terms)!.total, 23350)
  assert.equal(estimateVehicleFees(vehicle, 15300.51, terms)!.total, 18415.54)
})

test('sem taxa completa ou preço válido não inventa cálculo nem usa DSAL', () => {
  for (const value of [null, {}, { commissionRate: 0.05 }, { operationalExpenses: 2350 },
    { ...terms, commissionRate: NaN }, { ...terms, commissionRate: 5 }, { ...terms, operationalExpenses: -1 },
    { ...terms, operationalExpenses: Infinity }, { ...terms, operationalExpenses: '2350' }]) {
    assert.equal(estimateVehicleFees(vehicle, null, value), null)
  }
  for (const price of [null, 0, -1, NaN, Infinity]) assert.equal(estimateVehicleFees({ ...vehicle, price }, null, terms), null)
  assert.equal(estimateVehicleFees({ ...vehicle, source: 'copart' }, null, terms)!.total, 18225)
})
