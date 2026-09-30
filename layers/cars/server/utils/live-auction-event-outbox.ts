import { createHash, randomUUID } from 'node:crypto'
import type { LiveAuctionExtensionActor } from './live-auction-extension-auth'
import type {
  LiveAuctionAuditBatch,
  LiveAuctionAuditEvent,
  LiveAuctionAuditKind,
  LiveAuctionAuditSource,
} from '#shared/types/live-auction-audit'
import { LiveAuctionEventOutboxModel } from './schemas/live-auction-event-outbox'
import { syncAuctionEventsToPicareta } from './picareta-sync'

const RETENTION_MS = 8 * 24 * 60 * 60 * 1000
const SOURCES = new Set<LiveAuctionAuditSource>(['copart', 'vipleiloes', 'sodre'])
const KINDS = new Set<LiveAuctionAuditKind>([
  'session_detected', 'session_started', 'session_finished', 'lot_announced', 'lot_opened', 'lot_changed',
  'bid_received', 'bid_updated', 'lot_sold', 'lot_conditional', 'lot_not_sold', 'message_unclassified',
  'collector_connected', 'collector_disconnected', 'sync_failed', 'sync_recovered',
])

function text(value: unknown, max = 1_000): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function number(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function normalizeEvent(value: unknown, actor: LiveAuctionExtensionActor): LiveAuctionAuditEvent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const item = value as Record<string, unknown>
  const source = text(item.source, 40) as LiveAuctionAuditSource | null
  const sessionKey = text(item.sessionKey, 240)
  const rawText = text(item.rawText, 10_000)
  const kind = text(item.kind, 80) as LiveAuctionAuditKind | null
  const observedAt = text(item.observedAt, 80)
  const observedDate = observedAt ? new Date(observedAt) : null
  if (!source || !SOURCES.has(source) || !sessionKey || !rawText || !kind || !KINDS.has(kind)
    || !observedDate || Number.isNaN(observedDate.getTime())) return null

  const eventId = text(item.eventId, 128) ?? createHash('sha256').update([
    sessionKey,
    text(item.dedupeKey, 4_000) ?? rawText,
    String(number(item.sequence) ?? 0),
  ].join('|')).digest('hex')
  const normalizedText = text(item.normalizedText, 10_000) ?? rawText
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
  return {
    schemaVersion: 1,
    eventId,
    sessionKey,
    source,
    auctionId: text(item.auctionId, 120),
    sessionLabel: text(item.sessionLabel, 240),
    sequence: Math.floor(number(item.sequence) ?? 0),
    observedAt: observedDate.toISOString(),
    rawText,
    normalizedText,
    kind,
    lot: text(item.lot, 120),
    code: text(item.code, 240),
    amount: number(item.amount),
    parserVersion: Math.max(1, Math.floor(number(item.parserVersion) ?? 1)),
    chassisRaw: text(item.chassisRaw, 240),
    chassisNormalized: text(item.chassisNormalized, 240),
    vehicleUrl: text(item.vehicleUrl, 4_096),
    description: text(item.description, 2_000),
    consignor: text(item.consignor, 500),
    yard: text(item.yard, 500),
    extensionVersion: text(item.extensionVersion, 40),
    collectorUserId: actor.userId,
    deviceId: actor.deviceId,
  }
}

export async function persistLiveAuctionEventBatch(rawEvents: unknown[], actor: LiveAuctionExtensionActor) {
  const acceptedEventIds: string[] = []
  const duplicateEventIds: string[] = []
  const rejected: Array<{ index: number; reason: string }> = []
  const now = new Date()

  for (const [index, raw] of rawEvents.slice(0, 100).entries()) {
    const event = normalizeEvent(raw, actor)
    if (!event) {
      rejected.push({ index, reason: 'evento_invalido' })
      continue
    }
    const write = await LiveAuctionEventOutboxModel.updateOne(
      { eventId: event.eventId },
      {
        $setOnInsert: {
          ...event,
          observedAt: new Date(event.observedAt),
          receivedAt: now,
          syncStatus: 'pending',
          syncedAt: null,
          syncAttempts: 0,
          lastSyncError: null,
          expiresAt: new Date(now.getTime() + RETENTION_MS),
        },
      },
      { upsert: true },
    )
    if (write.upsertedCount === 1) acceptedEventIds.push(event.eventId)
    else duplicateEventIds.push(event.eventId)
  }

  const synced = await flushLiveAuctionEventOutbox(100).catch(() => 0)
  return { acceptedEventIds, duplicateEventIds, rejected, synced }
}

export async function flushLiveAuctionEventOutbox(limit = 100): Promise<number> {
  const pending = await LiveAuctionEventOutboxModel.find({ syncStatus: 'pending' })
    .sort({ receivedAt: 1 }).limit(limit).lean()
  if (!pending.length) return 0
  const groups = new Map<string, LiveAuctionAuditEvent[]>()
  for (const item of pending) {
    const event = {
      ...item,
      _id: undefined,
      observedAt: item.observedAt.toISOString(),
      receivedAt: undefined,
      syncStatus: undefined,
      syncedAt: undefined,
      syncAttempts: undefined,
      lastSyncError: undefined,
      expiresAt: undefined,
      __v: undefined,
    } as unknown as LiveAuctionAuditEvent
    const batch = groups.get(event.sessionKey) ?? []
    batch.push(event)
    groups.set(event.sessionKey, batch)
  }

  let synced = 0
  for (const [sessionKey, events] of groups) {
    const batch: LiveAuctionAuditBatch = { schemaVersion: 1, batchId: randomUUID(), sessionKey, events }
    try {
      const response = await syncAuctionEventsToPicareta(batch)
      const acknowledged = new Set([...response.acceptedEventIds, ...response.duplicateEventIds])
      const ids = events.map(item => item.eventId).filter(id => acknowledged.has(id))
      if (ids.length) {
        await LiveAuctionEventOutboxModel.updateMany(
          { eventId: { $in: ids } },
          { $set: { syncStatus: 'synced', syncedAt: new Date(), lastSyncError: null }, $inc: { syncAttempts: 1 } },
        )
        synced += ids.length
      }
    }
    catch (error) {
      await LiveAuctionEventOutboxModel.updateMany(
        { eventId: { $in: events.map(item => item.eventId) } },
        {
          $set: { lastSyncError: (error instanceof Error ? error.message : String(error)).slice(0, 1_000) },
          $inc: { syncAttempts: 1 },
        },
      )
    }
  }
  return synced
}
