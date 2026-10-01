const EVENT_FIELDS = [
  'source', 'auctionId', 'lot', 'code', 'description', 'version', 'yearModel', 'brand', 'model',
  'category', 'fipe', 'fipeRaw', 'damage', 'condition', 'yard', 'consignor', 'bid', 'bidRaw',
  'saleStatus', 'eventType', 'imageUrl', 'vehicleUrl', 'message', 'observedAt',
] as const

function text(value: unknown, max = 1_000): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

// Atualizações pontuais preservam campos ausentes em leituras parciais.
export function buildLiveAuctionCaptureFields(input: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  const detailPage = input['captureContext'] === 'vehicle_detail'
  const resultFields = new Set(['bid', 'bidRaw', 'saleStatus', 'eventType', 'message'])
  const summaryFields = new Set(['source', 'auctionId', 'lot', 'code', 'vehicleUrl', 'brand', 'model', 'yearModel'])
  for (const key of EVENT_FIELDS) {
    if (detailPage && (resultFields.has(key) || key === 'auctionId' || key === 'lot')) continue
    const raw = input[key]
    const value = key === 'fipe' || key === 'bid'
      ? typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null
      : text(raw, key === 'vehicleUrl' || key === 'imageUrl' ? 4_096 : 1_000)
    if (value == null) continue
    fields[`lastEvent.${key}`] = value
    if (summaryFields.has(key)) fields[key] = value
  }
  return fields
}

