import type { VehicleRecord, VehicleSaleStatus, VehicleSource } from '#shared/types/vehicle'
import { isUsableVehicleImageUrl } from '#shared/utils/vehicle-images'
import { VehicleModel } from '../../utils/schemas/vehicle'

type SortOption = 'recent' | 'price_desc' | 'price_asc' | 'fipe_asc'
type PeriodFilter = 'today' | '7d' | '30d' | 'all'

const LIVE_HISTORY_SOURCES: VehicleSource[] = ['copart', 'vipleiloes']
const FINAL_SALE_STATUSES: VehicleSaleStatus[] = ['sold', 'conditional', 'not_sold']

function isSaleStatus(value: string): value is VehicleSaleStatus {
  return (FINAL_SALE_STATUSES as string[]).includes(value)
}

function isSort(value: unknown): value is SortOption {
  return value === 'recent' || value === 'price_desc' || value === 'price_asc' || value === 'fipe_asc'
}

function isPeriod(value: unknown): value is PeriodFilter {
  return value === 'today' || value === '7d' || value === '30d' || value === 'all'
}

function buildSort(opt: SortOption): Record<string, 1 | -1> {
  switch (opt) {
    case 'price_desc': return { price: -1, scrapedAt: -1 }
    case 'price_asc': return { price: 1, scrapedAt: -1 }
    case 'fipe_asc': return { _fipePct: 1, scrapedAt: -1 }
    default: return { scrapedAt: -1 }
  }
}

export default defineEventHandler(async (event) => {
  useDb()

  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10))
  const limit = Math.min(200, Math.max(1, parseInt(String(query['limit'] ?? '50'), 10)))
  const skip = (page - 1) * limit
  const sort = isSort(query['sort']) ? query['sort'] : 'recent'
  const period = isPeriod(query['period']) ? query['period'] : 'all'

  const sourcesParam = query['sources'] as string | undefined
  const requestedSources = sourcesParam
    ? sourcesParam.split(',').map(s => s.trim()).filter(Boolean) as VehicleSource[]
    : []
  const sources = requestedSources.length > 0
    ? requestedSources.filter(source => LIVE_HISTORY_SOURCES.includes(source))
    : LIVE_HISTORY_SOURCES

  const search = (query['search'] as string | undefined)?.trim()
  const statesParam = query['states'] as string | undefined
  const states = statesParam ? statesParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const saleStatusParam = query['saleStatus'] as string | undefined
  const saleStatuses = saleStatusParam
    ? saleStatusParam.split(',').map(s => s.trim()).filter(isSaleStatus)
    : []

  // A extensão só grava lotes com resultado final (sold/conditional/not_sold) — o mesmo
  // "source" (copart/vipleiloes) também é usado pelo scraper automático de listagens
  // futuras, então restringir a status finalizados é o que isola o histórico da extensão.
  const filter: Record<string, unknown> = {
    source: { $in: sources },
    saleStatus: { $in: saleStatuses.length > 0 ? saleStatuses : FINAL_SALE_STATUSES },
  }

  const andClauses: object[] = []

  if (search) {
    andClauses.push({ $or: [
      { brand: { $regex: search, $options: 'i' } },
      { model: { $regex: search, $options: 'i' } },
      { title: { $regex: search, $options: 'i' } },
    ] })
  }

  if (states.length > 0) {
    filter['state'] = { $in: states.map(uf => uf.toUpperCase()) }
  }

  if (period !== 'all') {
    const now = new Date()
    const from = new Date(now)
    if (period === 'today') from.setHours(0, 0, 0, 0)
    else if (period === '7d') from.setDate(from.getDate() - 7)
    else if (period === '30d') from.setDate(from.getDate() - 30)
    andClauses.push({ scrapedAt: { $gte: from } })
  }

  if (andClauses.length > 0) filter['$and'] = andClauses

  const addFields = {
    _fipePct: {
      $cond: [
        { $and: [{ $ne: ['$fipe', null] }, { $gt: ['$fipe', 0] }, { $ne: ['$price', null] }] },
        { $divide: ['$price', '$fipe'] },
        999,
      ],
    },
  }

  const [docs, total] = await Promise.all([
    VehicleModel.aggregate([
      { $match: filter },
      { $addFields: addFields },
      { $sort: buildSort(sort) },
      { $skip: skip },
      { $limit: limit },
    ]) as Promise<Record<string, unknown>[]>,
    VehicleModel.countDocuments(filter),
  ])

  const vehicles = docs.map((doc) => ({
    ...doc,
    _id: String(doc['_id']),
    imageUrls: Array.isArray(doc['imageUrls'])
      ? doc['imageUrls'].filter((url): url is string => typeof url === 'string' && isUsableVehicleImageUrl(url))
      : [],
  })) as VehicleRecord[]

  return {
    vehicles,
    total,
    page,
    limit,
  }
})
