// Datas civis dos leiloeiros brasileiros independem do timezone do worker.
export function parseBrazilAuctionDate(value: string): Date | null {
  const match = value?.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,9})?)?)?(Z|[+-]\d{2}:?\d{2})?$/)
  if (!match) return null
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone = '-03:00'] = match
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`)
  if (Number.isNaN(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== `${year}-${month}-${day}`) return null
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction.slice(0, 4)}${zone}`)
  return Number.isNaN(date.getTime()) ? null : date
}

export function hasAuctionTime(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value) && value > 0) || (typeof value === 'string' && /(?:[ T]\d{1,2}:\d{2}|^\d{10,13}$)/.test(value))
}
