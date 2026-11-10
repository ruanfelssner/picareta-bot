import { createHash } from 'node:crypto'
import { classifyDamage, normalizeDamage } from './damage'
import type { LiveDamageSnapshot, VehicleRecord } from '../types/vehicle'

type Vehicle = Partial<Omit<VehicleRecord, '_id'>>

export function completeLiveChassis(raw?: string | null, normalized?: string | null): string | null {
  const chassis = (raw || normalized || '').toUpperCase().replace(/[\s.-]/g, '')
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(chassis) && !/^(.)\1+$/.test(chassis) ? chassis : null
}

function day(value: Date | string | null | undefined): string | null {
  if (!value || !Number.isFinite(new Date(value).getTime())) return null
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value))
}

export function liveOccurrenceExternalId(vehicle: Vehicle): string | null {
  const date = day(vehicle.conditionalOriginalAuctionDate || vehicle.auctionDate)
  if (!vehicle.source || !vehicle.url || !vehicle.lot || !date) return null
  const text = (value: string) => value.trim().toLocaleLowerCase('pt-BR')
  const key = [text(vehicle.source), text(vehicle.url).replace(/[?#].*$/, '').replace(/\/+$/, ''), date, text(vehicle.lot)].join('|')
    + (vehicle.auctionId ? `|auction:${text(vehicle.auctionId)}` : '')
  return `occurrence-${createHash('sha256').update(key).digest('hex')}`
}

export function sameLiveOccurrence(first: Vehicle, second: Vehicle): boolean {
  const firstId = liveOccurrenceExternalId(first)
  return firstId != null && firstId === liveOccurrenceExternalId(second)
    && !(first.auctionId && second.auctionId && first.auctionId !== second.auctionId)
}

export function conflictingLiveChassis(first: Vehicle, second: Vehicle): boolean {
  const before = completeLiveChassis(first.chassisRaw, first.chassisNormalized)
  const after = completeLiveChassis(second.chassisRaw, second.chassisNormalized)
  return before != null && after != null && before !== after
}

export function liveDamageObservedAt(previous: Vehicle | null, current: Vehicle): Date {
  const unchanged = previous && sameLiveOccurrence(previous, current)
    && classifyDamage(previous.damage) === classifyDamage(current.damage)
  return new Date(unchanged
    ? previous.damageObservedAt || previous.scrapedAt || current.scrapedAt || Date.now()
    : current.damageObservedAt || current.scrapedAt || Date.now())
}

export function liveDamageSnapshot(vehicle: Vehicle): LiveDamageSnapshot | null {
  const damage = normalizeDamage(vehicle.damage)
  const bucket = classifyDamage(damage)
  const observedAt = vehicle.damageObservedAt || vehicle.scrapedAt
  if (!vehicle.source || !vehicle.url || !damage || !observedAt || !Number.isFinite(new Date(observedAt).getTime())
    || bucket === 'outros' || bucket === 'sem_info' || vehicle.collectedVia !== 'extension') return null
  const date = (value: Date | null | undefined) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null
  return {
    source: vehicle.source, externalId: vehicle.externalId || 'extension-history', collectedVia: 'extension',
    url: vehicle.url, damage, chassisRaw: vehicle.chassisRaw || null,
    chassisNormalized: completeLiveChassis(vehicle.chassisRaw, vehicle.chassisNormalized),
    lot: vehicle.lot || null, auctionId: vehicle.auctionId || null,
    auctionDate: date(vehicle.auctionDate), conditionalOriginalAuctionDate: date(vehicle.conditionalOriginalAuctionDate),
    scrapedAt: new Date(observedAt).toISOString(), damageObservedAt: new Date(observedAt).toISOString(),
  }
}

export function buildLiveDamageHistory(previous: Vehicle | null, current: Vehicle): LiveDamageSnapshot[] {
  const snapshots = [...(previous?.damageHistory || []), ...(current.damageHistory || []), liveDamageSnapshot(previous || {}), liveDamageSnapshot(current)]
  const unique = new Map<string, LiveDamageSnapshot>()
  for (const snapshot of snapshots) if (snapshot) unique.set(JSON.stringify(snapshot), snapshot)
  return [...unique.values()]
}

/** Only recaptures of the same occurrence, classification and result may coalesce. */
export function liveVehicleSyncIdentity(payload: Record<string, unknown>): string {
  const date = payload.auctionDate instanceof Date || typeof payload.auctionDate === 'string' ? day(payload.auctionDate) : null
  return createHash('sha256').update(JSON.stringify([
    payload.source, payload.url, payload.auctionId, date, payload.lot,
    payload.chassisNormalized, payload.damage, payload.damageObservedAt,
    payload.saleStatus, payload.soldPrice, payload.price,
  ])).digest('hex')
}
