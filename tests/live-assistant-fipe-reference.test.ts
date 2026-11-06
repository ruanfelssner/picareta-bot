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


test('Gol 1.0 Sodré encontra GOL Copart pela versão com cilindrada repetida', () => {
  const reference = selectLiveAssistantFipeReference({ ...target, model: 'Gol 1.0', year: 2010 }, [
    candidate({ id: 'correct', model: 'GOL', year: 2010, version: 'Gol 1.0 1.0 Total Flex', fipe: 25_741, source: 'copart' }),
    candidate({ model: 'GOL', year: 2010, version: 'Gol Power 1.6 Total Flex', fipe: 29_742 }),
    candidate({ model: 'GOLF 1.0', year: 2010, fipe: 90_000 }),
  ])
  assert.equal(reference?.value, 25_741)
  assert.equal(reference?.source, 'copart')
  assert.equal(reference?.sampleSize, 1)
  assert.match(reference?.model ?? '', /Total Flex/)
})

test('a descrição completa também identifica o motor quando a versão não está preenchida', () => {
  const reference = selectLiveAssistantFipeReference({ ...target, model: 'Polo 1.0' }, [
    candidate({ description: 'Polo 1.0 Total Flex | Categoria: Automóveis', fipe: 70_000 }),
    candidate({ description: 'Polo 1.6 Total Flex | Categoria: Automóveis', fipe: 90_000 }),
  ])
  assert.equal(reference?.value, 70_000)
})

test('prioriza a observação mais recente da mesma versão em vez do menor valor antigo', () => {
  const reference = selectLiveAssistantFipeReference(target, [candidate({ id: 'old', fipe: 60_000, checkedAt: '2026-08-01' }), candidate()])
  assert.equal(reference?.value, 70_000)
})

test('recusa câmbio, geração, portas e combustível explicitamente conflitantes e motor contraditório', () => {
  for (const [model, version] of [
    ['Polo 1.0 AT', 'Polo 1.0 Manual'], ['Gol G4 1.0', 'Gol G5 1.0'],
    ['Polo 1.0 2p', 'Polo 1.0 4p'], ['Polo 1.0 Diesel', 'Polo 1.0 Total Flex'],
    ['Polo 1.0', 'Polo 1.6'],
  ]) {
    assert.equal(selectLiveAssistantFipeReference({ ...target, model }, [candidate({ model: model!, version })]), null)
  }
})

test('BMW 320i recupera Série 3 sem confundir 330e e não usa duplicata do próprio anúncio', () => {
  const reference = selectLiveAssistantFipeReference({ ...target, brand: 'BMW', model: '320i active flex' }, [
    candidate({ brand: 'BMW', model: 'SERIE 3', version: 'Serie 3 320i Active Flex', fipe: 200_000 }),
    candidate({ brand: 'BMW', model: 'SERIE 3', version: 'Serie 3 330e', fipe: 300_000 }),
  ])
  assert.equal(reference?.value, 200_000)
  assert.equal(selectLiveAssistantFipeReference({ ...target, url: 'https://example.com/lot/123' }, [candidate({ url: 'https://example.com/lot/123?financieJa=true' })]), null)
})


test('Virtus HL AC equivale a Highline no mesmo ano, sem herdar Comfortline', () => {
  const current = { ...target, model: 'Virtus HL AC', year: 2026 }
  const highline = candidate({ model: 'VIRTUS', version: 'Virtus Highline 200 AT 1.0 12V TSI Turbo', year: 2026, fipe: 126_278 })
  assert.equal(selectLiveAssistantFipeReference(current, [highline])?.value, 126_278)
  assert.equal(selectLiveAssistantFipeReference(current, [{ ...highline, version: 'Virtus Comfortline 200 AT 1.0' }]), null)
  assert.equal(selectLiveAssistantFipeReference(current, [{ ...highline, year: 2025 }]), null)
})
