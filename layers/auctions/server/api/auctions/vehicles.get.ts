import { assertAuctionAdmin, listAuctionVehicles } from '../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  return { vehicles: await listAuctionVehicles() }
})
