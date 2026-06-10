import type { VehicleRecord, FavoriteRecord } from '#shared/types/vehicle'
import { VehicleModel } from '../../../utils/schemas/vehicle'
import { FavoriteModel } from '../../../utils/schemas/favorite'
import { sendVehicleToZApi } from '../../../utils/zapi'

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const doc = await VehicleModel.findById(id).lean()
  if (!doc) throw createError({ statusCode: 404, message: 'Veículo não encontrado' })

  const vehicle: VehicleRecord = { ...doc, _id: String((doc as Record<string, unknown>)['_id']) } as VehicleRecord

  if (vehicle.status === 'sent' || vehicle.status === 'favorite') {
    throw createError({ statusCode: 409, message: 'Veículo já foi enviado' })
  }

  const zapiResult = await sendVehicleToZApi(vehicle)
  if (!zapiResult.ok) {
    throw createError({
      statusCode: 502,
      message: `Falha no envio Z-API: ${zapiResult.reason ?? 'erro desconhecido'}`,
    })
  }

  const sentAt = new Date()
  const sentTo = process.env['ZAPI_PHONE'] ?? process.env['Z_PHONE'] ?? ''

  const fipePercent =
    vehicle.price != null && vehicle.fipe != null && vehicle.fipe > 0
      ? Math.round((vehicle.price / vehicle.fipe) * 100)
      : null

  const [updatedDoc, favoriteDoc] = await Promise.all([
    VehicleModel.findByIdAndUpdate(
      id,
      { status: 'sent', sentAt, sentTo },
      { new: true, lean: true },
    ),
    FavoriteModel.findOneAndUpdate(
      { vehicleId: String(id) },
      {
        $setOnInsert: {
          vehicleId: String(id),
          source: vehicle.source,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year,
          url: vehicle.url,
          imageUrls: vehicle.imageUrls,
          priceAtSend: vehicle.price,
          fipeAtSend: vehicle.fipe,
          fipePercent,
          sentAt,
          sentTo,
          soldPrice: null,
          soldAt: null,
          soldFipe: null,
          soldFipePercent: null,
          notes: null,
          historyCheckedAt: null,
        } satisfies Omit<FavoriteRecord, '_id'>,
      },
      { upsert: true, new: true, lean: true },
    ),
  ])

  const favorite: FavoriteRecord = {
    ...favoriteDoc,
    _id: String((favoriteDoc as Record<string, unknown>)['_id']),
  } as FavoriteRecord

  return {
    vehicle: updatedDoc ? { ...updatedDoc, _id: String((updatedDoc as Record<string, unknown>)['_id']) } : null,
    favorite,
    zapiResponse: zapiResult.zapiResponse,
  }
})
