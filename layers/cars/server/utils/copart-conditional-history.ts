import type {
  CopartConditionalAttemptStatus,
  CopartConditionalCheckHistoryItem,
  CopartConditionalCheckHistoryResponse,
} from '#shared/types/copart-conditional-check'
import { CopartConditionalAttemptModel } from './schemas/copart-conditional-attempt'

const STATUS_VALUES: CopartConditionalAttemptStatus[] = [
  'running',
  'pending',
  'approved',
  'refused',
  'error',
  'skipped',
]

type HistoryQuery = {
  page?: unknown
  limit?: unknown
  status?: unknown
}

function parsePositiveInt(value: unknown, fallback: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(max, parsed)
}

function parseStatus(value: unknown): CopartConditionalAttemptStatus | null {
  return typeof value === 'string' && STATUS_VALUES.includes(value as CopartConditionalAttemptStatus)
    ? value as CopartConditionalAttemptStatus
    : null
}

function toIso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toHistoryItem(doc: Record<string, unknown>): CopartConditionalCheckHistoryItem {
  const status = parseStatus(doc.status) ?? 'error'
  const year = typeof doc.year === 'number' && Number.isFinite(doc.year) ? doc.year : null
  const durationMs = typeof doc.durationMs === 'number' && Number.isFinite(doc.durationMs)
    ? Math.max(0, Math.round(doc.durationMs))
    : null

  return {
    id: String(doc._id ?? ''),
    runId: String(doc.runId ?? ''),
    vehicleId: typeof doc.vehicleId === 'string' ? doc.vehicleId : null,
    url: typeof doc.url === 'string' ? doc.url : '',
    lot: typeof doc.lot === 'string' ? doc.lot : null,
    title: typeof doc.title === 'string' ? doc.title : null,
    brand: typeof doc.brand === 'string' ? doc.brand : null,
    model: typeof doc.model === 'string' ? doc.model : null,
    year,
    trigger: doc.trigger === 'manual' ? 'manual' : 'schedule',
    status,
    statusRaw: typeof doc.statusRaw === 'string' ? doc.statusRaw : null,
    startedAt: toIso(doc.startedAt as Date | string | null) ?? new Date(0).toISOString(),
    finishedAt: toIso(doc.finishedAt as Date | string | null),
    checkedAt: toIso(doc.checkedAt as Date | string | null),
    durationMs,
    originalAuctionDate: toIso(doc.originalAuctionDate as Date | string | null),
    auctionDate: toIso(doc.auctionDate as Date | string | null),
    nextAuctionDate: toIso(doc.nextAuctionDate as Date | string | null),
    error: typeof doc.error === 'string' ? doc.error : null,
  }
}

export async function listCopartConditionalHistory(query: HistoryQuery = {}): Promise<CopartConditionalCheckHistoryResponse> {
  const page = parsePositiveInt(query.page, 1, 10_000)
  const limit = parsePositiveInt(query.limit, 30, 100)
  const status = parseStatus(query.status)
  const filter: Record<string, unknown> = status ? { status } : {}
  const skip = (page - 1) * limit

  const [docs, total, grouped] = await Promise.all([
    CopartConditionalAttemptModel.find(filter)
      .sort({ startedAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .lean()
      .exec(),
    CopartConditionalAttemptModel.countDocuments(filter).exec(),
    CopartConditionalAttemptModel.aggregate<{ _id: CopartConditionalAttemptStatus; count: number }>([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]).exec(),
  ])

  const summary = Object.fromEntries(STATUS_VALUES.map(value => [value, 0])) as Record<CopartConditionalAttemptStatus, number>
  for (const item of grouped) {
    if (STATUS_VALUES.includes(item._id)) summary[item._id] = item.count
  }

  return {
    history: docs.map(doc => toHistoryItem(doc as unknown as Record<string, unknown>)),
    total,
    page,
    limit,
    summary,
  }
}
