import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const moduleRequire = createRequire(resolve('package.json'))
const selection = { action: 'quote', brandCode: '59', brandName: 'VW', modelCode: '123', modelName: 'Jetta GLI', yearCode: '2022-1', yearName: '2022 Gasolina' }
const quote = { price: 180_000, codeFipe: '005001-1', referenceMonth: 'outubro de 2026', modelYear: 2022, fuel: 'Gasolina', brandMatched: 'VW', modelMatched: 'Jetta GLI' }
type Event = { body: unknown; key?: string }

function service(result: unknown = { ok: true, data: quote }) {
  let providerCalls = 0
  let dbCalls = 0
  const cached = new Map<string, Record<string, unknown>>()
  const exports: { default?: (event: Event) => Promise<unknown> } = {}
  const mocks: Record<string, unknown> = {
    mongoose: { connection: { collection: () => ({
      findOne: async ({ key }: { key: string }) => cached.get(key) ?? null,
      updateOne: async ({ key }: { key: string }, update: { $set: Record<string, unknown> }) => { cached.set(key, update.$set) },
    }) } },
    '../../utils/fipe': {
      getFipeConfigFromEnv: () => ({ enabled: true, baseUrl: 'https://fipe.example', vehicleType: 'cars', reference: null }),
      suggestFipe: async () => { providerCalls++; return result },
      applyFipeSelection: async () => { providerCalls++; return result },
      catalogFipe: async () => { providerCalls++; return result },
    },
  }
  const source = ts.transpileModule(readFileSync(resolve('layers/cars/server/api/internal/fipe.post.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText
  vm.runInNewContext(source, {
    exports, require: (id: string) => id in mocks ? mocks[id] : moduleRequire(id), process: { env: { SCRAPER_SERVICE_KEY: 'service-key' } },
    defineEventHandler: (handler: unknown) => handler, readBody: async (event: Event) => event.body,
    getRequestHeader: (event: Event) => event.key, useDb: () => { dbCalls++ },
    createError: (data: { message: string }) => Object.assign(new Error(data.message), data),
  })
  return { run: (body: unknown, key = 'service-key') => exports.default!({ body, key }), providerCalls: () => providerCalls, dbCalls: () => dbCalls, cached }
}

test('consulta interna exige chave do serviço antes de acessar FIPE ou Mongo', async () => {
  const c = service()
  await assert.rejects(() => c.run(selection, 'invalid'), { statusCode: 401 })
  assert.equal(c.providerCalls(), 0)
  assert.equal(c.dbCalls(), 0)
})

test('referência escolhida é consultada no provider e reutilizada do cache por até 30 dias', async () => {
  const c = service()
  const first = await c.run(selection) as typeof quote
  const second = await c.run(selection) as typeof quote
  assert.equal(first.price, 180_000)
  assert.equal(second.price, 180_000)
  assert.equal(c.providerCalls(), 1)
  const cache = [...c.cached.values()][0]!
  const expiresAt = cache.expiresAt as Date
  assert.ok(expiresAt.getTime() > Date.now() + 29 * 86400_000)
})

test('sugestões e valores escolhidos usam chaves de cache independentes', async () => {
  const c = service({ ok: true, data: { suggestions: [] } })
  await c.run({ action: 'suggestions', brand: 'Volkswagen', model: 'Jetta', year: 2022 })
  await c.run({ action: 'suggestions', brand: 'Volkswagen', model: 'Jetta', year: 2022 })
  await c.run({ action: 'suggestions', brand: 'Volkswagen', model: 'Jetta', year: 2021 })
  assert.equal(c.providerCalls(), 2)
})

test('entrada inválida, falha do provider e valor FIPE ausente não entram no cache', async () => {
  const invalid = service()
  for (const body of [null, {}, { action: 'quote', brandCode: '59' }, { action: 'suggestions', brand: 'VW', model: 'Jetta', year: 0 }]) {
    await assert.rejects(() => invalid.run(body), { statusCode: 400 })
  }
  assert.equal(invalid.providerCalls(), 0)
  for (const result of [{ ok: false, reason: 'Provider indisponível' }, { ok: true, data: { ...quote, price: null } }, { ok: true, data: { ...quote, price: 0 } }]) {
    const c = service(result)
    await assert.rejects(() => c.run(selection), { statusCode: 422 })
    assert.equal(c.cached.size, 0)
  }
})

test('catálogo interno exige chave, valida hierarquia e reutiliza cache separado por marca e versão', async () => {
  const c = service({ ok: true, data: { options: [{ code: '59', name: 'VW - VolksWagen' }] } })
  await assert.rejects(() => c.run({ action: 'catalog', level: 'brands' }, 'invalid'), { statusCode: 401 })
  for (const body of [{ action: 'catalog' }, { action: 'catalog', level: 'models' }, { action: 'catalog', level: 'years', brandCode: '59', modelCode: '../' }]) {
    await assert.rejects(() => c.run(body), { statusCode: 400 })
  }
  const query = { action: 'catalog', level: 'models', brandCode: '59' }
  await c.run(query)
  await c.run(query)
  await c.run({ ...query, brandCode: '21' })
  assert.equal(c.providerCalls(), 2)
})

test('catálogo usa o provider existente e recupera uma consulta após falha transitória', async () => {
  const exports: { catalogFipe?: (config: unknown, input: unknown) => Promise<{ ok: boolean; data?: { options: Array<{ code: string; name: string }> } }> } = {}
  let calls = 0
  const source = ts.transpileModule(readFileSync(resolve('layers/cars/server/utils/fipe.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(source, { exports, process, AbortController, setTimeout, clearTimeout, fetch: async (url: string) => {
    calls++
    if (calls === 1) throw new Error('Falha transitória')
    const path = new URL(url).pathname
    const options = path.endsWith('/brands') ? [{ code: '59', name: 'VW - VolksWagen' }]
      : path.endsWith('/models') ? [{ code: '123', name: 'Polo Sedan 1.6' }]
      : [{ code: '2007-1', name: '2007 Gasolina' }, { code: '2007-3', name: '2007 Flex' }]
    return new Response(JSON.stringify(options))
  } })
  const config = { enabled: true, baseUrl: 'https://fipe.test', vehicleType: 'cars', subscriptionToken: '', reference: 300, timeoutMs: 1000 }
  const run = (level: string) => exports.catalogFipe!(config, { level, brandCode: '59', modelCode: '123' })
  assert.equal((await run('brands')).ok, false)
  assert.equal((await run('brands')).data?.options[0]?.code, '59')
  await run('brands')
  assert.equal(calls, 2, 'sucesso reutiliza cache e falha não envenena futuras consultas')
  assert.equal((await run('models')).data?.options[0]?.name, 'Polo Sedan 1.6')
  assert.equal((await run('years')).data?.options.length, 2, 'preserva todas as opções de combustível')
})

test('scraping atualiza o lance, preserva a FIPE selecionada e mantém a regra de venda futura', () => {
  const source = readFileSync(resolve('layers/scrapers/server/utils/scraper-runner.ts'), 'utf8')
  const start = source.indexOf('function getMutableVehicleFieldsForExisting(')
  const end = source.indexOf('function chooseDuplicateVehicleToKeep(', start)
  const code = ts.transpileModule(`export ${source.slice(start, end)}`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { getMutableVehicleFieldsForExisting?: (record: unknown, fields: Record<string, unknown>, existing: Record<string, unknown>, now: Date) => Record<string, unknown> } = {}
  vm.runInNewContext(code, { exports, shouldMarkCopartFutureAsNotSold: (existing: { future?: boolean }) => existing.future === true })
  const fields = { price: 85_000, fipe: 130_000, fipeCheckedAt: new Date() }
  const existing = { fipe: 180_000, fipeSelectedAt: new Date() }
  const next = exports.getMutableVehicleFieldsForExisting!({}, fields, existing, new Date())
  assert.equal(next.price, 85_000)
  assert.equal('fipe' in next, false)
  assert.equal(fields.fipe, 130_000)
  const manual = exports.getMutableVehicleFieldsForExisting!({}, { price: 75_000, soldPrice: null, saleStatus: 'unknown', auctionStatus: 'upcoming' }, { saleStatus: 'sold', soldPrice: 85_000, auctionStatus: 'finished', saleStatusManualAt: new Date() }, new Date())
  assert.equal(manual.saleStatus, 'sold')
  assert.equal(manual.soldPrice, 85_000)
  assert.equal(manual.auctionStatus, 'finished')
  const official = exports.getMutableVehicleFieldsForExisting!({}, { soldPrice: 90_000, saleStatus: 'sold' }, { saleStatus: 'sold', soldPrice: 85_000, saleStatusManualAt: new Date() }, new Date())
  assert.equal(official.soldPrice, 90_000)
  const future = exports.getMutableVehicleFieldsForExisting!({}, fields, { ...existing, future: true }, new Date())
  assert.equal(future.saleStatus, 'not_sold')
  assert.equal('fipe' in future, false)
})
