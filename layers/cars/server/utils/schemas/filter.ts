import mongoose from 'mongoose'
import type { AuctionFilters, AuctionComboRule } from '#shared/types/filters'

const { Schema, model, models } = mongoose

const ComboRuleSchema = new Schema<AuctionComboRule>(
  {
    id: { type: String, required: true },
    enabled: { type: Boolean, required: true },
    mode: { type: String, enum: ['include', 'exclude'], required: true },
    brand: { type: String, default: null },
    model: { type: String, default: null },
    text: { type: String, default: null },
    minYear: { type: Number, default: null },
  },
  { _id: false },
)

const FilterSchema = new Schema<Omit<AuctionFilters, 'updatedAt'>>(
  {
    states: { type: [String], default: ['PR', 'SC', 'SP', 'RS'] },
    cities: { type: [String], default: [] },
    comboRules: { type: [ComboRuleSchema], default: [] },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'auction_filters', timestamps: false },
)

export const FilterModel =
  (models['auction_filters'] as mongoose.Model<Omit<AuctionFilters, 'updatedAt'>> | undefined) ??
  model<Omit<AuctionFilters, 'updatedAt'>>('auction_filters', FilterSchema)
