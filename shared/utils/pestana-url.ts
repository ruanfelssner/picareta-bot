const ORIGIN = 'https://www.pestanaleiloes.com.br'

function identity(value: string): { auction: string; lot: string } | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || !['www.pestanaleiloes.com.br', 'pestanaleiloes.com.br'].includes(url.hostname)) return null
    const match = url.pathname.match(/^\/(?:lote|agenda-de-leiloes)\/([1-9]\d*)\/([1-9]\d*)(?:\/[^/]+)?\/?$/)
    return match ? { auction: match[1]!, lot: match[2]! } : null
  } catch { return null }
}

/** A rota oficial aceita slug opcional; os IDs bastam e não dependem do título. */
export function pestanaLotUrl(value: string): string {
  const ids = identity(value)
  return ids ? `${ORIGIN}/agenda-de-leiloes/${ids.auction}/${ids.lot}` : value
}

/** Mantém as chaves anteriores para não duplicar o bem ao corrigir sua navegação. */
export function pestanaIdentityUrl(value: string): string {
  const ids = identity(value)
  return ids ? `${ORIGIN}/lote/${ids.auction}/${ids.lot}` : value
}

export function pestanaUrlAliases(value: string): string[] {
  return [...new Set([value, pestanaLotUrl(value), pestanaIdentityUrl(value)])]
}
