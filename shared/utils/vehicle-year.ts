/** Ano desconhecido/zero nunca pode invalidar a ingestão nem consultar FIPE. */
export function vehicleYear(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d{4}$/.test(value.trim()))) return null
  const year = Number(value)
  return Number.isInteger(year) && year >= 1900 && year <= 2100 ? year : null
}
