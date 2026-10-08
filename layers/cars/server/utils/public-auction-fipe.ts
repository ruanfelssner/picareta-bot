import mongoose, { type Connection } from 'mongoose'
import { getFipeConfigFromEnv, lookupFipe, type FipeLookupResult } from './fipe'

type VehicleIdentity = { brand: string; model: string; year: number | null; fipe?: number | null }
type FipeData = Extract<FipeLookupResult, { ok: true }>['data']
type FipeFields = { fipe?: number | null; fipeRaw?: string | null; fipeCode?: string | null; fipeReferenceMonth?: string | null; fipeFuel?: string | null; fipeBrandMatched?: string | null; fipeModelMatched?: string | null; fipeCheckedAt?: Date | null }
const CACHE_MS = 30 * 24 * 60 * 60_000
const memory = new Map<string, { data: FipeData; expiresAt: Date }>()
let cacheConnection: Promise<Connection> | null = null

async function cache() {
  const uri = (process.env.MONGO_DATA_URI || process.env.MONGO_URI || '').trim()
  if (!uri) return null
  cacheConnection ??= mongoose.createConnection(uri, {
    dbName: (process.env.MONGO_DATA_DB_NAME || process.env.MONGO_DB_NAME || 'marketplace').trim(),
    serverSelectionTimeoutMS: 5_000,
  }).asPromise().catch(error => { cacheConnection = null; throw error })
  return (await cacheConnection).collection('fipe_cache')
}

/** Completa somente referências ausentes, mantendo a FIPE publicada pelo leiloeiro. */
export async function enrichPublicAuctionFipe<T extends VehicleIdentity>(vehicles: T[], log: (message: string) => void, signal?: AbortSignal): Promise<Array<T & FipeFields>> {
  const config = getFipeConfigFromEnv()
  if (!config.enabled) return vehicles
  let collection: Awaited<ReturnType<typeof cache>> = null
  try { collection = await cache() } catch { log('[fipe] Cache persistente indisponível; usando o cache da API.') }
  const results: Array<T & FipeFields> = [...vehicles]
  for (let start = 0; start < vehicles.length && !signal?.aborted; start += 3) {
    await Promise.all(vehicles.slice(start, start + 3).map(async (vehicle, offset) => {
      if (vehicle.fipe != null || vehicle.year == null || !vehicle.brand || !vehicle.model) return
      const key = [config.baseUrl, config.vehicleType, config.reference ?? new Date().toISOString().slice(0, 7), vehicle.brand, vehicle.model, vehicle.year].join('|')
      let data = memory.get(key)
      if (!data || data.expiresAt.getTime() <= Date.now()) {
        try {
          const saved = await collection?.findOne({ key, expiresAt: { $gt: new Date() } })
          if (saved?.data && typeof saved.data === 'object' && typeof saved.data.price === 'number' && saved.data.price > 0
            && saved.data.modelYear === vehicle.year && typeof saved.data.brandMatched === 'string' && typeof saved.data.modelMatched === 'string') {
            data = { data: saved.data as FipeData, expiresAt: new Date(saved.expiresAt) }
          }
        } catch { /* Cache indisponível não impede a consulta pública. */ }
        if (!data || data.expiresAt.getTime() <= Date.now()) {
          const lookup = await lookupFipe(config, { brand: vehicle.brand, model: vehicle.model, year: vehicle.year })
          if (!lookup.ok || lookup.data.price == null || lookup.data.price <= 0 || lookup.data.modelYear !== vehicle.year) {
            log(`[fipe] ${vehicle.brand} ${vehicle.model} ${vehicle.year}: ${lookup.ok ? 'Sem referência para o ano-modelo exato' : lookup.reason}`)
            return
          }
          data = { data: lookup.data, expiresAt: new Date(Date.now() + CACHE_MS) }
          try { await collection?.updateOne({ key }, { $set: { key, ...data, checkedAt: new Date() } }, { upsert: true }) } catch { /* O resultado válido continua disponível. */ }
        }
        memory.set(key, data)
        if (memory.size > 2000) memory.delete(memory.keys().next().value!)
      }
      const reference = data.data
      results[start + offset] = { ...vehicle, fipe: reference.price, fipeRaw: reference.priceRaw,
        fipeCode: reference.codeFipe, fipeReferenceMonth: reference.referenceMonth, fipeFuel: reference.fuel,
        fipeBrandMatched: reference.brandMatched, fipeModelMatched: reference.modelMatched, fipeCheckedAt: new Date() }
    }))
    if (start + 3 < vehicles.length && !signal?.aborted) await new Promise(resolve => setTimeout(resolve, 300))
  }
  return results
}
