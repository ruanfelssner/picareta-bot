const VIP_LISTING_MARKERS = [
  'detalharveiculo',
  'card-anuncio',
  'resultadosencontrados',
  'filtro.classificacao',
  'formpost',
] as const

const CLOUDFLARE_CHALLENGE_TEXT_MARKERS = [
  'just a moment',
  'performing security verification',
  'enable javascript and cookies to continue',
] as const

const CLOUDFLARE_CHALLENGE_STRUCTURE_MARKERS = [
  'cf-chl-',
  'challenge-form',
  'challenge-stage',
] as const

export function looksLikeVipListingPageHtml(rawHtml: string): boolean {
  const html = rawHtml.toLowerCase()
  return VIP_LISTING_MARKERS.some(marker => html.includes(marker))
}

export function looksLikeVipCloudflareChallenge(rawHtml: string, visibleText = ''): boolean {
  if (looksLikeVipListingPageHtml(rawHtml)) return false

  const marker = `${rawHtml}\n${visibleText}`.toLowerCase()
  if (CLOUDFLARE_CHALLENGE_TEXT_MARKERS.some(item => marker.includes(item))) return true

  return marker.includes('cdn-cgi/challenge-platform')
    && CLOUDFLARE_CHALLENGE_STRUCTURE_MARKERS.some(item => marker.includes(item))
}
