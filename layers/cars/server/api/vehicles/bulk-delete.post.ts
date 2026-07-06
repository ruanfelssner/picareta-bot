import { VehicleModel } from '../../utils/schemas/vehicle'

const MAX_BULK_DELETE = 200

export default defineEventHandler(async (event) => {
  useDb()

  const rawBody = await readBody<unknown>(event).catch((): unknown => null)
  if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw createError({ statusCode: 400, message: 'Corpo inválido' })
  }

  const body = rawBody as Record<string, unknown>
  const ids = body['ids']
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(id => typeof id === 'string' && id.trim())) {
    throw createError({ statusCode: 400, message: 'Informe uma lista de IDs para excluir' })
  }
  if (ids.length > MAX_BULK_DELETE) {
    throw createError({ statusCode: 400, message: `Máximo de ${MAX_BULK_DELETE} veículos por vez` })
  }

  const result = await VehicleModel.deleteMany({ _id: { $in: ids } })

  return { deletedCount: result.deletedCount ?? 0 }
})
