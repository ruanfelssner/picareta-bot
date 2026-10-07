import type { Page } from 'playwright'

export function copartAuctionRoomUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value, 'https://www.copart.com.br')
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.hostname.replace(/^www\./, '') !== 'copart.com.br'
      || !/^\/auctionDashboard\/?$/i.test(url.pathname)
      || !/^\d+$/.test(url.searchParams.get('auctionId') || '')) return null
    url.hash = ''
    return url.href
  } catch { return null }
}

export interface CopartRoomLink {
  roomUrl: string
  saleUrls: string[]
}

/** Identifica o catálogo, que não usa necessariamente o mesmo ID da sala ao vivo. */
export function copartCatalogAuctionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value, 'https://www.copart.com.br')
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || url.hostname.replace(/^www\./, '') !== 'copart.com.br') return null
    return url.pathname.match(/^\/saleListResult\/(?:auctionId\/)?(\d+)\/?$/i)?.[1]
      ?? (/^\/saleListResult\/?$/i.test(url.pathname) && /^\d+$/.test(url.searchParams.get('auctionId') || '') ? url.searchParams.get('auctionId') : null)
  } catch { return null }
}

export function findCopartRoomForCatalog(links: CopartRoomLink[], catalogId: string): { roomUrl: string; catalogUrl: string } | null {
  const matches = new Map<string, string>()
  for (const link of links) {
    const roomUrl = copartAuctionRoomUrl(link.roomUrl)
    if (!roomUrl || new URL(roomUrl).protocol !== 'https:' || new URL(roomUrl).port) continue
    const catalogUrl = link.saleUrls.find(url => copartCatalogAuctionId(url) === catalogId)
    if (catalogUrl) matches.set(roomUrl, catalogUrl)
  }
  return matches.size === 1 ? { roomUrl: [...matches.keys()][0]!, catalogUrl: [...matches.values()][0]! } : null
}

export function findCopartRoomLink(links: CopartRoomLink[], saleUrl: string, auctionId?: string | null): string | null {
  const matches = new Set<string>()
  for (const link of links) {
    const room = copartAuctionRoomUrl(link.roomUrl)
    if (!room) continue
    if (link.saleUrls.includes(saleUrl) || (auctionId && new URL(room).searchParams.get('auctionId') === auctionId)) matches.add(room)
  }
  return matches.size === 1 ? [...matches][0]! : null
}

export async function collectCopartRoomLinks(page: Pick<Page, '$$eval'>): Promise<CopartRoomLink[]> {
  return page.$$eval('a[href*="auctionDashboard"], a[data-url*="auctionDashboard"]', elements => elements.map(element => {
    const roomUrl = new URL(element.getAttribute('href') || element.getAttribute('data-url') || '', element.ownerDocument.baseURI).href
    let parent = element.parentElement
    let saleUrls: string[] = []
    for (let depth = 0; parent && depth < 5 && !['BODY', 'HTML'].includes(parent.tagName); depth++, parent = parent.parentElement) {
      const sales = [...parent.querySelectorAll('a[href*="saleListResult" i], a[data-url*="saleListResult" i]')]
      const rooms = parent.querySelectorAll('a[href*="auctionDashboard"], a[data-url*="auctionDashboard"]')
      const urls = [...new Set(sales.map(sale => new URL(sale.getAttribute('href') || sale.getAttribute('data-url') || '', element.ownerDocument.baseURI).href))]
      const roomUrls = new Set([...rooms].map(room => new URL(room.getAttribute('href') || room.getAttribute('data-url') || '', element.ownerDocument.baseURI).href))
      if (urls.length === 1 && roomUrls.size === 1) {
        saleUrls = urls
        break
      }
    }
    return { roomUrl, saleUrls }
  })).catch(() => [])
}
