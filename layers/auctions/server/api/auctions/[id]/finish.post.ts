import { assertAuctionAdmin, finishAuction } from '../../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido.' })
  return await finishAuction(id, event)
})
