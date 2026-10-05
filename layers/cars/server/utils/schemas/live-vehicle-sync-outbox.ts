import mongoose from 'mongoose'

export interface LiveVehicleSyncDocument {
  identityKey: string
  revision: string
  payload: Record<string, unknown>
  status: 'pending' | 'synced'
  attempts: number
  nextAttemptAt: Date
  leaseToken: string | null
  leaseUntil: Date | null
  lastError: string | null
  createdAt: Date
  updatedAt: Date
  syncedAt: Date | null
  expiresAt: Date | null
}

const schema = new mongoose.Schema<LiveVehicleSyncDocument>({
  identityKey: { type: String, required: true, unique: true },
  revision: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, required: true },
  status: { type: String, enum: ['pending', 'synced'], required: true },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, required: true },
  leaseToken: { type: String, default: null },
  leaseUntil: { type: Date, default: null },
  lastError: { type: String, default: null },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  syncedAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },
}, { collection: 'live_vehicle_sync_outbox', timestamps: false })
schema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 })
// Pendências não expiram: apenas recebimentos confirmados podem ser removidos.
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
export const LiveVehicleSyncOutboxModel =
  (mongoose.models['live_vehicle_sync_outbox'] as mongoose.Model<LiveVehicleSyncDocument> | undefined)
  ?? mongoose.model<LiveVehicleSyncDocument>('live_vehicle_sync_outbox', schema)
