import mongoose from 'mongoose'
import type { FavoriteRecord } from '#shared/types/vehicle'

const { Schema, model, models } = mongoose

const FavoriteSchema = new Schema<Omit<FavoriteRecord, '_id'>>(
  {
    vehicleId: { type: String, required: true },
    source: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, default: null },
    url: { type: String, required: true },
    imageUrls: { type: [String], default: [] },
    priceAtSend: { type: Number, default: null },
    fipeAtSend: { type: Number, default: null },
    fipePercent: { type: Number, default: null },
    sentAt: { type: Date, required: true },
    sentTo: { type: String, required: true },
    soldPrice: { type: Number, default: null },
    soldAt: { type: Date, default: null },
    soldFipe: { type: Number, default: null },
    soldFipePercent: { type: Number, default: null },
    notes: { type: String, default: null },
    historyCheckedAt: { type: Date, default: null },
  },
  { collection: 'favorites', timestamps: false },
)

FavoriteSchema.index({ vehicleId: 1 }, { unique: true })
FavoriteSchema.index({ sentAt: -1 })
FavoriteSchema.index({ source: 1 })

export const FavoriteModel =
  (models['favorites'] as mongoose.Model<Omit<FavoriteRecord, '_id'>> | undefined) ??
  model<Omit<FavoriteRecord, '_id'>>('favorites', FavoriteSchema)
