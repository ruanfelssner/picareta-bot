import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'

export default defineEventHandler((event) => {
  assertLiveAuctionExtensionAuthorized(event)

  return {
    ok: true,
    authenticated: true,
  }
})
