import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { scrapeFavareto } from '../src/scrapers/favareto.js'
import type { AuctionVehicle } from '../src/formatters/auction-card.js'
import { favaretoSource, type FavaretoScraperOptions } from '../layers/scrapers/server/utils/sources/favareto.js'
import type { RawScrapedVehicle } from '../layers/scrapers/server/utils/source-types.js'
import type { BrowserTransport } from '../layers/scrapers/server/utils/browser-transport.js'

const BASE = 'https://www.favaretoleiloes.com.br'
const fixture = (name: string) => readFileSync(new URL(`./fixtures/favareto-${name}`, import.meta.url), 'utf8')
const edital = fixture('edital.html')
const lot = JSON.parse(fixture('lot.json')) as Record<string, unknown>
const history = JSON.parse(fixture('history.json')) as Record<string, unknown>
const listing = `<title>Favareto Leil&otilde;es</title><ul id="info-leilao"><li><a href="edital/1651">VISITAR LOTES</a><a href="/edital/1651/">VISITAR LOTES</a><a href="${BASE}/edital/1651/?x=1">VISITAR LOTES</a><a href="https://outro.example/edital/9999/">Outro</a></li></ul>`
const empty = '<title>Favareto Leil&otilde;es</title><main>Conteúdo indisponível</main>'
const challenge = '<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'
type Reply = { status: number; text: string }
type Request = { url: string; params: URLSearchParams }
const html = (text: string, status = 200): Reply => ({ status, text })
const json = (value: unknown): Reply => html(JSON.stringify(value))

function publicSite({ url, params }: Request): Reply {
  if (url === `${BASE}/leiloes/`) return html(listing)
  if (url === `${BASE}/edital/1651/`) return html(edital)
  if (url.endsWith('/json_lance.php')) {
    // Both lots share bem: collection must deduplicate by lot URL, preserving both.
    return json({ ...lot, numlote: params.get('ordem') === '1' ? '001' : '002', grupo: params.get('ordem') === '1' ? lot.grupo : '' })
  }
  if (url.endsWith('/json_historico.php')) return json(history)
  throw new Error(`Requisição inesperada: ${url}`)
}

async function withFetch<T>(handler: (request: Request) => Reply, run: () => Promise<T>) {
  const original = globalThis.fetch
  const requests: Request[] = []
  globalThis.fetch = (async (input, init) => {
    init?.signal?.throwIfAborted()
    const request = { url: String(input), params: new URLSearchParams(String(init?.body ?? '')) }
    requests.push(request)
    const reply = handler(request)
    // Favareto HTML uses windows-1252; its JSON uses UTF-8 escaped strings.
    const body = request.url.includes('.php') ? reply.text : Buffer.from(reply.text, 'latin1')
    return new Response(body, { status: reply.status })
  }) as typeof fetch
  try { return { result: await run(), requests } }
  finally { globalThis.fetch = original }
}

function browserSite(handler: (request: Request) => Reply = publicSite) {
  let closes = 0
  const transport: BrowserTransport = {
    async request(url, init) {
      const reply = handler({ url, params: new URLSearchParams(init?.body) })
      return { status: reply.status, body: reply.text }
    },
    async close() { closes++ },
  }
  return { transport, closes: () => closes }
}

const scrapers = [
  ['CLI/cloud', (options: FavaretoScraperOptions) => scrapeFavareto({} as never, options)],
  ['Nuxt', (options: FavaretoScraperOptions) => favaretoSource.run({} as never, options)],
] as const

