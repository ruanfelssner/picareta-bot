import { load } from 'cheerio'

export function auctionText(value: unknown): string {
  return typeof value === 'string' ? load(value).text().replace(/\s+/g, ' ').trim() : ''
}

export function auctionKey(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
}

export function auctionMoney(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  const text = auctionText(value).replace(/^R\$\s*/, '')
  if (!/^\d+(?:\.\d{3})*(?:,\d{2})?$/.test(text)) return null
  const amount = Number(text.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) / 100 : null
}

export function brazilAuctionDate(value: string): { date: Date | null; timeKnown: boolean } {
  const match = auctionText(value).match(/\b(\d{2})\/(\d{2})\/(\d{4})(?:\s*(?:às\s*)?(\d{1,2})(?:h|:)(\d{2})?h?)?/i)
  if (!match) return { date: null, timeKnown: false }
  const [, day, month, year, hour, minute] = match
  const hh = Number(hour ?? 0), mm = Number(minute ?? 0)
  const calendar = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  if (calendar.getUTCFullYear() !== Number(year) || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day) || hh > 23 || mm > 59) return { date: null, timeKnown: false }
  return { date: new Date(`${year}-${month}-${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00-03:00`), timeKnown: hour != null }
}

/** Somente páginas públicas e endpoints de consulta usados pelo próprio site. */
export async function publicAuctionRequest(url: string, options: { signal?: AbortSignal; form?: Record<string, string>; referer?: string } = {}): Promise<string> {
  const controller = new AbortController()
  const abort = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = setTimeout(() => controller.abort(new Error('Tempo de consulta excedido.')), 25_000)
  try {
    const response = await fetch(url, {
      method: options.form ? 'POST' : 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        ...(options.referer ? { Referer: options.referer, Origin: new URL(options.referer).origin } : {}),
        ...(options.form ? { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } : {}),
      },
      body: options.form ? new URLSearchParams(options.form).toString() : undefined,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`HTTP ${response.status} em ${url}`)
    const text = await response.text()
    if (/captcha|radware|access denied|acesso negado/i.test(text) && !/<(?:body|section|div)\b|"item"\s*:/i.test(text)) throw new Error(`A fonte bloqueou a consulta pública: ${url}`)
    return text
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export async function auctionMap<T, R>(items: T[], process: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await process(items[index]!)
    }
  }))
  return results
}
