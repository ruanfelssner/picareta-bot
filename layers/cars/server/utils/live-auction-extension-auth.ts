import type { H3Event } from 'h3'

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function assertLiveAuctionExtensionAuthorized(event: H3Event): void {
  const config = useRuntimeConfig()
  const expectedToken = optionalString(config.liveAuctionExtensionToken)
    ?? optionalString(process.env.LIVE_AUCTION_EXTENSION_TOKEN)
    ?? optionalString(config.copartExtensionToken)
    ?? optionalString(process.env.COPART_EXTENSION_TOKEN)

  if (!expectedToken) return

  const providedToken = getHeader(event, 'x-live-auction-extension-token')?.trim()
    ?? getHeader(event, 'x-copart-extension-token')?.trim()

  if (providedToken !== expectedToken) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      message: 'Token da extensao de leilao invalido.',
    })
  }
}