for (const [name, scrape] of scrapers) {
  const run = async (options: FavaretoScraperOptions = {}): Promise<Array<AuctionVehicle | RawScrapedVehicle>> => scrape({ log: () => {}, browserFallback: false, ...options })

  test(`Favareto (${name}) segue VISITAR LOTES e preserva lotes distintos, comitente, lance, fotos e identificação`, async () => {
    const { result, requests } = await withFetch(publicSite, () => run())
    assert.equal(result.length, 2)
    assert.equal(requests.filter(request => request.url.includes('/edital/')).length, 1, 'links equivalentes visitam o edital uma vez')
    assert.deepEqual(requests.filter(request => request.url.endsWith('/json_lance.php')).map(request => Object.fromEntries(request.params)), [
      { ordem: '1', leilao: '1651' }, { ordem: '2', leilao: '1651' },
    ])
    const first = result[0]!
    assert.equal(first.brand, 'VW')
    assert.equal(first.model, 'FOX 1.6 PRIME GII')
    assert.equal(first.year, 2012)
    assert.equal(first.lot, '001')
    assert.equal(first.auctionId, '1651')
    assert.equal(first.auctionUrl, `${BASE}/edital/1651/`)
    assert.equal(first.auctionDate?.getFullYear(), 2026)
    assert.equal(first.auctionDate?.getMonth(), 9)
    assert.equal(first.auctionDate?.getDate(), 28)
    assert.equal(first.consignor, 'BANCO J SAFRA FINANCEIRA')
    assert.equal(result[1]!.consignor, first.consignor, 'cabeçalho do edital complementa grupo ausente na API')
    assert.equal(first.price, 16000)
    assert.equal(first.fuel, 'ALCOOL/GASOLINA')
    assert.equal(first.km, '205.332')
    assert.equal(first.description, 'NECESSÁRIO RECALL')
    assert.equal(first.imageUrls.length, 7)
    assert.equal(first.imageUrls[0], 'https://srv1.favaretoleiloes.com.br/20250416135058279_248942.JPG')
  })

  test(`Favareto (${name}) aceita reCAPTCHA e script JSD em página normal`, async () => {
    const jsd = '<script src="https://www.google.com/recaptcha/api.js"></script><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'
    const { result } = await withFetch(request => {
      const reply = publicSite(request)
      return request.url.includes('.php') ? reply : html(reply.text + jsd)
    }, () => run())
    assert.equal(result.length, 2)
  })

  for (const [reason, response] of [['HTTP 403', html(challenge, 403)], ['listagem sem editais', html(empty)]] as const) {
    test(`Favareto (${name}) recupera ${reason} pelo navegador e encerra a sessão`, async () => {
      const browser = browserSite()
      let opens = 0
      const { result } = await withFetch(() => response, () => run({ browserFallback: async options => {
        opens++
        assert.equal(options.warmupUrl, `${BASE}/leiloes/`)
        return browser.transport
      } }))
      assert.equal(result.length, 2)
      assert.equal(opens, 1)
      assert.equal(browser.closes(), 1)
    })
  }

  test(`Favareto (${name}) não transforma edital sem lotes reconhecidos em sucesso com zero`, async () => {
    const brokenSite = (request: Request) => request.url.includes('/edital/') ? html(empty) : publicSite(request)
    const browser = browserSite(brokenSite)
    await assert.rejects(withFetch(brokenSite, () => run({ browserFallback: async () => browser.transport })), /HTTP direto falhou .*navegador também falhou: .*nenhum lote reconhecido/s)
    assert.equal(browser.closes(), 1)
  })

  test(`Favareto (${name}) informa bloqueio dos dois transportes`, async () => {
    const browser = browserSite(() => html(challenge, 403))
    await assert.rejects(withFetch(() => html(challenge, 403), () => run({ browserFallback: async () => browser.transport })), /HTTP direto falhou .*HTTP 403.*navegador também falhou: .*HTTP 403/s)
    assert.equal(browser.closes(), 1)
  })

  test(`Favareto (${name}) mantém preço do edital quando histórico falha e aceita veículos anteriores a 2000`, async () => {
    const { result } = await withFetch(request => {
      if (request.url.endsWith('/json_historico.php')) return html('indisponível', 500)
      if (request.url.endsWith('/json_lance.php')) return json({ ...lot, ano: '1998/1999', minimo: '9000.00' })
      return publicSite(request)
    }, () => run())
    assert.equal(result[0]!.price, 16000)
    assert.equal(result[0]!.year, 1998)
  })

  test(`Favareto (${name}) falha quando API de todos os lotes é recusada`, async () => {
    await assert.rejects(withFetch(request => request.url.endsWith('/json_lance.php') ? html(challenge, 403) : publicSite(request), () => run()), /API de lotes falhou em todos os 2 lote/)
  })

  test(`Favareto (${name}) não abre navegador após cancelamento`, async () => {
    const controller = new AbortController()
    let opens = 0
    controller.abort()
    await assert.rejects(run({ signal: controller.signal, browserFallback: async () => {
      opens++
      return browserSite().transport
    } }))
    assert.equal(opens, 0)
  })

  test(`Favareto (${name}) usa somente a sessão gráfica quando diagnóstico está ativado`, async () => {
    const previous = process.env.FAVARETO_BROWSER_DEBUG
    process.env.FAVARETO_BROWSER_DEBUG = '1'
    const browser = browserSite()
    try {
      const { result, requests } = await withFetch(() => { throw new Error('HTTP direto não deve ser usado no diagnóstico gráfico') }, () => run({ browserFallback: async () => browser.transport }))
      assert.equal(result.length, 2)
      assert.equal(requests.length, 0)
      assert.equal(browser.closes(), 1)
    } finally {
      if (previous === undefined) delete process.env.FAVARETO_BROWSER_DEBUG
      else process.env.FAVARETO_BROWSER_DEBUG = previous
    }
  })
}
