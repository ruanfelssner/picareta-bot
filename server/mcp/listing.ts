/**
 * Formato único devolvido por todas as ferramentas do MCP, independente da plataforma.
 * Funções puras (sem Nitro) para serem testadas em `tests/mcp-listing.test.ts`.
 */

export type ListingCondition = 'novo' | 'usado' | 'recondicionado' | 'sinistrado' | null

export interface Listing {
  title: string
  /** Valor numérico em reais quando reconhecido. */
  price: number | null
  /** Texto original do preço (ex.: "R$ 1.200"). */
  priceText: string | null
  currency: 'BRL'
  location: string | null
  condition: ListingCondition
  /** Detalhe da condição quando a fonte informa algo além de novo/usado (ex.: "Média monta"). */
  conditionDetail: string | null
  /** Código OEM / part number quando a fonte informa ou o anúncio cita explicitamente. */
  oemCode: string | null
  imageUrl: string | null
  url: string
  /** ID da plataforma de origem (ex.: `facebook-marketplace`, `mercadolivre`, `web`, `copart`). */
  platform: string
  platformName: string
}

export function listing(fields: Omit<Listing, 'currency' | 'conditionDetail'> & { conditionDetail?: string | null }): Listing {
  return { currency: 'BRL', conditionDetail: null, ...fields }
}

const BRL_PRICE_PATTERN = /R\$\s*([\d.]+(?:,\d{1,2})?)/i

/** "R$ 1.200,50" → 1200.5; "R$ 300R$ 450" (preço antigo/novo) → 300; sem "R$" → null. */
export function parseBrlPrice(text: string | null | undefined): number | null {
  if (!text) return null
  const match = BRL_PRICE_PATTERN.exec(text)
  if (!match?.[1]) return null
  const value = Number(match[1].replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(value) ? value : null
}

/**
 * Só aceita código precedido de rótulo explícito ("cód.", "código", "OEM", "ref.", "part number", "PN")
 * para evitar confundir ano, km ou preço com código de peça.
 */
// O lookahead após o rótulo impede casar dentro de palavras ("pneu", "refil", "codificado").
const OEM_PATTERN = /\b(?:c[oó]d(?:igo)?\.?(?:\s+(?:original|oem|da\s+pe[cç]a))?|oem|ref(?:er[eê]ncia)?\.?|part\s*number|p\/?n)(?![a-zà-ÿ])\s*[:#º°-]?\s*([A-Z0-9][A-Z0-9.\-/ ]{3,24}[A-Z0-9])/gi

export function extractOemCode(...texts: Array<string | null | undefined>): string | null {
  for (const text of texts) {
    if (!text) continue
    for (const match of text.matchAll(OEM_PATTERN)) {
      const raw = match[1]?.trim()
      if (!raw) continue
      // Corta no primeiro espaço seguido de palavra (ex.: "5U0807217 original").
      const code = raw.split(/\s+(?=[a-zà-ÿ]{3,})/i)[0]!.trim().toUpperCase()
      const compact = code.replace(/[\s.\-/]/g, '')
      if (compact.length >= 5 && /\d/.test(compact)) return code
    }
  }
  return null
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': '\'', nbsp: ' ' }

export function stripHtml(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, entity: string) => HTML_ENTITIES[entity] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const url = value.trim().replace(/^http:\/\//i, 'https://')
  return /^https:\/\//i.test(url) ? url : null
}

export function dedupeByUrl<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = item.url.trim().replace(/\/+$/, '').toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
