import assert from 'node:assert/strict'
import test from 'node:test'
import { looksLikeCloudflareChallenge, scrapeMgl } from '../src/scrapers/mgl.js'
import { mglSource } from '../layers/scrapers/server/utils/sources/mgl.js'

// Lote real reduzido da API /apiplugin/GetBusca do MGL (categoria veículos, out/2026).
const lot = {
  ID_Categoria: 88,
  Lote: 'TRÊS PONTAS/MG - VOLKSWAGEN Gol 1000I - 1995/1995',
  LoteNumero: 'JB0007775',
  URLlote: 'lote/leilao-judicial-de-veiculos/228372/',
  Cidade: 'Três Pontas',
  UF: 'MG',
  ValorAvaliacao: 3500,
  ValorVendaDireta: 0,
  ValorInicialPrimeiraPraca: 2100,
  Fotos: [{ ID_Leiloes_Foto: 0, LabelFoto: null, Foto: 'f6f9f678-ddba-4cfc-a15b-a9661efa8813.jpg' }, { Foto: 'Semfoto.jpg' }],
  GetLoteRealTime: [{ ValorLanceAtual: 0, ValorMinimoLancePrimeiraPraca: 2100, DataHoraEncerramentoPrimeiraPraca: '1900-01-01T00:00:00', Lote_SubStatus_Label: 'Aberto para lance', StatusLote: 'Online' }],
}
const secondLot = { ...lot, Lote: 'MACHADO/MG - CHEVROLET Kadett SL EFI - 1992/1993', LoteNumero: 'JB0006424', URLlote: 'lote/leilao-judicial-de-veiculos/228363/', Fotos: [{ Foto: 'Semfoto.jpg' }] }
const page = (lotes: unknown[], pages = 2) => ({ CountTotal: 49, Lotes: lotes, Paginacao: { Paginas: Array.from({ length: pages }, (_, index) => ({ Pagina: index + 1 })) } })

// Bloqueio WAF real recebido pelo fetch do Node (TLS do Node é barrado mesmo de IP residencial; curl recebe 200).
const cloudflareBlock = '<!DOCTYPE html><title>Attention Required! | Cloudflare</title><div id="cf-error-details"><h1>Sorry, you have been blocked</h1></div>'

type Options = { log?: (msg: string) => void; signal?: AbortSignal; browserFallback?: false | ((input: { maxPages: number }) => Promise<unknown[]>) }
type Car = { url: string; brand: string; model: string; year: number | null; price: number | null; lot?: string | null; auctionDate: Date | null; imageUrls: string[] }
const quiet = () => {}
const scrapers: Array<[string, (options?: Options) => Promise<Car[]>]> = [
  ['src', (options = {}) => scrapeMgl({} as never, { log: quiet, browserFallback: false, ...options } as never)],
  ['layers', (options = {}) => mglSource.run({} as never, { log: quiet, browserFallback: false, ...options } as never)],
]

async function withFetch<T>(handler: (url: string, body: Record<string, unknown>) => Response, run: () => Promise<T>): Promise<{ result: T; urls: string[] }> {
  const original = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const url = String(input instanceof Request ? input.url : input)
    urls.push(url)
    return handler(url, JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>)
  }) as typeof fetch
  try { return { result: await run(), urls } }
  finally { globalThis.fetch = original }
}

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' } })
const blocked = () => new Response(cloudflareBlock, { status: 403, headers: { 'content-type': 'text/html; charset=UTF-8' } })

test('MGL não confunde o script JSD do Cloudflare, presente em toda página normal, com desafio anti-bot', () => {
  // Trecho real de /comprar/ (HTTP 200): o Cloudflare injeta este script em todas as páginas.
  const normalPage = '<title>MGL Leilões | Leilões judiciais e extrajudiciais</title><script>var a=document.createElement(\'script\');a.src=\'/cdn-cgi/challenge-platform/scripts/jsd/main.js\';</script>'
  assert.equal(looksLikeCloudflareChallenge(normalPage), false)
  assert.equal(looksLikeCloudflareChallenge('<title>Just a moment...</title><script>window._cf_chl_opt={}</script>'), true)
  assert.equal(looksLikeCloudflareChallenge(cloudflareBlock), true)
})

