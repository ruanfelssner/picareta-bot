import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { leiloEvents, leiloListing, leiloPageUrl, leiloState, LEILO_SERIES_URL, parseLeiloLot, runLeiloScraper } from '../layers/scrapers/server/utils/sources/leilo.js'
import { PartialScraperResultError } from '../layers/scrapers/server/utils/source-types.js'
import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '../shared/constants/sources.js'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/leilo-public-${name}.html`, import.meta.url), 'utf8')
const series = leiloState(fixture('series'))
const events = leiloEvents(series), event = events[0]!
const first = leiloListing(leiloState(fixture('list')), event, 1)
const cards = first.lots
const quiet = () => {}
const html = (state: unknown) => `<script>window.__INITIAL_STATE__=${JSON.stringify(state)};document.currentScript.remove()</script>`
const detailState = (name = 'lot') => leiloState(fixture(name)) as { elastic: { lotePaginaAtualId: string; lotePaginaAtualData: Record<string, unknown> } }
const cardFor = (name: string) => cards.find(card => card.id === detailState(name).elastic.lotePaginaAtualId)!

test('Leilo descobre as edições ativas da série e percorre as duas páginas reais', () => {
  assert.equal(events.length, 2)
  assert.equal(event.id, '15b54d61-d520-11f1-9fd9-02420a00001f')
  assert.equal(first.total, 58)
  assert.equal(first.lots.length, 36)
  const second = leiloListing(leiloState(fixture('page2')), event, 2)
  assert.equal(second.lots.length, 22)
  assert.equal(new Set([...cards, ...second.lots].map(card => card.id)).size, 58)
  assert.equal(leiloListing(leiloState(fixture('next')), events[1]!, 1).total, 0)
  assert.ok(ACTIVE_AUCTION_SOURCES.includes('leilo'))
  assert.equal(SOURCE_META.leilo.name, 'Leilo Sul e Sudeste')
})

test('Leilo preserva ano-modelo, local do bem, lance inicial e galeria completa sem promover Valor Mercado a FIPE', () => {
  const car = parseLeiloLot(cards[0]!, detailState())
  assert.deepEqual([car.brand, car.model, car.year], ['AUDI', 'A5 SPORTBACK TFSI', 2018])
  assert.equal(car.price, 79500)
  assert.match(car.priceRaw!, /Lance inicial/)
  assert.equal(car.fipe, null)
  assert.equal(car.saleStatus, 'unknown')
  assert.equal(car.soldPrice, null)
  assert.equal(car.city, 'ALVORADA')
  assert.equal(car.state, 'RS')
  assert.equal(car.auctionDate?.toISOString(), '2026-11-16T17:00:00.000Z')
  assert.equal(car.auctionTimeKnown, true)
  assert.equal(car.auctionEndsAt, null)
  assert.equal(car.auctionUrl, null)
  assert.equal(car.imageUrls.length, 32)
  assert.equal(car.damage, null)
  assert.equal(car.consignor, 'SICOOB MAXICREDITO')
  assert.match(car.description, /139\.305,00/)
  assert.match(car.description, /Comissão do lote: 5%/)
  assert.match(car.description, /Remoção do lote: R\$ 800,00/)
  assert.match(car.description, /VENDIDO NO ESTADO/)
})

test('Leilo usa lance efetivo e mantém moto e lote sem fotos publicados', () => {
  const car = parseLeiloLot(cardFor('bid'), detailState('bid'))
  assert.equal(car.price, 37600)
  assert.match(car.priceRaw!, /Lance atual/)
  assert.equal(car.imageUrls.length, 29)
  assert.equal(car.fuel, 'Fle')
  const bike = parseLeiloLot(cardFor('bike'), detailState('bike'))
  assert.deepEqual([bike.brand, bike.model, bike.year], ['HONDA', 'ELITE 125', 2022])
  assert.equal(bike.state, 'PR')
  assert.deepEqual(parseLeiloLot(cardFor('no-photos'), detailState('no-photos')).imageUrls, [])
})

test('Leilo rejeita scripts executáveis sem avaliar código e aceita somente literais SSR conhecidos', () => {
  assert.deepEqual(leiloState('<script>window.__INITIAL_STATE__={"a":undefined,"b":new Date("2026-11-12T00:00:00Z"),"c":"undefined new Date()"};document.currentScript.remove()</script>'), { a: null, b: '2026-11-12T00:00:00Z', c: 'undefined new Date()' })
  assert.throws(() => leiloState('<script>window.__INITIAL_STATE__={"a":(()=>{throw Error("executado")})()};document.currentScript.remove()</script>'), /literais/)
  for (const bad of ['<h1>Security Checkpoint</h1>', '<title>Login</title>', '{"erro":true}', '<div>Nenhuma oferta foi encontrada</div>']) assert.throws(() => leiloState(bad), /sem dados/)
})

test('Leilo valida identidade, galeria, data e filtro antes de admitir um lote', () => {
  assert.throws(() => parseLeiloLot({ ...cards[0], id: cards[1]!.id }, detailState()), /Identidade/)
  const bad = detailState()
  bad.elastic.lotePaginaAtualData.quantidadeFotos = 33
  assert.throws(() => parseLeiloLot(cards[0]!, bad), /Galeria incompleta/)
  const wrongPhoto = detailState()
  wrongPhoto.elastic.lotePaginaAtualData.fotosUrls = ['https://example.com/photo.jpg']
  assert.throws(() => parseLeiloLot(cards[0]!, wrongPhoto), /galeria/)
  const listing = leiloState(fixture('list')) as { elastic: Record<string, unknown> }
  listing.elastic.filtrosBusca = []
  assert.throws(() => leiloListing(listing, event, 1), /Filtro/)
  assert.throws(() => leiloListing(leiloState(fixture('list')), event, 2), /Paginação/)
})

test('Leilo: estados sintéticos explícitos não usam inicial como arremate ou proposta como lance', () => {
  for (const [status, sale] of [['Pago', 'sold'], ['AgPagamento', 'sold'], ['Condicional', 'conditional'], ['NaoArrematado', 'not_sold'], ['Retirado', 'unknown'], ['EstadoFuturo', 'unknown']] as const) {
    const state = detailState()
    const lot = state.elastic.lotePaginaAtualData
    lot.situacao = status
    lot.valor = { minimo: 79500, valorProposta: 99000, incremento: 500, lance: { valor: null } }
    const car = parseLeiloLot(cards[0]!, state)
    assert.equal(car.saleStatus, sale)
    assert.equal(car.soldPrice, null)
    assert.equal(car.price, null)
    lot.valor = { minimo: 79500, lance: { valor: 80500 } }
    const withBid = parseLeiloLot(cards[0]!, state)
    assert.equal(withBid.price, 80500)
    assert.equal(withBid.soldPrice, sale === 'sold' ? 80500 : null)
  }
  const state = detailState(), lot = state.elastic.lotePaginaAtualData
  lot.descricao = 'Sucata. Grande monta.'
  lot.valor = { minimo: 0, valorProposta: 81000, lance: { valor: 0 } }
  const car = parseLeiloLot(cards[0]!, state)
  assert.equal(car.damage, 'Sucata')
  assert.equal(car.price, null)
})

// Paginação sintética curta, construída com os dois lotes reais completos.
function smallPage(page: number, ids: string[], total = 2, size = 1): string {
  const state = leiloState(fixture('list')) as { elastic: Record<string, unknown> }
  Object.assign(state.elastic, { totalRegistros: total, totalPaginasAtual: Math.max(1, Math.ceil(total / size)), tamanhoPaginaBusca: size, paginaAtualBusca: page, lotesPaginaAtual: ids, lotes: cards.filter(card => ids.includes(String(card.id))) })
  return html(state)
}
function onlyEvent(): string {
  const state = leiloState(fixture('series')) as { eventoSeo: { resolucoes: Record<string, { resolucao: Record<string, unknown> }> } }
  for (const entry of Object.values(state.eventoSeo.resolucoes)) entry.resolucao.edicoes = []
  return html(state)
}
const transport = (url: string) => {
  if (url === LEILO_SERIES_URL) return onlyEvent()
  if (url.includes('/lote/')) return url.includes(String(cards[0]!.id)) ? fixture('lot') : fixture('bid')
  const page = Number(new URL(url).searchParams.get('pagina') ?? 1)
  return smallPage(page, [String(cards[page - 1]!.id)])
}

test('Leilo runner percorre páginas, espera callback e deduplica emissões', async () => {
  const emitted: string[] = [], visited: string[] = []
  const result = await runLeiloScraper({ log: quiet, onVehicle: async car => { await Promise.resolve(); emitted.push(car.url) } }, async url => {
    visited.push(url)
    return transport(url)
  })
  assert.equal(result.length, 2)
  assert.equal(new Set(emitted).size, 2)
  assert.ok(visited.includes(leiloPageUrl(event.id, 2)))
})

test('Leilo runner continua após página curta e deduplica sobreposição sem perder total', async () => {
  const result = await runLeiloScraper({ log: quiet }, async url => {
    if (url === LEILO_SERIES_URL || url.includes('/lote/')) return transport(url)
    const page = Number(new URL(url).searchParams.get('pagina') ?? 1)
    return smallPage(page, page === 1 ? [String(cards[0]!.id)] : [String(cards[0]!.id), String(cards[1]!.id)], 3, 2)
  }).catch(error => error)
  // O total declara 3, mas há 2 identidades: não publicar snapshot completo.
  assert.ok(result instanceof PartialScraperResultError)
  assert.equal(result.vehicles.length, 2)
  assert.match(result.message, /Total de lotes/)
})

test('Leilo runner completa página curta quando as páginas seguintes fecham a contagem oficial', async () => {
  const third = cardFor('no-photos')
  const result = await runLeiloScraper({ log: quiet }, async url => {
    if (url.includes(String(third.id))) return fixture('no-photos')
    if (url === LEILO_SERIES_URL || url.includes('/lote/')) return transport(url)
    const page = Number(new URL(url).searchParams.get('pagina') ?? 1)
    return smallPage(page, page === 1 ? [String(cards[0]!.id)] : [String(cards[1]!.id), String(third.id)], 3, 2)
  })
  assert.equal(result.length, 3)
})

test('Leilo runner distingue vazio real, falta de detalhes e página repetida', async () => {
  const empty = await runLeiloScraper({ log: quiet }, async url => url === LEILO_SERIES_URL ? onlyEvent() : smallPage(1, [], 0))
  assert.deepEqual(empty, [])
  for (const mode of ['detail', 'repeat', 'total', 'http', 'timeout', 'captcha'] as const) {
    await assert.rejects(runLeiloScraper({ log: quiet }, async url => {
      if (url.includes('pagina=2')) {
        if (mode === 'http') throw new Error('HTTP 503')
        if (mode === 'timeout') throw new Error('Tempo de consulta excedido.')
        if (mode === 'captcha') return '<title>Security Checkpoint</title>'
        if (mode === 'repeat') return smallPage(2, [String(cards[0]!.id)])
        if (mode === 'total') return smallPage(2, [String(cards[1]!.id)], 3)
      }
      if (mode === 'detail' && url.includes(String(cards[1]!.id))) return '<h1>Detalhe indisponível</h1>'
      return transport(url)
    }), error => error instanceof PartialScraperResultError && error.vehicles.length === 1)
  }
})

test('Leilo rejeita HTTP/bloqueio inicial e limite de paginação em vez de informar estoque vazio', async () => {
  for (const message of ['HTTP 403', 'HTTP 429', 'HTTP 503', 'Tempo de consulta excedido.']) {
    await assert.rejects(runLeiloScraper({ log: quiet }, async () => { throw new Error(message) }), error => error instanceof Error && error.message === message)
  }
  await assert.rejects(runLeiloScraper({ log: quiet }, async url => url === LEILO_SERIES_URL ? onlyEvent() : smallPage(1, [String(cards[0]!.id)], 101)), /Limite de páginas/)
})

test('Leilo runner propaga cancelamento e falha do consumidor sem emitir duplicatas', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelado antes'))
  await assert.rejects(runLeiloScraper({ log: quiet, signal: controller.signal }, async () => { throw new Error('não consultar') }), /cancelado antes/)
  let emitted = 0
  await assert.rejects(runLeiloScraper({ log: quiet, onVehicle: () => { emitted++; throw new Error('persistência falhou') } }, async url => transport(url)), error => error instanceof PartialScraperResultError && /persistência falhou/.test(error.message))
  assert.equal(emitted, 1)
  const active = new AbortController()
  await assert.rejects(runLeiloScraper({ log: quiet, signal: active.signal, onVehicle: () => active.abort(new Error('cancelado durante')) }, async (url, options) => {
    assert.equal(options?.signal?.aborted, false)
    return transport(url)
  }), error => error instanceof PartialScraperResultError && /cancelado durante/.test(error.message))
})
