import type { H3Event } from 'h3'

export const DEFAULT_LIVE_AUCTION_EXTENSION_TOKEN = '7d7c05e46b7d60e29a77dbe62def6dfa389b53e73db15be41dcd83d61bf73b11'

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function assertLiveAuctionExtensionAuthorized(event: H3Event): void {
  const config = useRuntimeConfig()
  const configuredToken = optionalString(config.liveAuctionExtensionToken)
    ?? optionalString(process.env.LIVE_AUCTION_EXTENSION_TOKEN)
    ?? optionalString(config.copartExtensionToken)
    ?? optionalString(process.env.COPART_EXTENSION_TOKEN)

  const providedToken = getHeader(event, 'x-live-auction-extension-token')?.trim()
    ?? getHeader(event, 'x-copart-extension-token')?.trim()
  const acceptedTokens = new Set([
    DEFAULT_LIVE_AUCTION_EXTENSION_TOKEN,
    configuredToken,
  ].filter((token): token is string => token != null))

  if (!providedToken || !acceptedTokens.has(providedToken)) {
    throw createError({
      statusCode: 401,
      statusMessage: 'Unauthorized',
      message: 'Token da extensao de leilao invalido.',
    })
  }
}
