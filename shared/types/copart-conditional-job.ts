export type CopartConditionalJobStatus = 'queued' | 'claimed' | 'completed' | 'failed'

export type CopartConditionalJobResultStatus = 'pending' | 'approved' | 'refused' | 'removed' | 'blocked'

export type CopartConditionalJobResult = {
  status: CopartConditionalJobResultStatus
  statusRaw: string | null
  nextAuctionDate: string | null
  originalAuctionDate?: string | null
  currentBid: number | null
  error: string | null
  source: 'extension'
}

export type CopartConditionalJob = {
  jobId: string
  runId: string
  vehicleId: string
  url: string
  lot: string | null
  originalAuctionDate: string | null
  status: CopartConditionalJobStatus
  workerId: string | null
  attempts: number
  availableAt: string
  claimedAt: string | null
  finishedAt: string | null
  result: CopartConditionalJobResult | null
  error: string | null
}