for (const [name, scrape] of scrapers) {
  test(`MGL (${name}) pagina a API de busca, deduplica e converte lotes`, async () => {
    const { result, urls } = await withFetch(
      (_url, body) => json(body.Pagina === 1 ? page([lot]) : page([secondLot, lot])),
      () => scrape(),
    )
    assert.deepEqual(urls.map(url => new URL(url).pathname), ['/apiplugin/GetBusca/1/1/0', '/apiplugin/GetBusca/2/1/0'])
    assert.ok(urls.every(url => new URL(url).searchParams.getAll('FiltroCategorias').join() === '88,108'))
    assert.deepEqual(result.map(car => car.url), [
      'https://www.mgl.com.br/lote/leilao-judicial-de-veiculos/228372/',
      'https://www.mgl.com.br/lote/leilao-judicial-de-veiculos/228363/',
    ])
    const [gol, kadett] = result
    assert.equal(gol!.brand, 'VOLKSWAGEN')
    assert.equal(gol!.model, 'GOL 1000I - 1995/1995')
    assert.equal(gol!.year, 1995)
    assert.equal(gol!.price, 2100)
    assert.equal(gol!.lot, 'JB0007775')
    assert.equal(gol!.auctionDate, null)
    assert.deepEqual(gol!.imageUrls, ['https://www.mgl.com.br/imagens-center/279x202/f6f9f678-ddba-4cfc-a15b-a9661efa8813.jpg'])
    assert.deepEqual(kadett!.imageUrls, [], 'placeholder Semfoto.jpg não vira imagem')
  })

  test(`MGL (${name}) falha com erro claro no bloqueio Cloudflare em vez de retornar 0`, async () => {
    await assert.rejects(
      withFetch(blocked, () => scrape()),
      /\[mgl\] API de busca respondeu HTTP 403 \(bloqueio Cloudflare: "Sorry, you have been blocked"\) na página 1 via HTTP\. Fallback por navegador desativado\./,
    )
  })

  test(`MGL (${name}) usa o navegador quando o HTTP direto é bloqueado e propaga a falha dos dois caminhos`, async () => {
    const browserCars = [{ source: 'mgl', url: 'https://www.mgl.com.br/lote/x/1/' }]
    const ok = await withFetch(blocked, () => scrape({ browserFallback: async ({ maxPages }) => { assert.equal(maxPages, 8); return browserCars } }))
    assert.equal(ok.result, browserCars)

    await assert.rejects(
      withFetch(blocked, () => scrape({ browserFallback: async () => { throw new Error('Cloudflare bloqueou o navegador em /comprar/') } })),
      /\[mgl\] HTTP direto falhou \(API de busca respondeu HTTP 403 .*\) e o navegador também falhou: Cloudflare bloqueou o navegador em \/comprar\//,
    )
  })

  test(`MGL (${name}) falha com erro claro em rede ou estrutura irreconhecível`, async () => {
    await assert.rejects(withFetch(() => { throw new TypeError('fetch failed') }, () => scrape()), /\[mgl\] Falha de rede na API de busca \(página 1\): fetch failed/)
    await assert.rejects(withFetch(() => new Response('<html>manutenção</html>', { status: 200, headers: { 'content-type': 'text/html' } }), () => scrape()), /\[mgl\] API de busca respondeu sem JSON válido/)
    await assert.rejects(withFetch(() => json({ Itens: [] }), () => scrape()), /\[mgl\] Resposta inesperada da API de busca \(sem lista "Lotes"\)/)
    await assert.rejects(withFetch(() => json({ CountTotal: 1, Lotes: [{ foo: 1 }] }), () => scrape()), /\[mgl\] 1 lote\(s\) recebido\(s\) na página 1 via HTTP, mas nenhum reconhecido/)
    await assert.rejects(withFetch(() => json({ CountTotal: 12, Lotes: [] }), () => scrape()), /\[mgl\] API informou CountTotal=12, mas a página 1 veio sem lotes/)
  })

  test(`MGL (${name}) estrutura irreconhecível não aciona o navegador`, async () => {
    let browserCalls = 0
    const browserFallback = async () => { browserCalls += 1; return [] }
    await assert.rejects(withFetch(() => json({ Itens: [] }), () => scrape({ browserFallback })), /sem lista "Lotes"/)
    assert.equal(browserCalls, 0)
  })

  test(`MGL (${name}) mantém lista vazia legítima e pula página seguinte com falha`, async () => {
    const empty = await withFetch(() => json({ CountTotal: 0, Lotes: [], Paginacao: { Paginas: [] } }), () => scrape())
    assert.deepEqual(empty.result, [])

    const partial = await withFetch((_url, body) => (body.Pagina === 1 ? json(page([lot])) : blocked()), () => scrape())
    assert.equal(partial.result.length, 1)
  })

  test(`MGL (${name}) respeita o signal de cancelamento`, async () => {
    const controller = new AbortController()
    controller.abort()
    let browserCalls = 0
    await assert.rejects(
      withFetch(() => json(page([lot])), () => scrape({ signal: controller.signal, browserFallback: async () => { browserCalls += 1; return [] } })),
      { name: 'AbortError' },
    )
    assert.equal(browserCalls, 0)
  })
}
