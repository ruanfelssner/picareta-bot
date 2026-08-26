import { assertLiveAuctionExtensionAuthorized } from '../../../utils/live-auction-extension-auth'
import { IgnoredLiveAuctionLotModel } from '../../../utils/schemas/ignored-live-auction-lot'

const SUPPORTED_SOURCES = new Set(['copart', 'vipleiloes', 'sodre'])

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)

  const query = getQuery(event)
  const requestedSource = typeof query['source'] === 'string' ? query['source'].trim() : ''
  const source = SUPPORTED_SOURCES.has(requestedSource) ? requestedSource : null
  const requestedStatus = query['status'] === 'resolved' ? 'resolved' : 'pending'
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(query['limit'] ?? '30'), 10) || 30))
  const search = typeof query['search'] === 'string' ? query['search'].trim().slice(0, 80) : ''
  const filter: Record<string, unknown> = requestedStatus === 'pending'
    ? { status: { $in: ['pending', 'open'] } }
    : { status: requestedStatus }
  if (source) filter['source'] = source
  if (search) {
    const regex = { $regex: escapeRegex(search), $options: 'i' }
    filter['$or'] = [{ brand: regex }, { model: regex }, { category: regex }, { lot: regex }, { code: regex }]
  }

  const [documents, total, counts] = await Promise.all([
    IgnoredLiveAuctionLotModel.find(filter).sort({ lastIgnoredAt: -1 }).limit(limit).lean(),
    IgnoredLiveAuctionLotModel.countDocuments(filter),
    IgnoredLiveAuctionLotModel.aggregate([
      { $match: source ? { status: { $in: ['pending', 'open'] }, source } : { status: { $in: ['pending', 'open'] } } },
      { $group: { _id: '$source', count: { $sum: 1 } } },
    ]),
  ])

  return {
    ok: true,
    items: documents.map(document => ({
      ...document,
      _id: String((document as Record<string, unknown>)['_id']),
    })),
    total,
    counts: Object.fromEntries(counts.map(item => [String(item['_id']), Number(item['count'])])),
  }
})
