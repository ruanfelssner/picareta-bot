import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { freitasListing, freitasPageUrl, parseFreitasLot, runFreitasScraper } from '../layers/scrapers/server/utils/sources/freitas.js'
import { isIncompleteTlsChainError } from '../layers/scrapers/server/utils/incomplete-tls-chain.js'
import { PartialScraperResultError } from '../layers/scrapers/server/utils/source-types.js'
import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '../shared/constants/sources.js'

const fixture = (name: string) => readFileSync(`tests/fixtures/freitas-public-${name}`, 'utf8')
const list = fixture('list.html'), html = fixture('lot.html'), photos = fixture('photos.html'), bid = fixture('bid.html'), status = fixture('status.json')
const lot = freitasListing(list).lots[0]!
const quiet = () => {}
const empty = '<div class="alert">Nenhum lote localizado com os filtros aplicados!</div>'

test('Freitas mantém consulta paginada e identidade canônica por leilão/lote', () => {
  assert.equal(freitasListing(list).lots.length, 12)
  assert.equal(new URL(freitasPageUrl(4)).searchParams.get('PageNumber'), '4')
  assert.equal(new URL(freitasPageUrl(4)).searchParams.get('TipoLoteId'), '1')
  assert.equal(lot.url, 'https://www.freitasleiloeiro.com.br/Leiloes/LoteDetalhes?leilaoId=8106&loteNumero=1')
  assert.equal(freitasListing(list + list).lots.length, 12)
  assert.ok(ACTIVE_AUCTION_SOURCES.includes('freitas'))
  assert.equal(SOURCE_META.freitas.name, 'Freitas Leiloeiro')
})

test('Freitas extrai dados públicos reais sem usar incremento, edital ou valor inicial como lance atual', () => {
  const car = parseFreitasLot(lot, html, photos, bid, status)
  assert.deepEqual([car.brand, car.model, car.year], ['HONDA', 'CITY LX FLEX', 2010])
  assert.equal(car.price, 18000)
  assert.equal(car.auctionDate?.toISOString(), '2026-10-13T13:00:00.000Z')
  assert.equal(car.auctionTimeKnown, true)
  assert.equal(car.state, 'SP')
  assert.equal(car.city, 'SANTO ANDRE')
  assert.equal(car.color, 'PRETA')
  assert.equal(car.fuel, 'GASOL/ALC')
  assert.ok(car.imageUrls.length > 1)
  assert.ok(car.imageUrls.every(url => url.includes('/LEILOES/8106/FOTOS/001/')))
  assert.equal(car.fipe, null)
  assert.equal(car.damage, null)
  assert.equal(car.consignor, null)
  assert.equal(car.auctionUrl, null)
  assert.equal(car.soldPrice, null)
  assert.match(car.description, /Despesas operacionais/)
})

test('Freitas normaliza importados, ano-modelo e monta explícita sem interpretar cláusulas genéricas', () => {
  const changed = html.replace('HONDA/CITY LX FLEX, 09/10', 'I/VW JETTA HL AE, 16/17')
  const car = parseFreitasLot({ ...lot, card: lot.card.replace('FINANCEIRA', 'SEGURADORA SINISTRO/PEQ MONT') }, changed, photos, bid, status)
  assert.deepEqual([car.brand, car.model, car.year, car.damage], ['VOLKSWAGEN', 'JETTA HL AE', 2017, 'PEQUENA MONTA'])
})

test('Freitas separa vendido, condicional e não vendido; lance inicial não confirma arremate', () => {
  const makeStatus = (name: string) => JSON.stringify({ success: true, message: { nome: name, statusLeilaoId: 3 } })
  for (const [name, sale] of [['VENDIDO', 'sold'], ['CONDICIONAL', 'conditional'], ['NÃO VENDIDO', 'not_sold']] as const) {
    const car = parseFreitasLot(lot, html, photos, bid, makeStatus(name))
    assert.equal(car.saleStatus, sale)
    assert.equal(car.soldPrice, sale === 'sold' ? 18000 : null)
  }
  const noBid = '<input id="hdMaiorLance" value="0,0">'
  assert.equal(parseFreitasLot(lot, html, photos, noBid, status).price, 17000)
  const sold = parseFreitasLot(lot, html, photos, noBid, makeStatus('VENDIDO'))
  assert.equal(sold.price, null)
  assert.equal(sold.soldPrice, null)
})

