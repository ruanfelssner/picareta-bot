import { getFipeConfigFromEnv, suggestFipe } from '../../../utils/fipe'
import { VehicleModel } from '../../../utils/schemas/vehicle'

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const doc = await VehicleModel.findById(id).lean()
  if (!doc) throw createError({ statusCode: 404, message: 'Veículo não encontrado' })

  const query = getQuery(event)
  const brand = String(query['brand'] ?? doc.brand ?? '').trim()
  const model = String(query['model'] ?? doc.model ?? '').trim()
  const yearRaw = Number(query['year'] ?? doc.year)
  const year = Number.isFinite(yearRaw) ? Math.floor(yearRaw) : 0
  const limitRaw = Number(query['limit'] ?? 6)
  const limit = Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 6

  const result = await suggestFipe(
    getFipeConfigFromEnv(),
    { brand, model, year },
    { limit },
  )

  if (!result.ok) {
    throw createError({ statusCode: 422, message: result.reason })
  }

  return {
    query: { brand, model, year },
    suggestions: result.data.suggestions,
  }
})
