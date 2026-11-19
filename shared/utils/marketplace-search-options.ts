/**
 * Opções extras de uma busca do Marketplace enfileirada em `marketplace_web_searches`.
 * Gravadas pelo Nuxt (MCP) e lidas pelo `pnpm worker`; buscas da tela `/marketplace` não têm opções.
 * Mantido sem dependências para ser importado pelos dois lados.
 */
export type MarketplaceItemCondition = 'novo' | 'usado'

export interface MarketplaceSearchOptions {
  /** ID numérico de localização do Facebook ou slug de cidade (ex.: `curitiba`, `saopaulo`). */
  locationId: string | null
  radiusKm: number | null
  minPrice: number | null
  maxPrice: number | null
  condition: MarketplaceItemCondition | null
}

export const MARKETPLACE_RADIUS_LIMITS_KM = { min: 1, max: 500 } as const
export const MARKETPLACE_PRICE_LIMIT = 10_000_000

/** Valor de `itemCondition` usado na URL do Marketplace (mesmo mapeamento do parser de "novo"/"usado" do termo). */
export const MARKETPLACE_ITEM_CONDITION_PARAM: Record<MarketplaceItemCondition, string> = {
  novo: 'new',
  usado: 'used_like_new,used_good,used_fair',
}

function finiteInteger(value: unknown, min: number, max: number): number | null {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (!Number.isFinite(number)) return null
  const rounded = Math.round(number)
  return rounded >= min && rounded <= max ? rounded : null
}

/** "São Paulo" → "saopaulo"; IDs numéricos são preservados. Retorna null para valores vazios/inválidos. */
export function normalizeMarketplaceLocation(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const slug = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
  return slug.length >= 2 && slug.length <= 40 ? slug : null
}

/** Sanitiza o que veio do banco/requisição; nunca lança. */
export function normalizeMarketplaceSearchOptions(value: unknown): MarketplaceSearchOptions | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const minPrice = finiteInteger(raw.minPrice, 0, MARKETPLACE_PRICE_LIMIT)
  let maxPrice = finiteInteger(raw.maxPrice, 0, MARKETPLACE_PRICE_LIMIT)
  if (minPrice != null && maxPrice != null && maxPrice < minPrice) maxPrice = null

  const options: MarketplaceSearchOptions = {
    locationId: normalizeMarketplaceLocation(raw.locationId),
    radiusKm: finiteInteger(raw.radiusKm, MARKETPLACE_RADIUS_LIMITS_KM.min, MARKETPLACE_RADIUS_LIMITS_KM.max),
    minPrice,
    maxPrice,
    condition: raw.condition === 'novo' || raw.condition === 'usado' ? raw.condition : null,
  }

  const hasAny = Object.values(options).some(option => option != null)
  return hasAny ? options : null
}
