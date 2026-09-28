import mongoose from 'mongoose'

export interface LiveAuctionCaptureDocument {
  identityKey: string
  source: string
  auctionId: string | null
  lot: string | null
  code: string | null
  vehicleUrl: string | null
  brand: string | null
  model: string | null
  yearModel: string | null
  captureUserIds: string[]
  lastCapturedBy: {
    userId: string
    phone: string
    name: string
    deviceId: string
    capturedAt: Date
  }
  firstCapturedAt: Date
  lastCapturedAt: Date
  captureCount: number
  lastEvent: Record<string, unknown>
  expiresAt: Date
}

const { Schema, model, models } = mongoose

const CaptureActorSchema = new Schema(
  {
    userId: { type: String, required: true },
    phone: { type: String, required: true },
    name: { type: String, required: true },
    deviceId: { type: String, required: true },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
)

const LiveAuctionCaptureSchema = new Schema<LiveAuctionCaptureDocument>(
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
    captureUserIds: { type: [String], default: [] },
    lastCapturedBy: { type: CaptureActorSchema, required: true },
    firstCapturedAt: { type: Date, required: true },
    lastCapturedAt: { type: Date, required: true },
    captureCount: { type: Number, default: 0 },
    lastEvent: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, required: true },
  },
  { collection: 'live_auction_capture_observations', timestamps: false },
)

LiveAuctionCaptureSchema.index({ source: 1, lastCapturedAt: -1 })
LiveAuctionCaptureSchema.index({ captureUserIds: 1, lastCapturedAt: -1 })
LiveAuctionCaptureSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

export const LiveAuctionCaptureModel =
  (models['live_auction_capture_observations'] as mongoose.Model<LiveAuctionCaptureDocument> | undefined)
  ?? model<LiveAuctionCaptureDocument>('live_auction_capture_observations', LiveAuctionCaptureSchema)
