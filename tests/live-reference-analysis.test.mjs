import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
function modules(overrides = new Map(), globals = {}) {
  const cache = new Map()
  function load(filename) {
    filename = path.resolve(root, filename)
    for (const [suffix, exports] of overrides) if (filename.endsWith(suffix)) return exports
    if (cache.has(filename)) return cache.get(filename)
    const exports = {}; cache.set(filename, exports)
    const source = readFileSync(filename, 'utf8')
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports, Date, URL, console, ...globals,
      require(id) {
        const file = id.startsWith('#shared/') ? path.join(root, 'shared', id.slice(8)) : path.resolve(path.dirname(filename), id)
        return load(`${file}.ts`)
      },
    }, { filename })
    return exports
  }
  return load
}
const emptySchema = new Map([['/schemas/vehicle.ts', { VehicleModel: {} }]])
const load = modules(emptySchema)
const { buildLiveVehicleMarketAnalysis } = load('layers/cars/server/utils/vehicle-market-analysis.ts')
const vehicle = { source: 'sodre', brand: 'Volkswagen', model: 'Gol 1.0', year: 2010, damage: 'Média monta', fipe: null }
const sold = { ...vehicle, source: 'copart', model: 'GOL', version: 'Gol 1.0 Total Flex', price: 7_000, soldPrice: 8_000, saleStatus: 'sold' }

test('uma venda real, sem FIPE, já fornece a média do mesmo modelo e ano', () => {
  const result = buildLiveVehicleMarketAnalysis(vehicle, [sold])
  assert.equal(result.averageValue, 8_000)
  assert.equal(result.averagePct, null)
  assert.equal(result.sampleSize, 1)
  assert.equal(result.basis, 'model-year-damage')
})

test('não projeta a venda ao editar FIPE e não mistura condicional nem motor conflitante', () => {
  const history = [sold, { ...sold, soldPrice: 10_000 }, { ...sold, saleStatus: 'conditional', soldPrice: null, price: 6_000 },
    { ...sold, version: 'Gol 1.6', soldPrice: 50_000 }, { ...sold, model: 'Golf', soldPrice: 90_000 }]
  const result = buildLiveVehicleMarketAnalysis({ ...vehicle, fipe: 30_000 }, history)
  assert.equal(result.averageValue, 9_000)
  assert.equal(result.averagePct, 30)
  assert.equal(result.conditionalAverageValue, 6_000)
  assert.equal(result.sampleSize, 2)
})

test('deduplica URL/ocorrência e prefere uma venda do ano exato', () => {
  const same = { ...sold, url: 'https://example.com/lot/1', auctionDate: '2026-11-06', scrapedAt: '2026-11-06T12:00:00Z' }
  const result = buildLiveVehicleMarketAnalysis(vehicle, [same, { ...same, url: same.url + '?tracking=1' }, { ...sold, year: 2009, soldPrice: 30_000 }])
  assert.equal(result.averageValue, 8_000)
  assert.equal(result.sampleSize, 1)
  assert.equal(buildLiveVehicleMarketAnalysis(vehicle, [{ ...sold, saleStatus: 'conditional' }]), null)
})

test('rota real recupera FIPE da versão Copart sem salvar a referência no evento', async () => {
  const inputs = [], queries = []
  const target = { ...vehicle, fipe: 0, _id: 'current', url: 'https://leilao.sodresantoro.com.br/leilao/29235/lote/2822056/', imageUrls: [], price: 5_600, description: 'VW GOL 1.0 2009/2010' }
  const donor = { ...sold, _id: 'donor', fipe: 25_741, fipeCheckedAt: '2026-11-04T12:00:00Z', url: 'https://www.copart.com.br/lot/123' }
  const VehicleModel = { find(filter, projection) {
    queries.push(filter)
    const data = filter.fipe ? [donor] : filter.saleStatus ? [sold] : [target]
    let fields = projection
    return { sort() { return this }, limit() { return this }, select(value) { fields = value; return this }, async lean() {
      return data.map(doc => fields ? Object.fromEntries(Object.entries(doc).filter(([k]) => k === '_id' || fields[k])) : { ...doc })
    } }
  } }
  const overrides = new Map([
    ['/schemas/vehicle.ts', { VehicleModel }],
    ['/live-auction-extension-auth.ts', { assertLiveAuctionExtensionAuthorized: async () => ({ kind: 'user', userId: 'u1' }) }],
    ['/live-auction-capture.ts', { recordLiveAuctionCapture: async input => { inputs.push({ ...input }); return true } }],
    ['/favorite-lot-result.ts', { findFavoriteLot: async () => ({ isFavorite: false }) }],
  ])
  const raw = { source: 'sodre', auctionId: '29235', lot: '0001', code: '2822056', vehicleUrl: target.url,
    brand: 'Volkswagen', model: 'Gol 1.0', yearModel: '2009/2010', description: target.description,
    damage: 'Média monta', bid: 5_600, allowDatabaseFipeReference: true }
  const api = modules(overrides, { defineEventHandler: handler => handler, useDb() {}, readBody: async () => raw,
    createError: input => Object.assign(new Error(input.message), input) })('layers/cars/server/api/vehicles/live-assistant.post.ts')
  const result = await api.default({})
  assert.equal(result.vehicle.fipe, 25_741)
  assert.equal(result.vehicle.fipeOrigin, 'database_reference')
  assert.equal(result.vehicle.fipeReference.source, 'copart')
  assert.equal(result.metrics.marketAnalysis.averageValue, 8_000)
  assert.equal(inputs[0].fipe, undefined, 'a captura não ganha FIPE inferida')
  assert.ok(queries.some(query => query.saleStatus && !query.fipe), 'histórico ao vivo inclui vendidos sem FIPE')
  target.fipe = 30_000
  const manual = await api.default({})
  assert.equal(manual.vehicle.fipe, 30_000)
  assert.equal(manual.vehicle.fipeOrigin, 'matched_vehicle')
  assert.equal(manual.vehicle.fipeReference, null)
})


test('média principal une todas as fontes e pesa vendas, com leiloeiro apenas nos detalhes', () => {
  const history = [sold, { ...sold, soldPrice: 10_000 }, { ...sold, soldPrice: 12_000 },
    { ...sold, source: 'sodre', soldPrice: 18_000 },
    { ...sold, source: 'sodre', soldPrice: 100_000, year: 2009 },
    { ...sold, source: 'sodre', soldPrice: 100_000, damage: 'Grande monta' },
    { ...sold, source: 'sodre', soldPrice: 6_000, saleStatus: 'conditional' },
  ]
  for (const source of ['copart', 'sodre']) {
    const result = buildLiveVehicleMarketAnalysis({ ...vehicle, source }, history)
    assert.equal(result.averageValue, 12_000)
    assert.equal(result.sampleSize, 4)
    assert.equal(result.conditionalAverageValue, 6_000)
    assert.equal(result.basis, 'model-year-damage')
    assert.deepEqual(Array.from(result.sourceBreakdown, row => [row.source, row.sampleSize, row.averageValue]), [
      ['copart', 3, 10_000], ['sodre', 1, 18_000],
    ])
  }
})
