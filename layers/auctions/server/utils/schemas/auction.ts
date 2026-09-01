import mongoose from 'mongoose'
import type { AuctionRecord, BidRecord, WhatsAppCommunityRecord, WhatsAppEventRecord } from '#shared/types/auction'

const { Schema, model, models } = mongoose

const AuctionSchema = new Schema<Omit<AuctionRecord, '_id'>>(
  {
    vehicleId: { type: String, required: true, index: true },
    status: { type: String, enum: ['draft', 'available', 'finished'], required: true, default: 'draft', index: true },
    startingBid: { type: Number, required: true, min: 1 },
    increment: { type: Number, required: true, min: 1 },
    currentBid: { type: Number, default: null },
    winnerBidId: { type: String, default: null },
    autoApproveBids: { type: Boolean, required: true, default: true },
    publicSlug: { type: String, required: true, unique: true, index: true },
    publishedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'auctions', versionKey: false },
)

const BidSchema = new Schema<Omit<BidRecord, '_id'>>(
  {
    auctionId: { type: String, required: true, index: true },
    bidderName: { type: String, required: true },
    amount: { type: Number, required: true, min: 1 },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], required: true, index: true },
    rejectionReason: { type: String, default: null },
    sessionId: { type: String, default: null },
    ipAddress: { type: String, default: null },
    userAgent: { type: String, default: null },
    createdAt: { type: Date, required: true },
    acceptedAt: { type: Date, default: null },
    rejectedAt: { type: Date, default: null },
  },
  { collection: 'auction_bids', versionKey: false },
)
BidSchema.index({ auctionId: 1, createdAt: -1 })
BidSchema.index({ auctionId: 1, status: 1, amount: 1 })

const CommunitySchema = new Schema<Omit<WhatsAppCommunityRecord, '_id'>>(
  {
    name: { type: String, required: true },
    zapiCommunityId: { type: String, required: true },
    announcementGroupId: { type: String, required: true },
    invitationLink: { type: String, default: null },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { collection: 'whatsapp_communities', versionKey: false },
)

const EventSchema = new Schema<Omit<WhatsAppEventRecord, '_id'>>(
  {
    type: { type: String, enum: ['AUCTION_PUBLISHED', 'BID_ACCEPTED', 'AUCTION_FINISHED'], required: true },
    auctionId: { type: String, required: true, index: true },
    bidId: { type: String, default: null },
    message: { type: String, required: true },
    imageUrl: { type: String, default: null },
    status: { type: String, enum: ['pending', 'sending', 'sent', 'failed'], required: true, default: 'pending', index: true },
    retryCount: { type: Number, required: true, default: 0 },
    lastError: { type: String, default: null },
    createdAt: { type: Date, required: true },
    sentAt: { type: Date, default: null },
  },
  { collection: 'whatsapp_events', versionKey: false },
)

export const AuctionModel = (models.auctions as mongoose.Model<Omit<AuctionRecord, '_id'>> | undefined)
  ?? model<Omit<AuctionRecord, '_id'>>('auctions', AuctionSchema)
export const BidModel = (models.auction_bids as mongoose.Model<Omit<BidRecord, '_id'>> | undefined)
  ?? model<Omit<BidRecord, '_id'>>('auction_bids', BidSchema)
export const CommunityModel = (models.whatsapp_communities as mongoose.Model<Omit<WhatsAppCommunityRecord, '_id'>> | undefined)
  ?? model<Omit<WhatsAppCommunityRecord, '_id'>>('whatsapp_communities', CommunitySchema)
export const WhatsAppEventModel = (models.whatsapp_events as mongoose.Model<Omit<WhatsAppEventRecord, '_id'>> | undefined)
  ?? model<Omit<WhatsAppEventRecord, '_id'>>('whatsapp_events', EventSchema)
