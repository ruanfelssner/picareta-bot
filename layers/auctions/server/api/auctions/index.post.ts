import { assertAuctionAdmin, createAuction } from '../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  const body = await readBody<Record<string, unknown>>(event)
  if (typeof body?.vehicleId !== 'string') throw createError({ statusCode: 400, message: 'vehicleId é obrigatório.' })
  return await createAuction({ vehicleId: body.vehicleId, startingBid: body.startingBid, increment: body.increment, autoApproveBids: body.autoApproveBids })
})
