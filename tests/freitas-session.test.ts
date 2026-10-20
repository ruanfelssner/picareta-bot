import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import vm from 'node:vm'
import ts from 'typescript'
import { assertFreitasBrowserResponse, assertFreitasReadUrl, FREITAS_LIST_URL } from '../layers/scrapers/server/utils/freitas-session.js'

const moduleRequire = createRequire(resolve('package.json'))
type Session = { request: (_url: string, _options: { signal?: AbortSignal; referer?: string }) => Promise<string>; close: () => Promise<void> }
type Route = { request: () => { url: () => string; method: () => string; resourceType: () => string }; continue: () => void; abort: () => void }
const endpoint = 'https://www.freitasleiloeiro.com.br/Leiloes/RetornarLoteStatus?leilaoId=8119&loteNumero=67'

function browserFixture(bootstrapStatus = 200) {
  let closed = 0, evaluated = 0, contextCount = 0, now = 0, active = 0, maxActive = 0
  let nextStatus = 200
  const starts: number[] = []
  const waits: number[] = []
  const requests: Array<{ url: string; referer: string }> = []
  let routeHandler: (_route: Route) => Promise<void> | void = () => {}
  const page = {
    route: async (_pattern: string, handler: typeof routeHandler) => { routeHandler = handler },
    goto: async () => { starts.push(now); return { status: () => bootstrapStatus, text: async () => '<html>Pesquisa Freitas</html>' } },
    evaluate: async (_fn: unknown, input: { url: string; referer: string }) => {
      active++; maxActive = Math.max(active, maxActive); starts.push(now)
      await new Promise<void>(resolve => setImmediate(resolve))
      active--; evaluated++; requests.push(input)
      return { status: nextStatus, body: nextStatus === 200 ? 'consulta pública' : '<title>Acesso bloqueado</title>' }
    },
  }
  const mocks: Record<string, unknown> = {
    playwright: { chromium: { launch: async () => ({ newContext: async () => { contextCount++; return { newPage: async () => page } }, close: async () => { closed++ } }) } },
    'node:timers/promises': { setTimeout: async (ms: number, _value: unknown, options: { signal?: AbortSignal }) => { options.signal?.throwIfAborted(); waits.push(ms); now += ms } },
    './playwright-launch': { buildPlaywrightLaunchOptions: (headless: boolean) => ({ headless }) },
  }
  const exports: { openFreitasSession?: (_options?: { signal?: AbortSignal }) => Promise<Session> } = {}
  const source = ts.transpileModule(readFileSync(resolve('layers/scrapers/server/utils/freitas-session.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  vm.runInNewContext(source, { exports, require: (id: string) => id in mocks ? mocks[id] : moduleRequire(id), URL, Date: class extends Date { static now() { return now } } })
  return { open: exports.openFreitasSession!, route: (value: Route) => routeHandler(value), block: () => { nextStatus = 403 }, closed: () => closed, evaluated: () => evaluated, contexts: () => contextCount, maxActive: () => maxActive, starts, waits, requests }
}

test('Freitas restringe o navegador aos endpoints públicos GET, sem login, visitas, lances ou terceiros', async () => {
  assert.equal(assertFreitasReadUrl(endpoint).hostname, 'www.freitasleiloeiro.com.br')
  for (const url of ['https://evil.test/Leiloes/Pesquisar', 'https://www.freitasleiloeiro.com.br/Leiloes/InserirLance', 'https://user:password@www.freitasleiloeiro.com.br/Leiloes/Pesquisar', 'http://www.freitasleiloeiro.com.br/Leiloes/Pesquisar']) assert.throws(() => assertFreitasReadUrl(url))
  const mock = browserFixture()
  const session = await mock.open()
  async function allowed(url: string, method: string, resourceType: string) {
    let accepted = false
    await mock.route({ request: () => ({ url: () => url, method: () => method, resourceType: () => resourceType }), continue: () => { accepted = true }, abort: () => {} })
    return accepted
  }
  assert.equal(await allowed(endpoint, 'GET', 'fetch'), true)
  assert.equal(await allowed(endpoint, 'POST', 'fetch'), false)
  assert.equal(await allowed(endpoint, 'GET', 'script'), false)
  assert.equal(await allowed('https://www.freitasleiloeiro.com.br/Leiloes/InserirVisitaLote', 'GET', 'fetch'), false)
  await session.close()
})

test('Freitas reutiliza uma sessão e serializa chamadas com intervalo mínimo, inclusive chamadas concorrentes', async () => {
  const mock = browserFixture()
  const session = await mock.open()
  await Promise.all(Array.from({ length: 3 }, () => session.request(endpoint, { referer: FREITAS_LIST_URL })))
  assert.equal(mock.contexts(), 1)
  assert.equal(mock.evaluated(), 3)
  assert.equal(mock.maxActive(), 1)
  assert.ok(mock.starts.slice(1).every((start, index) => start - mock.starts[index]! >= 1000))
  assert.ok(mock.requests.every(request => request.referer === FREITAS_LIST_URL))
  await session.close(); await session.close()
  assert.equal(mock.closed(), 1)
})

test('Freitas interrompe a sessão bloqueada sem repetir 403 ou executar consultas já enfileiradas', async () => {
  const mock = browserFixture()
  const session = await mock.open()
  mock.block()
  const results = await Promise.allSettled(Array.from({ length: 3 }, () => session.request(endpoint, {})))
  assert.ok(results.every(result => result.status === 'rejected'))
  assert.equal(mock.evaluated(), 1)
  await session.close()
})

test('Freitas fecha o Chromium ao falhar na abertura e ao cancelar; não consulta após cancelamento', async () => {
  const failed = browserFixture(403)
  await assert.rejects(failed.open, /HTTP 403/)
  assert.equal(failed.closed(), 1)
  const mock = browserFixture()
  const controller = new AbortController()
  const session = await mock.open({ signal: controller.signal })
  controller.abort()
  await assert.rejects(() => session.request(endpoint, { signal: controller.signal }))
  await session.close()
  assert.equal(mock.closed(), 1)
  assert.equal(mock.evaluated(), 0)
})

test('Freitas informa bloqueio real e ID da requisição sem registrar cookies ou endereço IP', () => {
  const blocked = '<title>Acesso Bloqueado</title><div id="gocache-error-page">ID da requisição: abcdef0123456789 - Seu endereço IP: 192.0.2.1</div>'
  assert.throws(() => assertFreitasBrowserResponse(403, blocked, endpoint), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /GoCache.*abcdef0123456789/)
    assert.match(error.message, /liberação do IP de saída/)
    assert.doesNotMatch(error.message, /192\.0\.2\.1|set-cookie/i)
    return true
  })
  assert.throws(() => assertFreitasBrowserResponse(200, blocked, endpoint), /bloqueou/)
  assert.doesNotThrow(() => assertFreitasBrowserResponse(200, '<div>Lote disponível</div>', endpoint))
})

test('Freitas mantém orçamento de 30 minutos mesmo com timeout global legado de cinco minutos', () => {
  const source = readFileSync(resolve('layers/scrapers/server/utils/scraper-runner.ts'), 'utf8')
  const functions = source.slice(source.indexOf('function parseTimeoutMsFromEnv('), source.indexOf('function formatDuration('))
  const compiled = ts.transpileModule(`${functions}\nexport { getSourceTimeoutMs }`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const exports: { getSourceTimeoutMs?: (_source: string, _override?: number) => number } = {}
  vm.runInNewContext(compiled, { exports, process: { env: { SCRAPER_SOURCE_TIMEOUT_MS: '300000' } }, FREITAS_TIMEOUT_MS: 1800000, HARD_SOURCE_TIMEOUT_MS: 1800000, DEFAULT_SOURCE_TIMEOUT_MS: 300000, DEFAULT_SOURCE_TIMEOUT_MS_BY_SOURCE: { freitas: 1800000 } })
  assert.equal(exports.getSourceTimeoutMs!('freitas'), 1800000)
  assert.equal(exports.getSourceTimeoutMs!('sodre'), 300000)
  assert.equal(exports.getSourceTimeoutMs!('freitas', 5000), 5000, 'preserva timeout explícito de uma chamada')
})
