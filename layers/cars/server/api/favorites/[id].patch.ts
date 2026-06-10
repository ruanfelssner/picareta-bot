import type { FavoriteRecord } from '#shared/types/vehicle'
import { FavoriteModel } from '../../utils/schemas/favorite'

interface PatchBody {
  soldPrice?: number | null
  soldAt?: string | null
  soldFipe?: number | null
  notes?: string | null
  historyCheckedAt?: string | null
}

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const body = await readBody<PatchBody>(event)

  const update: Record<string, unknown> = {}

  if ('soldPrice' in body) update['soldPrice'] = body.soldPrice ?? null
  if ('soldAt' in body) update['soldAt'] = body.soldAt ? new Date(body.soldAt) : null
  if ('soldFipe' in body) update['soldFipe'] = body.soldFipe ?? null
  if ('notes' in body) update['notes'] = body.notes ?? null
  if ('historyCheckedAt' in body) {
    update['historyCheckedAt'] = body.historyCheckedAt ? new Date(body.historyCheckedAt) : null
  }

  // Calcular soldFipePercent quando soldPrice e soldFipe presentes
  const soldPrice = ('soldPrice' in body ? body.soldPrice : undefined) ?? null
  const soldFipe = ('soldFipe' in body ? body.soldFipe : undefined) ?? null
  if (soldPrice != null && soldFipe != null && soldFipe > 0) {
    update['soldFipePercent'] = Math.round((soldPrice / soldFipe) * 100)
  } else if ('soldPrice' in body || 'soldFipe' in body) {
    // Um dos dois foi zerado — limpar o percentual calculado
    update['soldFipePercent'] = null
  }

  if (Object.keys(update).length === 0) {
    throw createError({ statusCode: 400, message: 'Nenhum campo para atualizar' })
  }

  const doc = await FavoriteModel.findByIdAndUpdate(id, { $set: update }, { new: true, lean: true })
  if (!doc) throw createError({ statusCode: 404, message: 'Favorito não encontrado' })

  const favorite: FavoriteRecord = {
    ...doc,
    _id: String((doc as Record<string, unknown>)['_id']),
  } as FavoriteRecord

  return { favorite }
})
