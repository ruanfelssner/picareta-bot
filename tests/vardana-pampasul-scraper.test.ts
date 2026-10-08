import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { parseVardanaAuctionPage, applyVardanaDetail, parseVardanaAuctionLinks, runVardanaScraper } from '../layers/scrapers/server/utils/sources/vardana.js'
import { pampaSulListing, parsePampaSulLot, runPampaSulScraper } from '../layers/scrapers/server/utils/sources/pampasul.js'
import { brazilAuctionDate } from '../layers/scrapers/server/utils/public-auction-http.js'
import { PartialScraperResultError } from '../layers/scrapers/server/utils/source-types.js'

const fixture = (file: string) => readFileSync(`tests/fixtures/${file}`, 'utf8')
const vardanaHtml = fixture('vardana-public-auction.html')
const detail = JSON.parse(fixture('vardana-public-detail.json')) as Record<string, unknown>
const bidHtml = fixture('vardana-public-bids.html')
const auction = { id: '1082', url: 'https://www.vardanaleiloes.com.br/vardana/veiculos.php?lei=1082' }
const pampaHtml = fixture('pampasul-public-lot.html')
const live = JSON.parse(fixture('pampasul-public-live.json')) as Record<string, unknown>
const pampaUrl = 'https://leiloespampasul.com/lote/CHEVROLET-ONIX-PLUS-20-20-Pampa-sul-Leiloes/2871/'
const quiet = () => {}

