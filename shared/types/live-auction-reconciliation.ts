import type { LiveAuctionAuditEvent, LiveAuctionAuditSource } from './live-auction-audit'
import type { VehicleSaleStatus } from './vehicle'

export type LiveAuctionEvidenceOrigin =
  | 'local_log'
  | 'server_log'
  | 'extension_observation'
  | 'bot_capture'
  | 'public_history'
  | 'local_capture'

export type LiveAuctionEvidenceStatus = VehicleSaleStatus | 'open' | null

export interface LiveAuctionSessionAuditSummary {
  sessionKey: string
  aliases: string[]
  source: LiveAuctionAuditSource
  auctionId: string | null
  sessionLabel: string | null
  eventCount: number
  localLots?: number
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
  fipe: number | null
  damage: string | null
  title: string | null
  observedAt: string | null
  url: string | null
  eventId: string | null
  /** Tipo do último evento do log que originou a evidência (`bid_received`, `lot_announced`…). */
  logKind?: string | null
  captureExpected?: boolean | null
  captureState?: string | null
  captureReason?: string | null
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
  extensionCaptures: LiveAuctionLotEvidence[]
  botCaptures: LiveAuctionLotEvidence[]
  publicHistory: LiveAuctionLotEvidence[]
  publicHistoryState: LiveAuctionPublicHistoryState
  generatedAt: string
}

export type LiveAuctionReconciliationIssue =
  | 'missing_local_log'
  | 'missing_local_result'
  | 'missing_local_capture'
  | 'missing_server_log'
  | 'missing_server_result'
  | 'missing_bot_capture'
  | 'missing_public_history'
  | 'status_mismatch'
  | 'amount_mismatch'
  | 'missing_amount'
  | 'missing_fipe'
  | 'fipe_mismatch'
  | 'missing_damage'
  | 'damage_mismatch'
  | 'vehicle_mismatch'
  | 'unidentified_lot'
  | 'unidentified_vehicle'

export interface LiveAuctionReconciliationRow {
  key: string
  source: LiveAuctionAuditSource
  sessionKey: string | null
  auctionId: string | null
  lot: string | null
  code: string | null
  title: string | null
  fipe: number | null
  damage: string | null
  evidence: Partial<Record<LiveAuctionEvidenceOrigin, LiveAuctionLotEvidence>>
  /** Concordância de cada etapa com o consenso do lote finalizado; vazio enquanto o lote está aberto. */
  agreement: Partial<Record<LiveAuctionEvidenceOrigin, LiveAuctionEvidenceAgreement>>
  issues: LiveAuctionReconciliationIssue[]
}

export type LiveAuctionEvidenceAgreement = 'match' | 'mismatch'