test('Freitas falha em layout desconhecido, bloqueio HTTP 200, identidade divergente e dados incompletos', () => {
  assert.equal(freitasListing(empty).empty, true)
  for (const value of ['<html>Login</html>', '<div>Radware Captcha</div>', '<p>Erro ao tentar retornar os dados!</p>']) assert.throws(() => freitasListing(value))
  assert.throws(() => parseFreitasLot({ ...lot, auctionId: '999' }, html, photos, bid, status), /Identidade/)
  assert.throws(() => parseFreitasLot(lot, html, '<p>aguarde</p>', bid, status), /Galeria/)
  assert.throws(() => parseFreitasLot(lot, html, photos.replaceAll('/FOTOS/001/', '/FOTOS/999/'), bid, status), /Galeria/)
  assert.throws(() => parseFreitasLot(lot, html, photos, '<p>login</p>', status), /Maior lance/)
  assert.throws(() => parseFreitasLot(lot, html, photos, bid, '{"success":false}'), /indisponível/)
})

function mockRequest(pages: string[], failLot = false) {
  const calls: string[] = []
  const request = async (value: string) => {
    calls.push(value)
    const url = new URL(value)
    if (url.pathname.endsWith('/PesquisarLotes')) return pages[Number(url.searchParams.get('PageNumber')) - 1] ?? empty
    if (failLot && url.searchParams.get('loteNumero') === '2') throw new Error('HTTP 503')
    if (url.pathname.endsWith('/ListarFotosLote')) return photos.replaceAll('/FOTOS/001/', `/FOTOS/${String(url.searchParams.get('loteNumero')).padStart(3, '0')}/`)
    if (url.pathname.endsWith('/RetornarMaiorLanceLote')) return bid
    if (url.pathname.endsWith('/RetornarLoteStatus')) return status
    return html.replace("var loteNumero = parseInt('1')", `var loteNumero = parseInt('${url.searchParams.get('loteNumero')}')`)
  }
  return { request, calls }
}

test('Freitas visita páginas além da primeira, inclusive página curta, e emite veículos uma vez', async () => {
  const second = freitasListing(list).lots[1]!
  const mock = mockRequest([lot.card, second.card, empty])
  const emitted: string[] = []
  const cars = await runFreitasScraper({ log: quiet, onVehicle: car => { emitted.push(car.url) } }, mock.request)
  assert.equal(cars.length, 2)
  assert.deepEqual(emitted, cars.map(car => car.url))
  assert.equal(mock.calls.filter(url => url.includes('/PesquisarLotes?')).length, 3)
})

test('Freitas preserva coleta parcial ao falhar lote e rejeita paginação repetida', async () => {
  const second = freitasListing(list).lots[1]!
  const mock = mockRequest([lot.card + second.card, empty], true)
  await assert.rejects(runFreitasScraper({ log: quiet }, mock.request), (error: unknown) => {
    assert.ok(error instanceof PartialScraperResultError)
    assert.equal(error.vehicles.length, 1)
    assert.match(error.message, /503/)
    return true
  })
  await assert.rejects(runFreitasScraper({ log: quiet }, mockRequest([lot.card, lot.card]).request), /Paginação repetiu/)
})

test('Freitas respeita cancelamento antes de consultar e após resultados parciais', async () => {
  const controller = new AbortController(); controller.abort()
  await assert.rejects(runFreitasScraper({ log: quiet, signal: controller.signal }, async () => { throw new Error('Não deveria consultar') }), /abort/i)
  const active = new AbortController()
  await assert.rejects(runFreitasScraper({ log: quiet, signal: active.signal, onVehicle: () => active.abort() }, mockRequest([lot.card, empty]).request), (error: unknown) => {
    assert.ok(error instanceof PartialScraperResultError)
    assert.equal(error.vehicles.length, 1)
    return true
  })
})

test('Freitas interrompe novas consultas ao receber bloqueio 403, preservando parciais', async () => {
  const lots = freitasListing(list).lots.slice(0, 4)
  const mock = mockRequest([lots.map(item => item.card).join(''), empty])
  let lateDetails = 0
  const request = async (url: string) => {
    const target = new URL(url)
    if (target.pathname.endsWith('/LoteDetalhes') && target.searchParams.get('loteNumero') === '2') throw new Error('HTTP 403 em detalhe')
    if (target.pathname.endsWith('/LoteDetalhes') && target.searchParams.get('loteNumero') === '4') lateDetails++
    return mock.request(url)
  }
  await assert.rejects(runFreitasScraper({ log: quiet }, request), (error: unknown) => {
    assert.ok(error instanceof PartialScraperResultError)
    assert.equal(error.vehicles.length, 2)
    assert.match(error.message, /Acesso interrompido/)
    return true
  })
  assert.equal(lateDetails, 0)
})

test('Freitas identifica cadeia TLS incompleta sem mascarar outras falhas de rede', () => {
  const tlsError = Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
  assert.equal(isIncompleteTlsChainError(new TypeError('fetch failed', { cause: tlsError })), true)
  assert.equal(isIncompleteTlsChainError(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) })), false)
  assert.equal(isIncompleteTlsChainError(new Error('HTTP 403')), false)
})
