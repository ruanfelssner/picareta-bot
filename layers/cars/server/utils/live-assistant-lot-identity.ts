type LotIdentity = {
  source: string
  code: string | null
  vehicleUrl: string | null
  auctionId: string | null
  lot: string | null
}

type LotCandidate = {
  source: string
  url: string
  title: string
  description: string
  auctionId?: string | null
  lot: string | null
}

export function liveLotCodePattern(code: string): RegExp {
  const escaped = code.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i')
}

export function isSameLiveAssistantLot(input: LotIdentity, candidate: LotCandidate): boolean {
  if (input.source !== candidate.source) return false
  // Código oficial tem precedência: sem ele, nunca herdar dados de um similar.
  if (input.code) {
    const pattern = liveLotCodePattern(input.code)
    return [candidate.url, candidate.title, candidate.description].some(value => pattern.test(value))
  }
  if (input.vehicleUrl && candidate.url === input.vehicleUrl) return true
  return Boolean(input.auctionId && input.lot
    && input.auctionId === candidate.auctionId && input.lot === candidate.lot)
}
