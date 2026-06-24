import type { FavoriteRecord, VehicleRecord } from '#shared/types/vehicle'
import { FavoriteModel } from '../../utils/schemas/favorite'
import { VehicleModel } from '../../utils/schemas/vehicle'

type FavoriteWithCurrentVehicle = FavoriteRecord & {
  currentVehicle: VehicleRecord | null
}

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

  const vehicleIds = favorites
    .map(favorite => favorite.vehicleId)
    .filter(Boolean)

  const vehicleDocs = vehicleIds.length > 0
    ? await VehicleModel.find({ _id: { $in: vehicleIds } }).lean()
    : []

  const currentVehicleById = new Map<string, VehicleRecord>(
    vehicleDocs.map((doc) => {
      const vehicle = {
        ...doc,
        _id: String((doc as Record<string, unknown>)['_id']),
      } as VehicleRecord
      return [vehicle._id!, vehicle]
    }),
  )

  const hydratedFavorites: FavoriteWithCurrentVehicle[] = favorites.map(favorite => ({
    ...favorite,
    currentVehicle: currentVehicleById.get(favorite.vehicleId) ?? null,
  }))

  return { favorites: hydratedFavorites, total, page, limit }
})
