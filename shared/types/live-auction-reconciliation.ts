import type { LiveAuctionAuditEvent, LiveAuctionAuditSource } from './live-auction-audit'
import type { VehicleSaleStatus } from './vehicle'

export type LiveAuctionEvidenceOrigin =
  | 'local_log'
  | 'server_log'
  | 'bot_capture'
  | 'public_history'
  | 'local_capture'

export type LiveAuctionEvidenceStatus = VehicleSaleStatus | 'open' | null

export interface LiveAuctionSessionAuditSummary {
  sessionKey: string
  source: LiveAuctionAuditSource
  auctionId: string | null
  sessionLabel: string | null
  eventCount: number
  terminalLots: number
  pendingEvents: number
  firstObservedAt: string
  lastObservedAt: string
}

export interface LiveAuctionLotEvidence {
  origin: LiveAuctionEvidenceOrigin
  source: LiveAuctionAuditSource
  sessionKey: string | null
  auctionId: string | null
  lot: string | null
  code: string | null
  status: LiveAuctionEvidenceStatus
  amount: number | null
  title: string | null
  observedAt: string | null
  url: string | null
  eventId: string | null
}

export interface LiveAuctionAuditServerEvent extends LiveAuctionAuditEvent {
  receivedAt: string
  syncStatus: 'pending' | 'synced'
  syncedAt: string | null
  syncAttempts: number
  lastSyncError: string | null
}

export interface LiveAuctionPublicHistoryState {
  status: 'available' | 'unavailable' | 'not_configured'
  error: string | null
  historyUrl: string | null
}

export interface LiveAuctionAuditResponse {
  selectedSessionKey: string | null
  sessions: LiveAuctionSessionAuditSummary[]
  events: LiveAuctionAuditServerEvent[]
  botCaptures: LiveAuctionLotEvidence[]
  publicHistory: LiveAuctionLotEvidence[]
  publicHistoryState: LiveAuctionPublicHistoryState
  generatedAt: string
}

export type LiveAuctionReconciliationIssue =
  | 'missing_local_log'
  | 'missing_local_capture'
  | 'missing_server_log'
  | 'missing_bot_capture'
  | 'missing_public_history'
  | 'status_mismatch'
  | 'amount_mismatch'
  | 'unidentified_lot'

export interface LiveAuctionReconciliationRow {
  key: string
  source: LiveAuctionAuditSource
  sessionKey: string | null
  auctionId: string | null
  lot: string | null
  code: string | null
  title: string | null
  evidence: Partial<Record<LiveAuctionEvidenceOrigin, LiveAuctionLotEvidence>>
  issues: LiveAuctionReconciliationIssue[]
}

