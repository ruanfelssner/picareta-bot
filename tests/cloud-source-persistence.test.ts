import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { toIngestRecord, externalId } from '../layers/scrapers/server/utils/cloud-ingest'
import { orderedCloudProgress } from '../layers/scrapers/server/utils/cloud-progress'
import { vehicleYear } from '../shared/utils/vehicle-year'
import { filterAuctionVehiclesByGeo } from '../src/location-filter'
import { PartialScraperResultError } from '../layers/scrapers/server/utils/source-types'
import type { AuctionVehicle } from '../src/formatters/auction-card'
import type { runAuctionSearch, AuctionSourceResult } from '../src/commands/auction-search'

const car = (source: AuctionVehicle['source'], state = 'PR') => ({ source, brand: 'VW', model: 'Polo', year: 2022, damage: null, price: 30000, priceRaw: null, imageUrls: [], description: 'Veículo', url: `https://auction.test/${source}/${state}`, auctionDate: null, yard: null, state }) satisfies AuctionVehicle

test('ano zero/desconhecido não interrompe a ingestão e identidade anterior permanece estável', () => {
  for (const value of [0, -1, NaN, Infinity, null, undefined, '', '0', 1800, 2101, 2020.5]) assert.equal(vehicleYear(value), null)
  assert.equal(vehicleYear(2022), 2022)
  assert.equal(vehicleYear('2022'), 2022)
  const invalid = { ...car('sodre'), year: 0 }
  assert.equal(toIngestRecord(invalid).year, null)
  assert.equal(toIngestRecord(invalid).externalId, externalId(invalid))
  const photos = Array.from({ length: 100 }, (_, index) => `https://cdn.test/${index}.jpg`)
  assert.deepEqual(toIngestRecord({ ...car('leilo'), imageUrls: photos }).imageUrls, photos)
})

test('callbacks saem em ordem com snapshots imutáveis e retentativa antes do próximo estado', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const calls: string[] = [], failed: unknown[] = []
  let attempts = 0
  const notify = orderedCloudProgress(async (value: { status: string }) => {
    calls.push(value.status)
    if (value.status === 'running' && ++attempts === 1) { await gate; throw new Error('HTTP 503') }
  }, error => { failed.push(error) }, async () => {})
  const state = { status: 'running' }
  const first = notify(state)
  state.status = 'completed'
  const second = notify(state)
  release()
  await Promise.all([first, second])
  assert.deepEqual(calls, ['running', 'running', 'completed'])
  assert.deepEqual(failed, [])
})

test('callback esgotado é registrado e não impede o callback terminal seguinte', async () => {
  let attempts = 0, failures = 0, completed = false
  const notify = orderedCloudProgress(async (status: string) => {
    if (status === 'running') { attempts++; throw new Error('offline') }
    completed = true
  }, () => { failures++ }, async () => {})
  await Promise.all([notify('running'), notify('completed')])
  assert.equal(attempts, 3)
  assert.equal(failures, 1)
  assert.equal(completed, true)
})

function auctionRunner(scrapers: Record<string, () => Promise<AuctionVehicle[]>>) {
  const exported: { runAuctionSearch?: typeof runAuctionSearch } = {}
  const source = readFileSync(new URL('../src/commands/auction-search.ts', import.meta.url), 'utf8')
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports: exported, console, setTimeout, clearTimeout, AbortController,
    require: (id: string) => {
      if (id.endsWith('/source-types.js')) return { PartialScraperResultError }
      if (id.endsWith('/sources/ph-batidos.js')) return { phBatidosSource: {} }
      if (id.endsWith('/constants/sources.js')) return { isAuctionSourceDisabled: () => false }
      if (id.includes('/scrapers/')) return new Proxy({}, { get: (_target, name) => String(name).endsWith('_TIMEOUT_MS') ? 10_000 : scrapers[id.split('/').at(-1)!.replace('.js', '')] })
      if (id.endsWith('/location-filter.js')) return { filterAuctionVehiclesByGeo }
      if (id.endsWith('/integrations/mongo.js')) return {
        getAuctionFilters: async () => ({ comboRules: [], locations: [], states: ['PR'], cities: [] }),
        getHiddenAuctionVehicleUrlSet: async () => new Set(), saveAuctionResults: async () => {},
      }
      if (id.endsWith('/formatters/auction-card.js')) return { formatAuctionSummary: () => '' }
      return {}
    },
  })
  return exported.runAuctionSearch!
}

const options = { groupPhone: '__test__', dataMongoConfig: { enabled: false }, zApiConfig: { enabled: false }, sources: ['vs-veiculos', 'freitas'], log: () => {} } as Parameters<typeof runAuctionSearch>[0]

test('persiste fonte rápida antes de uma fonte lenta terminar, respeitando UF e deduplicação', async () => {
  let release!: (cars: AuctionVehicle[]) => void
  const slow = new Promise<AuctionVehicle[]>(resolve => { release = resolve })
  let saved!: () => void
  const firstSaved = new Promise<void>(resolve => { saved = resolve })
  const runner = auctionRunner({ 'vs-veiculos': async () => [car('vs-veiculos'), car('vs-veiculos'), car('vs-veiculos', 'BA')], freitas: () => slow })
  const results: AuctionSourceResult[] = []
  const pending = runner({ ...options, onSourceResult: async result => { results.push(result); saved() } })
  await firstSaved
  assert.equal(results.length, 1)
  assert.equal(results[0]!.source, 'vs-veiculos')
  assert.equal(results[0]!.vehicles.length, 1)
  release([car('freitas')])
  const result = await pending
  assert.equal(result.sourceFailures.length, 0)
  assert.equal(results.length, 2)
})

test('falha de persistência de uma fonte preserva o sucesso das demais sem repetir scraper', async () => {
  const runner = auctionRunner({ 'vs-veiculos': async () => [car('vs-veiculos')], freitas: async () => [car('freitas')] })
  const persisted: string[] = []
  const result = await runner({ ...options, onSourceResult: async source => {
    persisted.push(source.source)
    if (source.source === 'vs-veiculos') throw new Error('ingestão HTTP 400: vehicles.2.year')
  } })
  assert.equal(result.sourceFailures.length, 1)
  assert.equal(result.sourceFailures[0]!.source, 'vs-veiculos')
  assert.match(result.sourceFailures[0]!.reason, /vehicles\.2\.year/)
  assert.deepEqual(persisted.sort(), ['freitas', 'vs-veiculos'])
})

test('coleta parcial é persistida como incompleta e nunca confirma snapshot completo', async () => {
  const runner = auctionRunner({ freitas: async () => { throw new PartialScraperResultError('detalhe ausente', [car('freitas')]) } })
  let complete: boolean | undefined
  const result = await runner({ ...options, sources: ['freitas'], onSourceResult: async source => { complete = source.complete } })
  assert.equal(complete, false)
  assert.equal(result.sourceFailures.length, 1)
})
