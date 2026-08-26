import { assertLiveAuctionExtensionAuthorized } from '../../../../utils/live-auction-extension-auth'
import { IgnoredLiveAuctionLotModel } from '../../../../utils/schemas/ignored-live-auction-lot'

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const body = await readBody<unknown>(event).catch((): unknown => null)
  const resolution = body && typeof body === 'object' && !Array.isArray(body)
    ? String((body as Record<string, unknown>)['resolution'] ?? 'Reprocessado pela extensão').slice(0, 240)
    : 'Reprocessado pela extensão'
  const document = await IgnoredLiveAuctionLotModel.findByIdAndUpdate(
    id,
    { $set: { status: 'approved', resolvedAt: new Date(), approvedAt: new Date(), resolution } },
    { new: true, lean: true },
  )
  if (!document) throw createError({ statusCode: 404, message: 'Lote ignorado não encontrado' })

  return {
    ok: true,
    item: {
      ...document,
      _id: String((document as Record<string, unknown>)['_id']),
    },
  }
})
