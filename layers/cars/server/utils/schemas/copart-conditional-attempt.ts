import mongoose from 'mongoose'
import type {
  CopartConditionalAttemptStatus,
  CopartConditionalCheckTrigger,
} from '#shared/types/copart-conditional-check'

const { Schema, model, models } = mongoose

export interface CopartConditionalAttemptRecord {
  runId: string
  vehicleId: string
  url: string
  lot: string | null
  title: string | null
  brand: string | null
  model: string | null
  year: number | null
  trigger: CopartConditionalCheckTrigger
  status: CopartConditionalAttemptStatus
  statusRaw: string | null
  startedAt: Date
  finishedAt: Date | null
  checkedAt: Date | null
  durationMs: number | null
  originalAuctionDate: Date | null
  auctionDate: Date | null
  nextAuctionDate: Date | null
  error: string | null
}

const CopartConditionalAttemptSchema = new Schema<CopartConditionalAttemptRecord>(
  {
    runId: { type: String, required: true, index: true },
    vehicleId: { type: String, required: true, index: true },
    url: { type: String, required: true },
    lot: { type: String, default: null },
    title: { type: String, default: null },
    brand: { type: String, default: null },
    model: { type: String, default: null },
    year: { type: Number, default: null },
    trigger: { type: String, enum: ['schedule', 'manual'], required: true },
    status: {
      type: String,
      enum: ['running', 'pending', 'approved', 'refused', 'error', 'skipped'],
      required: true,
      index: true,
    },
    statusRaw: { type: String, default: null },
    startedAt: { type: Date, required: true, index: true },
    finishedAt: { type: Date, default: null },
    checkedAt: { type: Date, default: null },
    durationMs: { type: Number, default: null },
    originalAuctionDate: { type: Date, default: null },
    auctionDate: { type: Date, default: null },
    nextAuctionDate: { type: Date, default: null },
    error: { type: String, default: null },
  },
  { collection: 'copart_conditional_attempts', timestamps: false },
)

CopartConditionalAttemptSchema.index({ vehicleId: 1, startedAt: -1 })
CopartConditionalAttemptSchema.index({ status: 1, startedAt: -1 })

export const CopartConditionalAttemptModel =
  (models['copart_conditional_attempts'] as mongoose.Model<CopartConditionalAttemptRecord> | undefined) ??
  model<CopartConditionalAttemptRecord>('copart_conditional_attempts', CopartConditionalAttemptSchema)
