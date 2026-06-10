import type { VehicleRecord, VehicleStatus, VehicleSource } from '#shared/types/vehicle'
import { VehicleModel } from '../../utils/schemas/vehicle'

export default defineEventHandler(async (event) => {
  useDb()

  const query = getQuery(event)
  const status = (query['status'] as VehicleStatus | undefined) ?? 'scraped'
  const source = query['source'] as VehicleSource | undefined
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10))
  const limit = Math.min(200, Math.max(1, parseInt(String(query['limit'] ?? '50'), 10)))
  const skip = (page - 1) * limit

  const filter: Record<string, unknown> = { status }
  if (source) filter['source'] = source

  const [docs, total] = await Promise.all([
    VehicleModel.find(filter).sort({ scrapedAt: -1 }).skip(skip).limit(limit).lean(),
    VehicleModel.countDocuments(filter),
  ])

  const vehicles: VehicleRecord[] = docs.map(doc => ({
    ...doc,
    _id: String((doc as Record<string, unknown>)['_id']),
  })) as VehicleRecord[]

  return { vehicles, total, page, limit }
})
