import type { FavoriteRecord } from '#shared/types/vehicle'
import { FavoriteModel } from '../../../utils/schemas/favorite'

// Retorna o FavoriteRecord associado a um veículo, se existir.
// Favoritos são criados via POST /api/vehicles/:id/send — nunca diretamente.
export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const doc = await FavoriteModel.findOne({ vehicleId: String(id) }).lean()
  if (!doc) throw createError({ statusCode: 404, message: 'Favorito não encontrado' })

  const favorite: FavoriteRecord = {
    ...doc,
    _id: String((doc as Record<string, unknown>)['_id']),
  } as FavoriteRecord

  return { favorite }
})
