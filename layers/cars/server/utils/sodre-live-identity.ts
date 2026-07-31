type SodreLiveIdentity = {
  auctionId: string | null
  code: string | null
  vehicleUrl: string | null
}

type SodreLiveIdentityInput = SodreLiveIdentity & {
  imageUrl: string | null
}

const SODRE_LOCATION_STATE_HINTS: Array<{ term: string, state: string }> = [
  { term: 'GUARULHOS', state: 'SP' },
]

export function normalizeSodreLiveIdentity(input: SodreLiveIdentityInput): SodreLiveIdentity {
  const imageIdentity = parseSodreImageIdentity(input.imageUrl)
  const auctionId = imageIdentity?.auctionId ?? digitsOrNull(input.auctionId)
  const code = imageIdentity?.code ?? digitsOrNull(input.code)

  return {
    auctionId,
    code,
    vehicleUrl: auctionId && code
      ? `https://leilao.sodresantoro.com.br/leilao/${auctionId}/lote/${code}/`
      : input.vehicleUrl,
  }
}

export function areVehicleBrandsCompatible(first: string | null, second: string | null): boolean {
  if (!first || !second) return true

  const firstBrand = normalizeBrand(first)
  const secondBrand = normalizeBrand(second)
  return firstBrand === secondBrand
    || firstBrand.includes(secondBrand)
    || secondBrand.includes(firstBrand)
}

export function inferSodreStateFromLocation(value: string | null): string | null {
  if (!value) return null

  const normalized = normalizeText(value)
  return SODRE_LOCATION_STATE_HINTS.find(({ term }) => hasBoundaryTerm(normalized, term))?.state ?? null
}

function parseSodreImageIdentity(imageUrl: string | null): { auctionId: string, code: string } | null {
  if (!imageUrl) return null

  try {
    const url = new URL(imageUrl)
    const match = url.pathname.match(/\/veiculos\/(\d+)\/(\d+)\//i)
    if (!match?.[1] || !match[2]) return null

    return {
      auctionId: match[1],
      code: match[2],
    }
  }
  catch {
    return null
  }
}

function digitsOrNull(value: string | null): string | null {
  const digits = value?.replace(/\D/g, '') ?? ''
  return digits || null
}

function normalizeBrand(value: string): string {
  const brand = normalizeText(value)

  if (brand === 'VW') return 'VOLKSWAGEN'
  if (brand === 'GM') return 'CHEVROLET'
  return brand
}

function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

}

function hasBoundaryTerm(haystack: string, term: string): boolean {
  return new RegExp(`(?:^| )${term}(?= |$)`).test(haystack)
}
