import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { liveVehicleSyncIdentity } from '../shared/utils/live-vehicle-history'

const require = createRequire(import.meta.url)
type Doc = Record<string, unknown> & { _id: string }
function harness() {
  const docs: Doc[] = []
  const queued = new Map<string, Record<string, unknown>>()
  const order: string[] = []
  let body: unknown, failEnqueue = false
  function matches(doc: Doc, filter: Record<string, unknown>): boolean {
    return Object.entries(filter).every(([key, value]) => {
      if (key === '$or') return (value as Record<string, unknown>[]).some(clause => matches(doc, clause))
      if (key === '$and') return (value as Record<string, unknown>[]).every(clause => matches(doc, clause))
      const actual = doc[key]
      if (value === null) return actual == null
      if (value instanceof RegExp) return value.test(String(actual))
      if (value && typeof value === 'object' && '$lte' in value) return new Date(String(actual)).getTime() <= new Date(String(value.$lte)).getTime()
      return actual === value
    })
  }
  function query(filter: Record<string, unknown>, many = false) {
    let sort: Record<string, number> = {}
    return { sort(value: Record<string, number>) { sort = value; return this }, select() { return this }, lean: async () => {
      const rows = docs.filter(doc => matches(doc, filter)).sort((a, b) => {
        for (const [key, direction] of Object.entries(sort)) {
          const difference = String(a[key] || '').localeCompare(String(b[key] || '')) * direction
          if (difference) return difference
        }
        return 0
      }).map(doc => structuredClone(doc))
      return many ? rows : rows[0] || null
    } }
  }
  const model = {
    find: (filter: Record<string, unknown>) => query(filter, true),
    findOne: (filter: Record<string, unknown>) => query(filter),
    findById: (id: string) => query({ _id: id }),
    updateOne: async (filter: Record<string, unknown>, update: { $set?: Record<string, unknown>; $setOnInsert?: Record<string, unknown>; $addToSet?: Record<string, unknown> }, options: { upsert?: boolean } = {}) => {
      order.push('write')
      let doc = docs.find(value => matches(value, filter))
      let inserted = 0
      if (!doc && options.upsert) { doc = { ...update.$setOnInsert, _id: `row-${docs.length}` }; docs.push(doc); inserted = 1 }
      if (!doc) return { matchedCount: 0, upsertedCount: 0 }
      Object.assign(doc, structuredClone(update.$set || {}))
      for (const [key, value] of Object.entries(update.$addToSet || {})) {
        const values = value && typeof value === 'object' && '$each' in value ? value.$each as unknown[] : [value]
        const old = Array.isArray(doc[key]) ? doc[key] as unknown[] : []
        const unique = new Map([...old, ...values].map(entry => [JSON.stringify(entry), entry]))
        doc[key] = [...unique.values()]
      }
      return { matchedCount: inserted ? 0 : 1, upsertedCount: inserted }
    },
  }
  function route(file: string) {
    const exported: { default?: (_event: unknown) => Promise<Record<string, unknown>> } = {}
    vm.runInNewContext(ts.transpileModule(readFileSync(resolve(file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
      exports: exported, Date, URL, TextEncoder, crypto: globalThis.crypto, console: { info() {}, error() {} },
      defineEventHandler: (handler: unknown) => handler, useDb() {}, readBody: async () => body,
      createError: (value: { message: string }) => Object.assign(new Error(value.message), value),
      require: (id: string) => {
        if (id === '../../utils/schemas/vehicle') return { VehicleModel: model }
        if (id === '../../utils/live-auction-extension-auth') return { assertLiveAuctionExtensionAuthorized: async () => ({ kind: 'service' }) }
        if (id === '../../utils/live-auction-capture') return { recordLiveAuctionCapture: async () => true }
        if (id === '../../utils/favorite-lot-result') return { shareFavoriteLotResultIfNeeded: async () => {}, shareLiveLotResultIfRequested: async () => {} }
        if (id === '../../utils/pestana-live-identity') return {}
        if (id === '../../utils/sodre-live-identity') return { areVehicleBrandsCompatible: (first: string, second: string) => first === second }
        if (id === '../../utils/live-vehicle-sync-outbox') return {
          enqueueLiveVehicleSync: async (payload: Record<string, unknown>) => {
            if (failEnqueue) throw new Error('queue unavailable')
            order.push('queue')
            const key = liveVehicleSyncIdentity(payload)
            queued.set(key, structuredClone(payload)); return key
          }, attemptLiveVehicleSync: async () => false,
        }
        return require(id.startsWith('#shared/') ? resolve('shared', id.slice(8)) : id)
      },
    })
    return async (input: unknown) => { body = input; return exported.default!({}) }
  }
  return { docs, queued, order, ingest: route('layers/cars/server/api/vehicles/ingest.post.ts'), recapture: route('layers/cars/server/api/vehicles/recapture.post.ts'), failQueue: () => { failEnqueue = true } }
}

function event(overrides: Record<string, unknown> = {}) {
  return { source: 'copart', auctionId: '10', lot: '120', code: '12345', brand: 'FIAT', model: 'ARGO',
    description: 'Fiat Argo 2020', category: 'Automóveis', yearModel: '2020', damage: 'Média monta',
    chassisRaw: '9BWZZZ377VT004251', bid: 20000, saleStatus: 'not_sold', yard: 'Curitiba - PR',
    vehicleUrl: 'https://www.copart.com.br/lot/12345', observedAt: '2026-11-03T16:00:00Z', ...overrides }
}

test('Copart: não vendido Média e vendido Grande em outro pregão preservam duas ocorrências', async () => {
  const h = harness()
  await h.ingest(event())
  await h.ingest(event({ auctionId: '20', lot: '87', damage: 'Grande monta', saleStatus: 'sold', observedAt: '2026-11-10T16:00:00Z' }))
  assert.equal(h.docs.length, 2)
  assert.equal(h.docs[0]!.damage, 'Média monta')
  assert.equal(h.docs[0]!.saleStatus, 'not_sold')
  assert.equal(h.docs[1]!.damage, 'Grande monta')
  assert.equal(h.docs[1]!.saleStatus, 'sold')
  assert.deepEqual(h.order, ['queue', 'write', 'queue', 'write'])
  assert.equal(h.queued.size, 2)
})

test('Copart: alteração no mesmo pregão é durável antes do overwrite e falha ao enfileirar impede perda', async () => {
  const h = harness()
  await h.ingest(event())
  const expiresAt = h.docs[0]!.expiresAt
  await h.ingest(event({ damage: 'Grande monta', observedAt: '2026-11-03T17:00:00Z' }))
  assert.equal(h.docs.length, 1)
  assert.deepEqual((h.docs[0]!.damageHistory as Array<{ damage: string }>).map(point => point.damage), ['Média monta', 'Grande monta'])
  assert.equal(String(h.docs[0]!.expiresAt), String(expiresAt), 'retenção não é renovada')
  h.failQueue()
  await assert.rejects(h.ingest(event({ damage: 'Pequena monta', observedAt: '2026-11-03T18:00:00Z' })), /queue unavailable/)
  assert.equal(h.docs[0]!.damage, 'Grande monta')
})

test('Copart: chassi conflitante não sobrescreve o lote e recaptura conserva as duas montas', async () => {
  const h = harness()
  await h.ingest(event())
  await assert.rejects(h.ingest(event({ chassisRaw: '9BWZZZ377VT004252', damage: 'Grande monta' })), /Nenhum veiculo valido/)
  assert.equal(h.docs[0]!.damage, 'Média monta')
  await assert.rejects(h.recapture(event({ chassisRaw: '9BWZZZ377VT004252', damage: 'Grande monta' })), /chassi completo/)
  await h.recapture(event({ damage: 'Grande monta' }))
  assert.equal(h.docs[0]!.damage, 'Grande monta')
  assert.deepEqual((h.docs[0]!.damageHistory as Array<{ damage: string }>).map(point => point.damage), ['Média monta', 'Grande monta'])
  assert.ok([...h.queued.values()].some(payload => (payload.damageHistory as unknown[])?.length === 2))
})
