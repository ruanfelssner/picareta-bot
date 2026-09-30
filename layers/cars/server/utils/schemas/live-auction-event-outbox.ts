import mongoose from 'mongoose'
import type { LiveAuctionAuditEvent } from '#shared/types/live-auction-audit'

export interface LiveAuctionEventOutboxDocument extends Omit<LiveAuctionAuditEvent, 'observedAt'> {
  observedAt: Date
  receivedAt: Date
  syncStatus: 'pending' | 'synced'
  syncedAt: Date | null
  syncAttempts: number
  lastSyncError: string | null
  expiresAt: Date
}

const { Schema, model, models } = mongoose

const LiveAuctionEventOutboxSchema = new Schema<LiveAuctionEventOutboxDocument>(
  {
    schemaVersion: { type: Number, required: true },
    eventId: { type: String, required: true, unique: true },
    sessionKey: { type: String, required: true },
    source: { type: String, required: true },
    auctionId: { type: String, default: null },
    sessionLabel: { type: String, default: null },
    sequence: { type: Number, required: true },
    observedAt: { type: Date, required: true },
    rawText: { type: String, required: true },
    normalizedText: { type: String, required: true },
    kind: { type: String, required: true },
    lot: { type: String, default: null },
    code: { type: String, default: null },
    amount: { type: Number, default: null },
    parserVersion: { type: Number, required: true },
    chassisRaw: { type: String, default: null },
    chassisNormalized: { type: String, default: null },
    vehicleUrl: { type: String, default: null },
    description: { type: String, default: null },
    consignor: { type: String, default: null },
    yard: { type: String, default: null },
    extensionVersion: { type: String, default: null },
    collectorUserId: { type: String, default: null },
    deviceId: { type: String, default: null },
    receivedAt: { type: Date, required: true },
    syncStatus: { type: String, enum: ['pending', 'synced'], default: 'pending' },
    syncedAt: { type: Date, default: null },
    syncAttempts: { type: Number, default: 0 },
    lastSyncError: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'live_auction_event_outbox', timestamps: false },
)

LiveAuctionEventOutboxSchema.index({ sessionKey: 1, sequence: 1 })
LiveAuctionEventOutboxSchema.index({ syncStatus: 1, receivedAt: 1 })
LiveAuctionEventOutboxSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const LiveAuctionEventOutboxModel =
  (models['live_auction_event_outbox'] as mongoose.Model<LiveAuctionEventOutboxDocument> | undefined)
  ?? model<LiveAuctionEventOutboxDocument>('live_auction_event_outbox', LiveAuctionEventOutboxSchema)
