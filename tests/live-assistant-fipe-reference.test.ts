import assert from 'node:assert/strict'
import test from 'node:test'
import {
  selectLiveAssistantFipeReference,
  type LiveAssistantFipeCandidate,
} from '../layers/cars/server/utils/live-assistant-fipe-reference'

const target = {
  id: 'current-lot',
  brand: 'Volkswagen',
  model: 'Polo',
  year: 2022,
  fuel: null,
}

const candidate = (overrides: Partial<LiveAssistantFipeCandidate> = {}): LiveAssistantFipeCandidate => ({
  id: 'base-lot',
  brand: 'VW',
  model: 'Polo',
  year: 2022,
  fipe: 70_000,
  checkedAt: '2026-09-10T12:00:00.000Z',
  ...overrides,
})

test('reaproveita FIPE da base para a mesma marca, modelo e ano-modelo', () => {
  const reference = selectLiveAssistantFipeReference(target, [candidate()])
  assert.equal(reference?.value, 70_000)
  assert.equal(reference?.vehicleId, 'base-lot')
  assert.equal(reference?.label, 'Referência não exata')
})

test('recusa marca, modelo, ano, combustível e motorização incompatíveis', () => {
  for (const record of [
    candidate({ brand: 'Fiat' }),
    candidate({ model: 'Golf' }),
    candidate({ year: 2021 }),
    candidate({ id: 'current-lot' }),
  ]) {
    assert.equal(selectLiveAssistantFipeReference(target, [record]), null)
  }

  assert.equal(selectLiveAssistantFipeReference({ ...target, model: 'Polo 1.6' }, [candidate({ model: 'Polo 2.0' })]), null)
  assert.equal(selectLiveAssistantFipeReference({ ...target, fuel: 'Flex' }, [candidate({ fuel: 'Diesel' })]), null)
})

test('usa o menor valor entre versões similares igualmente próximas', () => {
  const reference = selectLiveAssistantFipeReference(target, [
    candidate({ id: 'highline', model: 'Polo Highline', fipe: 90_000 }),
    candidate({ id: 'comfortline', model: 'Polo Comfortline', fipe: 70_000 }),
  ])
  assert.equal(reference?.vehicleId, 'comfortline')
  assert.equal(reference?.value, 70_000)
})

test('prioriza o modelo exato mesmo quando uma versão similar é mais barata', () => {
  const reference = selectLiveAssistantFipeReference(target, [
    candidate({ id: 'similar', model: 'Polo Comfortline', fipe: 60_000 }),
    candidate({ id: 'exact', fipe: 70_000 }),
  ])
  assert.equal(reference?.vehicleId, 'exact')
})
