export type AuctionArchiveOrigin = 'log' | 'outbox' | 'capture' | 'vehicle' | 'result' | 'catalog'

export interface AuctionArchiveEvidence {
  id: string
  origin: AuctionArchiveOrigin
  sessionKey: string
  source: string
  auctionId: string | null
  lot: string | null
  code: string | null
  title: string | null
  observedAt: string | null
  message: string | null
  amount: number | null
  fipe: number | null
  status: string | null
  kind: string | null
  url: string | null
  eventId: string | null
}

export interface AuctionArchiveSession {
  sessionKey: string
  source: string
  auctionId: string | null
  label: string
  lastEventAt: string | null
  recordCount: number
  rawCount: number
  sample: { lot: string | null; code: string | null; title: string | null }
}

export interface AuctionArchivePage<T> {
  items: T[]
  total: number
  page: number
  pageSize: number
}

export interface AuctionArchiveEvidencePage extends AuctionArchivePage<AuctionArchiveEvidence> {
  rawCount: number
}
