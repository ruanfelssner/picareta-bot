type Lot = { code: string; auctionId: string; lot: string; description: string }
type IdentityInput = { auctionId: string | null; lot: string | null; code: string | null; vehicleUrl: string | null; description?: string | null }
const ORIGIN = 'https://www.pestanaleiloes.com.br'
const cache = new Map<string, { expires: number; promise: Promise<Map<string, Lot | null>> }>()

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function number(value: unknown): string | null {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? String(Number(raw)) : null
}
function title(value: string): string { return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '') }

export function pestanaLiveLotIndex(value: unknown, auctionId: string): Map<string, Lot | null> {
  if (!Array.isArray(value) || value.length > 20_000) throw new Error('Catálogo Pestana inválido.')
  const result = new Map<string, Lot | null>()
  for (const raw of value) {
    const row = record(raw), code = number(row.id), lot = number(row.numero)
    if (!code || !lot || number(row.leilao) !== auctionId || row.visivel === false) continue
    if (!Array.isArray(row.bens) || !row.bens.some(asset => number(record(record(asset).tipoBem).id) === '421')) continue
    const description = typeof row.descricao === 'string' ? row.descricao.trim() : ''
    const previous = result.get(lot)
    if (result.has(lot) && previous?.code !== code) { result.set(lot, null); continue }
    result.set(lot, { code, auctionId, lot, description })
  }
  return result
}

/** O DOM informa número do lote, não o ID global. Resolve apenas a identidade no endpoint público de leitura. */
export async function resolvePestanaLiveIdentity(input: IdentityInput, fetcher: typeof fetch = fetch): Promise<{ code: string; vehicleUrl: string }> {
  const auctionId = number(input.auctionId), lot = number(input.lot)
  if (!auctionId || !lot) throw new Error('Leilão/lote Pestana não identificado.')
  const code = number(input.code)
  if (code && input.vehicleUrl) {
    const url = new URL(input.vehicleUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.hostname !== 'www.pestanaleiloes.com.br'
      || !new RegExp(`^/agenda-de-leiloes/${auctionId}/${code}(?:/[^/]+)?/?$`).test(url.pathname)) throw new Error('Identidade Pestana conflitante.')
    return { code, vehicleUrl: `${ORIGIN}/agenda-de-leiloes/${auctionId}/${code}` }
  }
  const now = Date.now()
  // Transporte injetado nos testes não compartilha cache de rede.
  let entry = fetcher === fetch ? cache.get(auctionId) : undefined
  if (!entry || entry.expires <= now) {
    const promise = (async () => {
      const response = await fetcher(`${ORIGIN}/api/v2/lote/por-leilao?idLeilao=${auctionId}`, {
        headers: { Accept: 'application/json', Referer: `${ORIGIN}/agenda-de-leiloes/${auctionId}/aovivo` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Pestana HTTP ${response.status}; identidade indisponível.`)
      return pestanaLiveLotIndex(await response.json(), auctionId)
    })()
    entry = { expires: now + 2 * 60_000, promise }
    if (fetcher === fetch) {
      for (const [key, value] of cache) if (value.expires <= now) cache.delete(key)
      if (cache.size >= 20) cache.delete(cache.keys().next().value!)
      cache.set(auctionId, entry)
      void promise.catch(() => { if (cache.get(auctionId)?.promise === promise) cache.delete(auctionId) })
    }
  }
  const matched = (await entry.promise).get(lot)
  if (!matched || (input.description && title(input.description) !== title(matched.description))) throw new Error('Lote Pestana ausente, ambíguo ou em transição.')
  return { code: matched.code, vehicleUrl: `${ORIGIN}/agenda-de-leiloes/${auctionId}/${matched.code}` }
}
