import assert from 'node:assert/strict'
import test from 'node:test'
import { openFavaretoDebugTransport } from '../layers/scrapers/server/utils/favareto-debug-transport.js'

test('senha da tela e chave pública da API não substituem o segredo interno de controle', async () => {
  const previousControl = process.env.FAVARETO_BROWSER_CONTROL_KEY
  const previousService = process.env.SCRAPER_SERVICE_KEY
  delete process.env.FAVARETO_BROWSER_CONTROL_KEY
  process.env.SCRAPER_SERVICE_KEY = 'favareto-debug'
  try {
    await assert.rejects(openFavaretoDebugTransport({ warmupUrl: 'https://www.favaretoleiloes.com.br/leiloes/' }), /Canal interno gráfico ausente/)
  } finally {
    if (previousControl === undefined) delete process.env.FAVARETO_BROWSER_CONTROL_KEY
    else process.env.FAVARETO_BROWSER_CONTROL_KEY = previousControl
    if (previousService === undefined) delete process.env.SCRAPER_SERVICE_KEY
    else process.env.SCRAPER_SERVICE_KEY = previousService
  }
})

test('sessão gráfica consulta o navegador local e libera a coleta sem fechar o perfil', async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.FAVARETO_BROWSER_CONTROL_KEY
  process.env.FAVARETO_BROWSER_CONTROL_KEY = 'somente-teste'
  const requests: Array<{ url: string; body: Record<string, unknown> }> = []
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    assert.equal(new Headers(init?.headers).get('x-browser-control-key'), 'somente-teste')
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    requests.push({ url, body })
    return Response.json(url.endsWith('/session') ? { session: 'sessao-1' } : url.endsWith('/request') ? { status: 200, body: '<title>Favareto</title>' } : { ok: true })
  }) as typeof fetch
  try {
    const browser = await openFavaretoDebugTransport({ warmupUrl: 'https://www.favaretoleiloes.com.br/leiloes/' })
    assert.deepEqual(await browser.request('https://www.favaretoleiloes.com.br/edital/1651/'), { status: 200, body: '<title>Favareto</title>' })
    await browser.close()
    await browser.close()
    assert.deepEqual(requests.map(item => new URL(item.url).pathname), ['/session', '/request', '/release'])
    assert.equal(requests[1]!.body.session, 'sessao-1')
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.FAVARETO_BROWSER_CONTROL_KEY
    else process.env.FAVARETO_BROWSER_CONTROL_KEY = previousKey
  }
})

test('sessão gráfica mantém diagnóstico quando a verificação manual não libera o catálogo', async () => {
  const previousFetch = globalThis.fetch
  const previousKey = process.env.FAVARETO_BROWSER_CONTROL_KEY
  process.env.FAVARETO_BROWSER_CONTROL_KEY = 'somente-teste'
  globalThis.fetch = (async () => Response.json({ error: 'Abra /internal/browser/ e conclua a verificação manual.' }, { status: 409 })) as typeof fetch
  try {
    await assert.rejects(openFavaretoDebugTransport({ warmupUrl: 'https://www.favaretoleiloes.com.br/leiloes/' }), /conclua a verificação manual/)
  } finally {
    globalThis.fetch = previousFetch
    if (previousKey === undefined) delete process.env.FAVARETO_BROWSER_CONTROL_KEY
    else process.env.FAVARETO_BROWSER_CONTROL_KEY = previousKey
  }
})
