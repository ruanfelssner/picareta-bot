import { assertAuctionAdmin, listAuctions } from '../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  return { auctions: await listAuctions() }
})
