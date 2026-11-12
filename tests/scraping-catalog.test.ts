import assert from 'node:assert/strict'
import test from 'node:test'
import { scrapingCatalog } from '../shared/constants/scraping-catalog'
import { VEHICLE_SOURCES } from '../shared/constants/sources'

test('catálogo usa metadados centrais e só anuncia fontes com executor registrado', () => {
  const catalog = scrapingCatalog('0.49.0', ['leilo', 'pampasul'])
  assert.equal(catalog.schemaVersion, 1)
  assert.equal(catalog.version, '0.49.0')
  assert.deepEqual(catalog.sources.map(source => source.id).sort(), ['leilo', 'pampasul'])
  const leilo = catalog.sources.find(source => source.id === 'leilo')!
  assert.equal(leilo.label, 'Leilo Sul e Sudeste')
  assert.deepEqual(leilo.images?.hosts, ['leilo.cdndp.com.br'])
  assert.equal(leilo.manual, true)
  const disabled = catalog.sources.find(source => source.id === 'pampasul')!
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.manual, false)
  assert.equal(disabled.automatic, false)
})
test('fontes automáticas e prioridade de agenda conservam a política operacional atual', () => {
  const sources = scrapingCatalog('0.49.0', VEHICLE_SOURCES).sources
  assert.deepEqual(sources.filter(source => source.automatic).sort((a,b) => a.automaticPriority-b.automaticPriority).map(source => source.id), ['sodre', 'copart', 'vs-veiculos'])
  assert.deepEqual(sources.filter(source => source.enabled).sort((a,b) => a.schedulePriority-b.schedulePriority).slice(0,3).map(source => source.id), ['copart', 'sodre', 'vipleiloes'])
  assert.equal(sources.some(source => String(source.id) === 'facebook-marketplace'), false)
})
