function auctionRoomUrl(_source: string, value: string): string | null {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && url.hostname === 'www.vipleiloes.com.br' && /^\/eventoonline\/[a-z0-9_-]+$/i.test(url.pathname) ? url.href : null
}

const ORIGIN = 'https://www.vipleiloes.com.br'
const MAX_PAGES = 10
const MAX_LOT_PAGES = 25
const MAX_EVENTS = 30

export interface VipAgendaEvent {
  auctionId: string
  label: string
  url: string
  startsAt: string
  timeKnown: boolean
  locationStates: string[]
  lotCount: number | null
  officialClosed: boolean
  memberLotUrls?: string[]
  lotCountPr?: number
}

function decode(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, code: string) => {
    if (!code.startsWith('#')) return entities[code.toLowerCase()] ?? original
    const number = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : original
  })
}

const text = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
const normalized = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w.-]+)\s*=\s*(["'])(.*?)\2/gs)].map(match => [match[1]!, decode(match[3]!)]))
}

function cards(html: string, kind: string): string[] {
  // Delimita registros pelos cards oficiais, sem capturar menus/filtros como eventos.
  const starts = [...html.matchAll(new RegExp(`<div\\b[^>]*class=["'](?:[^"']*\\s)?${kind}(?:\\s[^"']*)?["'][^>]*>`, 'gi'))]
  return starts.map((match, index) => html.slice(match.index, starts[index + 1]?.index ?? html.length))
}

function pagination(html: string) {
  const links: Record<string, string>[] = []
  for (const item of html.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/gi)) {
    const classes = attributes(item[1]!).class?.split(/\s+/) ?? []
    if (!classes.includes('page-item') || classes.includes('disabled')) continue
    const anchor = item[2]!.match(/<a\b[^>]*>/i)?.[0]
    if (anchor) links.push(attributes(anchor))
  }
  return links
}

function dateFromText(value: string): { startsAt: string; timeKnown: boolean } | null {
  const match = value.match(/\b(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2}))?\b/)
  if (!match) return null
  const [, day, month, year, hour, minute] = match
  const date = new Date(`${year}-${month}-${day}T${hour ?? '00'}:${minute ?? '00'}:00-03:00`)
  if (Number.isNaN(date.getTime())) return null
  const brazil = new Date(date.getTime() - 3 * 60 * 60_000)
  if (brazil.getUTCDate() !== Number(day) || brazil.getUTCMonth() + 1 !== Number(month)) return null
  return { startsAt: date.toISOString(), timeKnown: hour !== undefined }
}

