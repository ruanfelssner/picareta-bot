import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'

export default defineEventHandler(async (event) => {
  const actor = await assertLiveAuctionExtensionAuthorized(event)

  return {
    ok: true,
    authenticated: true,
    user: actor.kind === 'user' ? {
      id: actor.userId,
      phone: actor.phone,
      name: actor.name,
      role: actor.role,
      deviceId: actor.deviceId,
    } : null,
  }
})
