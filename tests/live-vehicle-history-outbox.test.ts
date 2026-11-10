import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import * as history from '../shared/utils/live-vehicle-history'

const require = createRequire(import.meta.url)
type Row = { identityKey: string; revision: string; payload: Record<string, unknown>; status: string; attempts: number; nextAttemptAt: Date; leaseToken?: string; leaseUntil?: Date; expiresAt?: Date }

test('falha de rede e reinício mantêm as duas montas pendentes e confirmam somente após sincronizar', async () => {
  const rows = new Map<string, Row>()
  const delivered: Record<string, unknown>[] = []
  let online = false
  const model = {
    updateOne: async (filter: Partial<Row>, update: { $set?: Partial<Row>; $setOnInsert?: Partial<Row>; $inc?: { attempts: number } }) => {
      let row = rows.get(filter.identityKey!)
      if (filter.revision && row?.revision !== filter.revision) return { matchedCount: 0 }
      if (filter.leaseToken && row?.leaseToken !== filter.leaseToken) return { matchedCount: 0 }
      if (!row) { row = { ...update.$setOnInsert } as Row; rows.set(filter.identityKey!, row) }
      Object.assign(row, update.$set)
      if (update.$inc) row.attempts += update.$inc.attempts
      return { matchedCount: 1 }
    },
    findOneAndUpdate: (filter: Partial<Row>, update: { $set: Partial<Row> }) => ({ lean: async () => {
      const row = [...rows.values()].find(item => item.status === 'pending' && (!filter.identityKey || item.identityKey === filter.identityKey) && !item.leaseToken)
      if (!row) return null
      Object.assign(row, update.$set)
      return { ...row }
    } }),
  }
  function boot() {
    const exported: {
      enqueueLiveVehicleSync?: (_payload: Record<string, unknown>) => Promise<string>
      attemptLiveVehicleSync?: (_identityKey: string) => Promise<boolean>
    } = {}
    vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../layers/cars/server/utils/live-vehicle-sync-outbox.ts', import.meta.url), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, { exports: exported, Date, require: (id: string) => {
      if (id === './schemas/live-vehicle-sync-outbox') return { LiveVehicleSyncOutboxModel: model }
      if (id === '#shared/utils/live-vehicle-history') return history
      if (id === './picareta-sync') return { syncVehicleToPicareta: async (payload: Record<string, unknown>) => { if (!online) throw new Error('offline'); delivered.push(payload); return true } }
      return require(id)
    } })
    return { enqueue: exported.enqueueLiveVehicleSync!, attempt: exported.attemptLiveVehicleSync! }
  }
  const payload = { source: 'copart', url: 'https://www.copart.com.br/lot/12345', lot: '120', auctionId: '10', auctionDate: '2026-11-03T15:00:00Z', chassisNormalized: '9BWZZZ377VT004251', damage: 'Média monta', damageObservedAt: '2026-11-03T16:00:00Z' }
  const firstProcess = boot()
  const first = await firstProcess.enqueue(payload)
  assert.equal(await firstProcess.attempt(first), false)
  const second = await firstProcess.enqueue({ ...payload, damage: 'Grande monta', damageObservedAt: '2026-11-03T17:00:00Z' })
  assert.notEqual(first, second)
  assert.equal(rows.size, 2)
  assert.ok([...rows.values()].every(row => row.status === 'pending' && row.expiresAt == null))
  online = true
  const restarted = boot()
  assert.equal(await restarted.attempt(second), true, 'uma tentativa pode chegar fora de ordem')
  assert.equal(await restarted.attempt(first), true)
  assert.deepEqual(delivered.map(item => item.damage), ['Grande monta', 'Média monta'])
  assert.ok([...rows.values()].every(row => row.status === 'synced' && row.expiresAt != null))
})
