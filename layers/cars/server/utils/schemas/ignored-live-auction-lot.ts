import mongoose from 'mongoose'

export type IgnoredLiveAuctionLotStatus = 'pending' | 'approved' | 'open' | 'resolved'

export interface IgnoredLiveAuctionLotDocument {
  identityKey: string
  source: string
  auctionId: string | null
  lot: string | null
  code: string | null
  vehicleUrl: string | null
  brand: string | null
  model: string | null
  yearModel: string | null
  category: string | null
  damage: string | null
  condition: string | null
  yard: string | null
  consignor: string | null
  saleStatus: string | null
  reason: string
  manualDecision: string | null
  decisionMode: string | null
  status: IgnoredLiveAuctionLotStatus
  ignoredCount: number
  firstIgnoredAt: Date
  lastIgnoredAt: Date
  lastEvent: Record<string, unknown>
  resolvedAt: Date | null
  resolution: string | null
  approvedAt: Date | null
  approvedBy: string | null
  promotedVehicleId: string | null
  expiresAt: Date
}

const { Schema, model, models } = mongoose

const IgnoredLiveAuctionLotSchema = new Schema<IgnoredLiveAuctionLotDocument>(
  {
    identityKey: { type: String, required: true, unique: true },
    source: { type: String, required: true },
    auctionId: { type: String, default: null },
    lot: { type: String, default: null },
    code: { type: String, default: null },
    vehicleUrl: { type: String, default: null },
    brand: { type: String, default: null },
    model: { type: String, default: null },
    yearModel: { type: String, default: null },
    category: { type: String, default: null },
    damage: { type: String, default: null },
    condition: { type: String, default: null },
    yard: { type: String, default: null },
    consignor: { type: String, default: null },
    saleStatus: { type: String, default: null },
    reason: { type: String, required: true },
    manualDecision: { type: String, default: null },
    decisionMode: { type: String, default: null },
    status: { type: String, enum: ['pending', 'approved', 'open', 'resolved'], default: 'pending' },
    ignoredCount: { type: Number, default: 1 },
    firstIgnoredAt: { type: Date, required: true },
    lastIgnoredAt: { type: Date, required: true },
    lastEvent: { type: Schema.Types.Mixed, required: true },
    resolvedAt: { type: Date, default: null },
    resolution: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: String, default: null },
    promotedVehicleId: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'ignored_live_auction_lots', timestamps: true },
)

IgnoredLiveAuctionLotSchema.index({ status: 1, source: 1, lastIgnoredAt: -1 })
IgnoredLiveAuctionLotSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const IgnoredLiveAuctionLotModel =
  (models['ignored_live_auction_lots'] as mongoose.Model<IgnoredLiveAuctionLotDocument> | undefined) ??
  model<IgnoredLiveAuctionLotDocument>('ignored_live_auction_lots', IgnoredLiveAuctionLotSchema)
