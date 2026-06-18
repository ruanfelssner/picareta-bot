const UNAVAILABLE_IMAGE_PATTERNS = [
  /\/fotos\/indisp\//i,
  /\/_indisp\./i,
  /\/foto_em_breve\./i,
  /imagem-n-disponivel/i,
]

export function isUsableVehicleImageUrl(url: string | null | undefined): url is string {
  const value = String(url ?? '').trim()
  if (!value) return false
  return !UNAVAILABLE_IMAGE_PATTERNS.some(pattern => pattern.test(value))
}

export function firstUsableVehicleImageUrl(urls: string[] | null | undefined): string | null {
  return urls?.find(isUsableVehicleImageUrl) ?? null
}
