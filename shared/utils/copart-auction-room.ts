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
      if (sales.length === 1 && rooms.length === 1) {
        saleUrls = sales.map(sale => new URL(sale.getAttribute('href') || sale.getAttribute('data-url') || '', element.ownerDocument.baseURI).href)
        break
      }
    }
    return { roomUrl, saleUrls }
  })).catch(() => [])
}
