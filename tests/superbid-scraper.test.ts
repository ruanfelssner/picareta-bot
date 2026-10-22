import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSuperbidOffersUrl, parseSuperbidOffer, scrapeSuperbid, superbidOfferSlug } from '../src/scrapers/superbid.js'
import { superbidSource, superbidOfferSlug as layerSlug } from '../layers/scrapers/server/utils/sources/superbid.js'

// Oferta real reduzida da API offer-query.superbid.net (categoria carros, out/2026).
const offer = {
  id: 5048436,
  lotNumber: 49,
  price: 14000,
  priceFormatted: 'R$ 14.000,00',
  offerDetail: { currentMinBid: 14000, currentMinBidFormatted: 'R$ 14.000,00' },
  auction: { endDate: '2026-10-23 15:40:00', desc: 'Neoenergia Pernambuco' },
  product: {
    shortDesc: 'FORD RANGER XL 22C 2.2, 2021/2022, Placa FINAL 9 (PE),  (Ref.: DCG)',
    thumbnailUrl: 'https://ms.sbwebservices.net/photos/c6381ea4-f8eb-4670-b2fe-b68b92d2fcd4.jpg',
    brand: {},
    model: {},
    location: { city: 'Jaboatão dos Guararapes - PE', state: 'Pernambuco' },
  },
  seller: { name: 'COMPANHIA ENERGETICA DE PERNAMBUCO' },
}
const quiet = () => {}
const scrapers = [
  ['src', (log = quiet) => scrapeSuperbid({} as never, { log })],
  ['layers', (log = quiet) => superbidSource.run({} as never, { log })],
] as const

async function withFetch<T>(handler: (url: string) => Response, run: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input)
    urls.push(url)
    return handler(url)
  }) as typeof fetch
  try { return { result: await run(), urls } }
  finally { globalThis.fetch = original }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

test('Superbid consulta a API de ofertas da categoria carros, não a página HTML protegida por Cloudflare', () => {
  const url = new URL(buildSuperbidOffersUrl(3, 30))
  assert.equal(url.origin + url.pathname, 'https://offer-query.superbid.net/seo/offers/')
  assert.equal(url.searchParams.get('pageNumber'), '3')
  assert.equal(url.searchParams.get('pageSize'), '30')
  assert.equal(url.searchParams.get('searchType'), 'opened')
  assert.equal(url.searchParams.get('urlSeo'), 'https://www.superbid.net/categorias/carros-motos/carros')
})

test('Superbid reproduz o slug real do link da oferta', () => {
  for (const slug of [superbidOfferSlug, layerSlug]) {
    assert.equal(slug(offer.product.shortDesc), 'ford-ranger-xl-22c-22-2021-2022-placa-final-9-pe-ref-dcg')
    assert.equal(slug('MITSUBISHI L200 TRITON SPO GL 2.4, 2023/2023, Placa FINAL 7 (MG),  (Ref.: ABB_92)'), 'mitsubishi-l200-triton-spo-gl-24-2023-2023-placa-final-7-mg-ref-abb_92')
    assert.equal(slug('TOYOTA  HILUX CDLODM4HD 2.8, 2018/2019'), 'toyota-hilux-cdlodm4hd-28-2018-2019')
  }
})

test('Superbid extrai dados públicos da oferta', () => {
  const car = parseSuperbidOffer(offer)!
  assert.equal(car.url, 'https://exchange.superbid.net/oferta/ford-ranger-xl-22c-22-2021-2022-placa-final-9-pe-ref-dcg-5048436')
  assert.equal(car.brand, 'FORD')
  assert.equal(car.year, 2021)
  assert.equal(car.price, 14000)
  assert.equal(car.lot, '49')
  assert.equal(car.yard, 'Jaboatão dos Guararapes - PE - Pernambuco')
  assert.deepEqual(car.imageUrls, [offer.product.thumbnailUrl])
})

for (const [name, scrape] of scrapers) {
  test(`Superbid (${name}) pagina pela API e deduplica ofertas`, async () => {
    const second = { ...offer, id: 5048437 }
    const { result, urls } = await withFetch(
      url => json({ total: 40, start: 0, limit: 30, offers: new URL(url).searchParams.get('pageNumber') === '1' ? [offer] : [second, offer] }),
      () => scrape(),
    )
    assert.equal(urls.length, 2)
    assert.ok(urls.every(url => url.startsWith('https://offer-query.superbid.net/seo/offers/?')))
    assert.deepEqual(result.map(car => car.url.split('-').at(-1)), ['5048436', '5048437'])
  })

  test(`Superbid (${name}) falha com erro claro em bloqueio Cloudflare em vez de retornar 0`, async () => {
    const blocked = () => new Response('<!DOCTYPE html><title>Just a moment...</title>', { status: 403 })
    await assert.rejects(withFetch(blocked, () => scrape()), /\[superbid\] API de ofertas respondeu HTTP 403 \(bloqueio\/desafio Cloudflare\)/)
  })

  test(`Superbid (${name}) falha com erro claro quando a estrutura da resposta muda`, async () => {
    await assert.rejects(withFetch(() => json({ items: [] }), () => scrape()), /\[superbid\] Resposta inesperada da API de ofertas/)
    await assert.rejects(withFetch(() => json({ total: 1, offers: [{ foo: 1 }] }), () => scrape()), /\[superbid\] 1 oferta\(s\) recebida\(s\)/)
    await assert.rejects(withFetch(() => { throw new TypeError('fetch failed') }, () => scrape()), /\[superbid\] Falha de rede/)
  })

  test(`Superbid (${name}) mantém lista vazia legítima`, async () => {
    const { result } = await withFetch(() => json({ total: 0, start: 0, limit: 30, offers: [] }), () => scrape())
    assert.deepEqual(result, [])
  })
}
