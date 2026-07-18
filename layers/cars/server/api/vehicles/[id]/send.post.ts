import type { VehicleRecord, FavoriteRecord } from '#shared/types/vehicle'
import { buildVehicleMarketAnalysis, loadMarketHistory } from '../../../utils/vehicle-market-analysis'
import { canSendVehicleToWhatsapp, withEffectiveAuctionLifecycle } from '../../../utils/auction-lifecycle'
import { VehicleModel } from '../../../utils/schemas/vehicle'
import { FavoriteModel } from '../../../utils/schemas/favorite'
import { sendVehicleToZApi } from '../../../utils/zapi'

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const doc = await VehicleModel.findById(id).lean()
  if (!doc) throw createError({ statusCode: 404, message: 'Veículo não encontrado' })

  const vehicle = withEffectiveAuctionLifecycle(
    { ...doc, _id: String((doc as Record<string, unknown>)['_id']) } as VehicleRecord,
  )
  if (!canSendVehicleToWhatsapp(vehicle)) {
    throw createError({ statusCode: 409, message: 'Leilão finalizado não pode ser enviado pelo WhatsApp' })
  }

  const marketHistory = await loadMarketHistory()
  const vehicleForSend = {
    ...vehicle,
    marketAnalysis: buildVehicleMarketAnalysis(vehicle, marketHistory),
  }
  const zapiResult = await sendVehicleToZApi(vehicleForSend)
  if (!zapiResult.ok) {
    throw createError({
      statusCode: 502,
      message: `Falha no envio Z-API: ${zapiResult.reason ?? 'erro desconhecido'}`,
    })
  }

  const sentAt = new Date()
  const sentTo = process.env['ZAPI_PHONE'] ?? process.env['Z_PHONE'] ?? ''
  const nextStatus: VehicleRecord['status'] = vehicle.status === 'favorite' ? 'favorite' : 'sent'
  const isSold = vehicle.saleStatus === 'sold'
  const priceAtSend = vehicle.saleStatus === 'sold'
    ? vehicle.soldPrice ?? vehicle.price
    : vehicle.price

  const fipePercent =
    priceAtSend != null && vehicle.fipe != null && vehicle.fipe > 0
      ? Math.round((priceAtSend / vehicle.fipe) * 100)
      : null

  const [updatedDoc, favoriteDoc] = await Promise.all([
    VehicleModel.findByIdAndUpdate(
      id,
      { status: nextStatus, sentAt, sentTo },
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
          priceAtSend,
          fipeAtSend: vehicle.fipe,
          fipePercent,
          sentAt,
          sentTo,
          soldPrice: isSold ? priceAtSend : null,
          soldAt: isSold ? sentAt : null,
          soldFipe: isSold ? vehicle.fipe : null,
          soldFipePercent: isSold ? fipePercent : null,
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