test('Vardana corrige ano-modelo, Brasília, marca e abreviações Mercedes sem inventar avaliação', () => {
  const cars = parseVardanaAuctionPage(vardanaHtml, auction, quiet)
  assert.equal(cars.length, 5)
  assert.equal(cars[0]!.auctionDate?.toISOString(), '2026-10-15T13:00:00.000Z')
  assert.equal(cars[0]!.auctionTimeKnown, true)
  assert.equal(cars[0]!.auctionId, '1082')
  assert.deepEqual([cars[1]!.brand, cars[1]!.model, cars[1]!.year], ['MERCEDES-BENZ', 'GLA 200 FF', 2018])
  assert.match(cars[2]!.model, /SPRINTER 416 CDI/)
  assert.match(cars[0]!.imageUrls[0]!, /^https:\/\/www.vardanaleiloes.com.br\/vardana\/img_leiloes\/1082\//)
  assert.ok(cars.every(car => car.price == null && car.fipe == null))
})

test('Vardana lê galeria e KM públicos; aguardando avaliação continua sem lance', () => {
  const car = applyVardanaDetail(parseVardanaAuctionPage(vardanaHtml, auction, quiet)[0]!, detail, bidHtml)
  assert.equal(car.imageUrls.length, 12)
  assert.equal(car.km, '130750')
  assert.equal(car.price, null)
  assert.equal(car.saleStatus, undefined)
})

test('Vardana usa apenas lance exibido e separa vendido, condicional e não vendido', () => {
  const base = parseVardanaAuctionPage(vardanaHtml, auction, quiet)[0]!
  for (const [label, status] of [['Vendido', 'sold'], ['Condicional', 'conditional'], ['Não vendido', 'not_sold']] as const) {
    const car = applyVardanaDetail(base, detail, `<span id="teste">R$ 42.500,00</span><span class="informa_status">${label}</span><input value="99000"><p>Taxas R$ 9.000,00</p>`)
    assert.equal(car.price, 42500)
    assert.equal(car.saleStatus, status)
    assert.equal(car.soldPrice, status === 'sold' ? 42500 : null)
  }
})

test('Vardana descobre IDs atuais e falha explicitamente quando a agenda muda', async () => {
  assert.deepEqual(parseVardanaAuctionLinks('<a href="veiculos.php?lei=1082">A</a><a href="veiculos.php?lei=1083">B</a>').map(a => a.id), ['1082', '1083'])
  const originalFetch = globalThis.fetch
  const originalIds = process.env.VARDANA_LEILAO_IDS
  delete process.env.VARDANA_LEILAO_IDS
  globalThis.fetch = async () => new Response('<html>Layout desconhecido</html>')
  try { await assert.rejects(runVardanaScraper({ log: quiet }), /Agenda sem links/) }
  finally { globalThis.fetch = originalFetch; if (originalIds != null) process.env.VARDANA_LEILAO_IDS = originalIds }
})

test('Pampa Sul usa lance atual e FIPE do lote, sem confundir próximo lance mínimo', () => {
  const car = parsePampaSulLot(pampaHtml + '<div class="ls-lote-summary-item">Próximo lance mínimo R$ 99.900,00</div>', pampaUrl, live)
  assert.deepEqual([car.brand, car.model, car.year], ['CHEVROLET', 'ONIX PLUS', 2020])
  assert.equal(car.price, 22300)
  assert.equal(car.fipe, 57144)
  assert.equal(car.imageUrls.length, 10)
  assert.equal(car.city, 'Londrina')
  assert.equal(car.state, 'PR')
  assert.equal(car.auctionId, '71')
  assert.equal(car.lot, '01')
  assert.match(car.auctionUrl!, /^https:\/\/leiloespampasul.com\/lotes\/[^/]+\/71\/$/)
  assert.equal(car.auctionDate?.toISOString(), '2026-10-09T12:30:00.000Z')
  assert.equal(car.auctionTimeKnown, false)
  assert.equal(car.saleStatus, 'unknown')
  assert.equal(car.damage, null)
})

test('Pampa Sul confirma resultados e não usa o inicial como preço de venda', () => {
  for (const [situacao, status] of [[2, 'sold'], [3, 'not_sold'], [10, 'conditional']] as const) {
    const car = parsePampaSulLot(pampaHtml, pampaUrl, { ...live, situacao })
    assert.equal(car.saleStatus, status)
    assert.equal(car.soldPrice, status === 'sold' ? 22300 : null)
    assert.equal(car.auctionStatus, 'finished')
  }
  const car = parsePampaSulLot(pampaHtml, pampaUrl, { ...live, situacao: 2, lance: { ini: 'R$ 7.600,00', atual: 'R$ 0,00' } })
  assert.equal(car.price, null)
  assert.equal(car.soldPrice, null)
  assert.throws(() => parsePampaSulLot(pampaHtml, pampaUrl, { ...live, box_id: '999' }), /Identidade/)
})

test('Pampa Sul percorre todos os links numerados preservando categoria e deduplicação', () => {
  const result = pampaSulListing(fixture('pampasul-public-list.html'))
  assert.equal(result.lots.length, 2)
  assert.deepEqual(result.pages.map(url => new URL(url).searchParams.get('pag')), ['1', '2', '3'])
  assert.ok(result.pages.every(url => new URL(url).searchParams.get('cate[]') === '3'))
  assert.equal(pampaSulListing('<a class="cards__main" href="https://evil.test/lote/car/1/">X</a>').lots.length, 0)
})

test('Pampa Sul conserva resultados parciais ao falhar uma página ou lote', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const address = String(url)
    if (address.includes('atualizar_leiloes')) {
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>).Referer, 'https://leiloespampasul.com/lotes/?cate%5B%5D=3')
      return new Response(JSON.stringify({ item: { '2871': live } }))
    }
    if (address.includes('/lote/')) return new Response(pampaHtml)
    if (address.includes('pag=')) return new Response('erro', { status: 503 })
    return new Response(`<a class="cards__main" href="${pampaUrl}">Lote</a><a href="/lotes/?pag=1">2</a>`)
  }
  try {
    await assert.rejects(runPampaSulScraper({ log: quiet }), (error: unknown) => error instanceof PartialScraperResultError && error.vehicles.length === 1 && /503/.test(error.message))
  } finally { globalThis.fetch = originalFetch }
})

test('datas brasileiras rejeitam calendário e horário inválidos', () => {
  assert.equal(brazilAuctionDate('15/10/2026 às 10h').date?.toISOString(), '2026-10-15T13:00:00.000Z')
  assert.equal(brazilAuctionDate('15/10/2026').timeKnown, false)
  assert.equal(brazilAuctionDate('31/02/2026 às 10:00').date, null)
  assert.equal(brazilAuctionDate('15/10/2026 às 25:00').date, null)
})
