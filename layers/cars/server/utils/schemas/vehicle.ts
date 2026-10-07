import mongoose from 'mongoose'
import type { VehicleRecord } from '#shared/types/vehicle'

const { Schema, model, models } = mongoose

const ExtensionCaptureActorSchema = new Schema(
  {
    userId: { type: String, required: true },
    phone: { type: String, required: true },
    name: { type: String, required: true },
    deviceId: { type: String, required: true },
    capturedAt: { type: Date, required: true },
  },
  { _id: false },
)

const VehicleSchema = new Schema<Omit<VehicleRecord, '_id'>>(
  {
    source: { type: String, required: true },
    externalId: { type: String, required: true },
    brand: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, default: null },
    color: { type: String, default: null },
    km: { type: String, default: null },
    fuel: { type: String, default: null },
    title: { type: String, required: true },
    description: { type: String, default: '' },
    version: { type: String, default: null },
    category: { type: String, default: null },
    price: { type: Number, default: null },
    priceRaw: { type: String, default: null },
    url: { type: String, required: true },
    imageUrls: { type: [String], default: [] },
    auctionId: { type: String, default: null },
    auctionSessionKey: { type: String, default: null },
    auctionDate: { type: Date, default: null },
    auctionUrl: { type: String, default: null },
    auctionTimeKnown: { type: Boolean, default: null },
    auctionEndsAt: { type: Date, default: null },
    lot: { type: String, default: null },
    chassisRaw: { type: String, default: null },
    chassisNormalized: { type: String, default: null },
    damage: { type: String, default: null },
    condition: { type: String, default: null },
    yard: { type: String, default: null },
    consignor: { type: String, default: null },
    auctionStatus: {
      type: String,
      enum: ['unknown', 'upcoming', 'future', 'finished'],
      default: 'unknown',
    },
    auctionStatusRaw: { type: String, default: null },
    auctionStatusCheckedAt: { type: Date, default: null },
    saleStatus: {
      type: String,
      enum: ['unknown', 'sold', 'conditional', 'not_sold'],
      default: 'unknown',
    },
    saleStatusRaw: { type: String, default: null },
    saleStatusCheckedAt: { type: Date, default: null },
    conditionalStatus: {
      type: String,
      enum: ['pending', 'approved', 'refused', null],
      default: null,
    },
    conditionalStatusRaw: { type: String, default: null },
    conditionalOriginalAuctionDate: { type: Date, default: null },
    conditionalStatusCheckedAt: { type: Date, default: null },
    soldPrice: { type: Number, default: null },
    soldPriceRaw: { type: String, default: null },
    fipe: { type: Number, default: null },
    fipeCode: { type: String, default: null },
    fipeReferenceMonth: { type: String, default: null },
    fipeFuel: { type: String, default: null },
    fipeCheckedAt: { type: Date, default: null },
    fipeBrandMatched: { type: String, default: null },
    fipeModelMatched: { type: String, default: null },
    location: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    scrapedAt: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
    status: {
      type: String,
      enum: ['scraped', 'sent', 'favorite'],
      default: 'scraped',
    },
    sentAt: { type: Date, default: null },
    sentTo: { type: String, default: null },
    collectedVia: { type: String, enum: ['extension'], default: null },
    captureUserIds: { type: [String], default: [] },
    lastCapturedBy: { type: ExtensionCaptureActorSchema, default: null },
  },
  { collection: 'scraped_vehicles', timestamps: false },
)

VehicleSchema.index({ externalId: 1 }, { unique: true })
VehicleSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })
VehicleSchema.index({ status: 1, scrapedAt: -1 })
VehicleSchema.index({ source: 1, scrapedAt: -1 })
VehicleSchema.index({ auctionSessionKey: 1, lot: 1 })
VehicleSchema.index({ year: 1, brand: 1, model: 1, fipe: 1, fipeCheckedAt: -1 })

export const VehicleModel =
  (models['scraped_vehicles'] as mongoose.Model<Omit<VehicleRecord, '_id'>> | undefined) ??
  model<Omit<VehicleRecord, '_id'>>('scraped_vehicles', VehicleSchema)
