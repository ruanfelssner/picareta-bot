export type CopartConditionalCheckTrigger = 'schedule' | 'manual'

export type CopartConditionalAttemptStatus =
  | 'running'
  | 'pending'
  | 'approved'
  | 'refused'
  | 'error'
  | 'skipped'
  | 'removed'

export interface CopartConditionalCheckHistoryItem {
  id: string
  runId: string
  vehicleId: string | null
  url: string
  lot: string | null
  title: string | null
  brand: string | null
  model: string | null
  year: number | null
  trigger: CopartConditionalCheckTrigger
  status: CopartConditionalAttemptStatus
  statusRaw: string | null
  startedAt: string
  finishedAt: string | null
  checkedAt: string | null
  durationMs: number | null
  originalAuctionDate: string | null
  auctionDate: string | null
  nextAuctionDate: string | null
  error: string | null
}

export interface CopartConditionalCheckHistoryResponse {
  history: CopartConditionalCheckHistoryItem[]
  total: number
  page: number
  limit: number
  summary: Record<CopartConditionalAttemptStatus, number>
}
