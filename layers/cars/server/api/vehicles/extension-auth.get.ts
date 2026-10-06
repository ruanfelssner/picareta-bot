import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'

export default defineEventHandler(async (event) => {
  // Só valida a sessão; as gravações recusam versões antigas com a mensagem de atualização.
  const actor = await assertLiveAuctionExtensionAuthorized(event, { allowOutdatedExtension: true })

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
