import { createHash, randomUUID } from 'node:crypto'
import { LiveVehicleSyncOutboxModel } from './schemas/live-vehicle-sync-outbox'
import { syncVehicleToPicareta } from './picareta-sync'

const LEASE_MS = 60_000
const RETENTION_MS = 8 * 24 * 60 * 60 * 1_000
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 300_000]

export async function enqueueLiveVehicleSync(payload: Record<string, unknown>): Promise<string> {
  if (typeof payload.source !== 'string' || typeof payload.url !== 'string' || !payload.source || !payload.url) {
    throw new Error('Sincronização exige origem e URL do veículo.')
  }
  const identityKey = createHash('sha256').update(`${payload.source}|${payload.url}`).digest('hex')
  const now = new Date()
  await LiveVehicleSyncOutboxModel.updateOne({ identityKey }, {
    $set: { payload, revision: randomUUID(), status: 'pending', attempts: 0, nextAttemptAt: now,
      updatedAt: now, lastError: null, syncedAt: null, expiresAt: null },
    // Uma atualização nova mantém o lease antigo até a chamada em andamento
    // terminar, impedindo envios concorrentes do mesmo veículo fora de ordem.
    $setOnInsert: { identityKey, createdAt: now, leaseToken: null, leaseUntil: null },
  }, { upsert: true })
  return identityKey
}

export async function attemptLiveVehicleSync(identityKey?: string): Promise<boolean> {
  const now = new Date()
  const leaseToken = randomUUID()
  const item = await LiveVehicleSyncOutboxModel.findOneAndUpdate({
    ...(identityKey ? { identityKey } : {}),
    status: 'pending', nextAttemptAt: { $lte: now },
    $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }],
  }, { $set: { leaseToken, leaseUntil: new Date(now.getTime() + LEASE_MS) } },
  { new: true, sort: { nextAttemptAt: 1 } }).lean()
  if (!item) return false
  const ownedRevision = { identityKey: item.identityKey, revision: item.revision, leaseToken }
  try {
    if (!await syncVehicleToPicareta(item.payload)) throw new Error('Picareta não confirmou o recebimento.')
    const result = await LiveVehicleSyncOutboxModel.updateOne(ownedRevision, { $set: {
      status: 'synced', syncedAt: new Date(), lastError: null,
      expiresAt: new Date(Date.now() + RETENTION_MS),
    }, $inc: { attempts: 1 } })
    return result.matchedCount === 1
  } catch (error) {
    const delay = RETRY_DELAYS_MS[Math.min(item.attempts, RETRY_DELAYS_MS.length - 1)]!
    await LiveVehicleSyncOutboxModel.updateOne(ownedRevision, { $set: {
      nextAttemptAt: new Date(Date.now() + delay),
      lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
      updatedAt: new Date(),
    }, $inc: { attempts: 1 } })
    return false
  } finally {
    // Libera somente o lease desta tentativa, sem reconhecer uma revisão nova.
    await LiveVehicleSyncOutboxModel.updateOne({ identityKey: item.identityKey, leaseToken }, {
      $set: { leaseToken: null, leaseUntil: null },
    })
  }
}

export async function syncLiveVehicleReliably(payload: Record<string, unknown>): Promise<boolean> {
  const identityKey = await enqueueLiveVehicleSync(payload)
  return attemptLiveVehicleSync(identityKey)
}

export async function flushLiveVehicleSyncOutbox(): Promise<number> {
  const results = await Promise.all(Array.from({ length: 4 }, () => attemptLiveVehicleSync()))
  return results.filter(Boolean).length
}
