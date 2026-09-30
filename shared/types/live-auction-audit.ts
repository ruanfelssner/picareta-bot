import type { VehicleSource } from './vehicle'

export type LiveAuctionAuditSource = Extract<VehicleSource, 'copart' | 'vipleiloes' | 'sodre'>
export type LiveAuctionAuditKind =
  | 'session_detected'
  | 'session_started'
  | 'session_finished'
  | 'lot_announced'
  | 'lot_opened'
  | 'lot_changed'
  | 'bid_received'
  | 'bid_updated'
  | 'lot_sold'
  | 'lot_conditional'
  | 'lot_not_sold'
  | 'message_unclassified'
  | 'collector_connected'
  | 'collector_disconnected'
  | 'sync_failed'
  | 'sync_recovered'

export interface LiveAuctionAuditEvent {
  schemaVersion: 1
  eventId: string
  sessionKey: string
  source: LiveAuctionAuditSource
  auctionId: string | null
  sessionLabel: string | null
  sequence: number
  observedAt: string
  rawText: string
  normalizedText: string
  kind: LiveAuctionAuditKind
  lot: string | null
  code: string | null
  amount: number | null
  parserVersion: number
  chassisRaw: string | null
  chassisNormalized: string | null
  vehicleUrl: string | null
  description: string | null
  consignor: string | null
  yard: string | null
  extensionVersion: string | null
  collectorUserId: string | null
  deviceId: string | null
}

export interface LiveAuctionAuditBatch {
  schemaVersion: 1
  batchId: string
  sessionKey: string
  events: LiveAuctionAuditEvent[]
}