export function parseVipAgendaPage(html: string): { events: VipAgendaEvent[]; pages: number } {
  if (/<html\b/i.test(html) || !/<input\b[^>]*\bid=["']CurrentPage["']/i.test(html)) throw new Error('Resposta VIP não contém a lista da agenda')
  const events = new Map<string, VipAgendaEvent>()
  for (const card of cards(html, 'card-evento')) {
    const links = [...card.matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0]).href)
    const details = links.find(link => link && /^\/evento\/detalhes\/[a-z0-9_-]+\/?$/i.test(link))
    const auctionId = details?.match(/\/detalhes\/([a-z0-9_-]+)/i)?.[1]
    const label = text(card.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '')
    const fields = new Map<string, string>()
    for (const row of card.matchAll(/<div\b[^>]*class=["'][^"']*\banc-row\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/gi)) {
      const spans = [...row[1]!.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
      if (spans.length === 2) fields.set(normalized(text(spans[0]![1]!)), text(spans[1]![1]!))
    }
    const date = dateFromText(fields.get('inicio') ?? '')
    const states: string[] = fields.get('estados')?.toUpperCase().match(/\b[A-Z]{2}\b/g) ?? []
    if (!auctionId || !label || !date || !fields.has('estados')) throw new Error('Evento VIP sem identidade, data ou estados confirmados')
    if (!states.includes('PR')) continue
    const url = auctionRoomUrl('vipleiloes', `${ORIGIN}/eventoonline/${auctionId}`)!
    const rawCount = fields.get('lotes')?.replace(/\./g, '')
    events.set(`${auctionId}|${date.startsAt.slice(0, 10)}`, {
      auctionId, label, url, ...date, locationStates: [...new Set(states)],
      lotCount: rawCount && /^\d+$/.test(rawCount) ? Number(rawCount) : null,
      officialClosed: /\bevento-(?:Encerrado|Finalizado)\b/i.test(card.slice(0, card.indexOf('>') + 1)),
    })
  }
  const pageNumbers = pagination(html).map(link => {
    const url = new URL(link['data-ajax-url'] ?? '/agenda', ORIGIN)
    return url.pathname === '/agenda' ? Number(url.searchParams.get('pageNumber')) || 1 : 1
  })
  return { events: [...events.values()], pages: Math.max(1, ...pageNumbers) }
}

export function parseVipLotPage(html: string): { urls: string[]; nextPage: number | null } {
  const input = [...html.matchAll(/<input\b[^>]*>/gi)].map(match => attributes(match[0])).find(item => item.id === 'totalAnuncios')
  if (!input || !/^\d+$/.test(input.value ?? '') || /<html\b/i.test(html)) throw new Error('Resposta VIP não contém os lotes de PR')
  const urls = new Set<string>()
  for (const card of cards(html, 'card-anuncio')) {
    if (!/\bLocal:\s*PR\b/i.test(text(card))) throw new Error('Lote VIP fora do filtro PR')
    const href = [...card.matchAll(/<a\b[^>]*>/gi)].map(match => attributes(match[0]).href).find(link => link && /^\/evento\/anuncio\/[a-z0-9_-]+\/?$/i.test(link))
    if (!href) throw new Error('Lote VIP sem link oficial')
    urls.add(new URL(href, ORIGIN).href.replace(/\/$/, ''))
  }
  if (urls.size !== Number(input.value)) throw new Error('Página VIP de lotes incompleta')
  const next = pagination(html).find(link => link['aria-label'] === 'Next')
  const nextPage = next?.['data-ajax-url'] ? Number(new URL(next['data-ajax-url'], ORIGIN).searchParams.get('pageNumber')) : null
  return { urls: [...urls], nextPage: nextPage && nextPage > 0 ? nextPage : null }
}

/** Cookies públicos de canal/antiforgery ficam apenas em memória nesta consulta. */
function publicClient(signal: AbortSignal, fetcher: typeof fetch) {
  const cookies = new Map<string, string>()
  return async (path: string, body?: URLSearchParams) => {
    let url = new URL(path, ORIGIN)
    for (let redirects = 0; redirects < 5; redirects++) {
      if (url.origin !== ORIGIN) throw new Error('Redirecionamento VIP fora do domínio oficial')
      const response = await fetcher(url.href, {
        method: body ? 'POST' : 'GET', body, signal, redirect: 'manual',
        headers: { 'User-Agent': 'Mozilla/5.0', 'X-Requested-With': 'XMLHttpRequest', Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; ') },
      })
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(';')
        const equals = pair!.indexOf('=')
        if (equals > 0) cookies.set(pair!.slice(0, equals), pair!.slice(equals + 1))
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location) throw new Error('Redirecionamento VIP sem endereço')
        await response.body?.cancel()
        url = new URL(location, url)
        if (response.status === 303 || response.status === 302) body = undefined
        continue
      }
      if (!response.ok) throw new Error(`Agenda VIP respondeu HTTP ${response.status}`)
      const html = await response.text()
      if (html.length > 5_000_000) throw new Error('Resposta VIP excedeu o limite de tamanho')
      return html
    }
    throw new Error('Redirecionamentos VIP excederam o limite')
  }
}

async function collectPrLots(event: VipAgendaEvent, signal: AbortSignal, fetcher: typeof fetch) {
  const request = publicClient(signal, fetcher)
  const path = `/evento/detalhes/${event.auctionId}`
  const html = await request(path)
  const form = html.match(/<form\b[^>]*id=["']formPost["'][^>]*>([\s\S]*?)<\/form>/i)?.[1]
  if (!form) throw new Error('Formulário VIP de lotes não encontrado')
  const body = new URLSearchParams()
  for (const tag of form.matchAll(/<input\b[^>]*>/gi)) {
    const attr = attributes(tag[0])
    if (attr.name && attr.type === 'hidden') body.append(attr.name, attr.value ?? '')
  }
  if (!body.get('__RequestVerificationToken') || !body.get('Filtro.EventoId')) throw new Error('Identidade do catálogo VIP ausente')
  body.set('Filtro.LocalEstadoId', 'PR')
  const urls = new Set<string>()
  for (let page = 1; page <= MAX_LOT_PAGES; page++) {
    // O handler usa pageNumber; alterar o CurrentPage oculto reinicia a busca.
    body.set('pageNumber', String(page))
    const parsed = parseVipLotPage(await request(`${path}?pageNumber=${page}&handler=pesquisar`, body))
    const previousSize = urls.size
    parsed.urls.forEach(url => urls.add(url))
    if (!parsed.nextPage) return { memberLotUrls: [...urls], lotCountPr: urls.size }
    if (urls.size === previousSize || parsed.nextPage !== page + 1) break
  }
  throw new Error('Consulta VIP de lotes PR incompleta')
}

export async function collectVipAuctionAgenda(fetcher: typeof fetch = fetch) {
  const signal = AbortSignal.timeout(20_000)
  const request = publicClient(signal, fetcher)
  await request('/agenda')
  const events = new Map<string, VipAgendaEvent>()
  let pages = 1
  for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
    const parsed = parseVipAgendaPage(await request(`/agenda?pageNumber=${page}&handler=pesquisar`, new URLSearchParams()))
    pages = Math.max(pages, parsed.pages)
    parsed.events.forEach(event => events.set(`${event.auctionId}|${event.startsAt.slice(0, 10)}`, event))
  }
  const selected = [...events.values()].slice(0, MAX_EVENTS)
  // Pequenos grupos evitam abrir dezenas de catálogos simultaneamente.
  for (let offset = 0; offset < selected.length; offset += 3) {
    await Promise.allSettled(selected.slice(offset, offset + 3).map(async event => {
      Object.assign(event, await collectPrLots(event, signal, fetcher))
    }))
  }
  return { events: selected, truncated: pages > MAX_PAGES || events.size > MAX_EVENTS }
}
