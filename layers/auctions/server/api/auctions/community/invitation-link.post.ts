import { assertAuctionAdmin, generateCommunityInvitationLink } from '../../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  return await generateCommunityInvitationLink()
})
