import { VehicleModel } from '../../utils/schemas/vehicle'

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const deleted = await VehicleModel.findByIdAndDelete(id).lean()
  if (!deleted) throw createError({ statusCode: 404, message: 'Veículo não encontrado' })

  return { ok: true }
})
