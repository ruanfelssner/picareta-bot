import type { FavoriteRecord } from '#shared/types/vehicle'
import { FavoriteModel } from '../../utils/schemas/favorite'

export default defineEventHandler(async (event) => {
  useDb()

  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10))
  const limit = Math.min(200, Math.max(1, parseInt(String(query['limit'] ?? '50'), 10)))
  const skip = (page - 1) * limit

  const [docs, total] = await Promise.all([
    FavoriteModel.find().sort({ sentAt: -1 }).skip(skip).limit(limit).lean(),
    FavoriteModel.countDocuments(),
  ])

  const favorites: FavoriteRecord[] = docs.map(doc => ({
    ...doc,
    _id: String((doc as Record<string, unknown>)['_id']),
  })) as FavoriteRecord[]

  return { favorites, total, page, limit }
})
