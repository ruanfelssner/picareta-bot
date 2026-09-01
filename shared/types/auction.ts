export type AuctionStatus = 'draft' | 'available' | 'finished'
export type BidStatus = 'pending' | 'accepted' | 'rejected'
export type AuctionEventType = 'AUCTION_PUBLISHED' | 'BID_ACCEPTED' | 'AUCTION_FINISHED'
export type AuctionEventStatus = 'pending' | 'sending' | 'sent' | 'failed'

export interface AuctionRecord {
  _id?: string
  vehicleId: string
  status: AuctionStatus
  startingBid: number
  increment: number
  currentBid: number | null
  winnerBidId: string | null
  autoApproveBids: boolean
  publicSlug: string
  publishedAt: Date | null
  finishedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface BidRecord {
  _id?: string
  auctionId: string
  bidderName: string
  amount: number
  status: BidStatus
  rejectionReason: string | null
  sessionId: string | null
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
  acceptedAt: Date | null
  rejectedAt: Date | null
}

export interface WhatsAppCommunityRecord {
  _id?: string
  name: string
  zapiCommunityId: string
  announcementGroupId: string
  invitationLink: string | null
  createdAt: Date
  updatedAt: Date
}

export interface WhatsAppEventRecord {
  _id?: string
  type: AuctionEventType
  auctionId: string
  bidId: string | null
  message: string
  status: AuctionEventStatus
  retryCount: number
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
}

export interface PublicAuctionVehicle {
  id: string
  brand: string
  model: string
  title: string
  year: number | null
  km: string | null
  fuel: string | null
  fipe: number | null
  imageUrls: string[]
}

export interface PublicBid {
  id: string
  bidderName: string
  amount: number
  createdAt: string
}
