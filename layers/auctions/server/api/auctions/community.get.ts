import { assertAuctionAdmin, getCommunity } from '../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  return { community: await getCommunity() }
})
