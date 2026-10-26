import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import test from 'node:test'
import { browserDebugEnabled, browserDebugPassword, createBrowserDebugGateway } from '../scripts/browser-debug-gateway.mjs'
import { validateFavaretoDebugRequest } from '../layers/scrapers/server/utils/favareto-debug-policy.mjs'

const key = 'chave-de-teste-somente'
const authorization = `Basic ${Buffer.from(`favareto:${key}`).toString('base64')}`

async function listen(server, t) {
  const sockets = new Set()
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolve => server.close(resolve))
  })
  return server.address().port
}

async function setup(t, enabled = true, configuredKey = key) {
  const upstream = createServer((req, res) => res.end(JSON.stringify({ path: req.url, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null })))
  upstream.on('upgrade', (req, socket) => {
    assert.equal(req.headers.authorization, undefined)
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    if (req.url.includes('smoke=1')) {
      socket.write(Buffer.concat([Buffer.from([0x81, 2]), Buffer.from('ok')]))
      socket.on('error', () => {})
      return
    }
    socket.on('data', data => socket.write(data))
    socket.on('error', () => {})
  })
  const upstreamPort = await listen(upstream, t)
  const control = createServer((_req, res) => res.end(JSON.stringify({ browserReady: true })))
  const controlPort = await listen(control, t)
  const gateway = createBrowserDebugGateway({ enabled, key: configuredKey, webPort: upstreamPort, controlPort })
  const server = createServer((req, res) => { if (!gateway.handle(req, res)) res.end('app') })
  server.on('upgrade', gateway.upgrade)
  const port = await listen(server, t)
  return { port, url: `http://127.0.0.1:${port}` }
}

function get(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, options, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('diagnóstico fica desligado por padrão e a senha tem fallback somente para a tela', () => {
  assert.equal(browserDebugEnabled({}), false)
  assert.equal(browserDebugEnabled({ FAVARETO_BROWSER_DEBUG: 'true' }), false)
  assert.equal(browserDebugEnabled({ FAVARETO_BROWSER_DEBUG: '1' }), true)
  assert.equal(browserDebugPassword(undefined), 'favareto-debug')
  assert.equal(browserDebugPassword('   '), 'favareto-debug')
  assert.equal(browserDebugPassword(` ${key} `), key)
})

test('sem chave configurada, tela usa senha padrão e ainda exige autenticação', async t => {
  const { url } = await setup(t, true, null)
  assert.equal((await get(`${url}/internal/browser/`)).status, 401)
  const generic = `Basic ${Buffer.from('favareto:favareto-debug').toString('base64')}`
  assert.equal((await get(`${url}/internal/browser/`, { headers: { authorization: generic } })).status, 302)
})

test('chave configurada prevalece e a senha padrão deixa de funcionar', async t => {
  const { url } = await setup(t)
  const generic = `Basic ${Buffer.from('favareto:favareto-debug').toString('base64')}`
  assert.equal((await get(`${url}/internal/browser/`, { headers: { authorization: generic } })).status, 401)
  assert.equal((await get(`${url}/internal/browser/`, { headers: { authorization } })).status, 302)
})

test('rota desativada retorna 404 e preserva o encaminhamento normal do app', async t => {
  const { url } = await setup(t, false)
  assert.equal((await get(`${url}/internal/browser/`, { headers: { authorization } })).status, 404)
  assert.equal((await get(`${url}/health`)).body, 'app')
})

test('tela, assets e status exigem a chave correta; chave em query não autentica', async t => {
  const { url } = await setup(t)
  for (const path of ['/', '/vnc.html', '/app/ui.js', '/status', `/?key=${key}`]) {
    const result = await get(`${url}/internal/browser${path}`)
    assert.equal(result.status, 401)
    assert.match(result.headers['www-authenticate'], /^Basic /)
    assert.equal(result.headers['cache-control'], 'no-store')
  }
  assert.equal((await get(`${url}/internal/browser/`, { headers: { authorization: 'Basic aW52YWxpZG8=' } })).status, 401)
  const redirect = await get(`${url}/internal/browser/`, { headers: { authorization } })
  assert.equal(redirect.status, 302)
  assert.match(redirect.headers.location, /path=internal\/browser\/websockify$/)
})

test('gateway encaminha assets e status sem repassar credenciais e bloqueia comandos públicos', async t => {
  const { url } = await setup(t)
  const result = await get(`${url}/internal/browser/app/ui.js?x=1`, { headers: { authorization, cookie: 'segredo=1' } })
  assert.equal(result.status, 200)
  assert.deepEqual(JSON.parse(result.body), { path: '/app/ui.js?x=1', authorization: null, cookie: null })
  const status = await get(`${url}/internal/browser/status`, { headers: { authorization } })
  assert.deepEqual(JSON.parse(status.body), { browserReady: true })
  const denied = await get(`${url}/internal/browser/session`, { method: 'POST', headers: { authorization } })
  assert.equal(denied.status, 405)
})

function upgrade(port, headers = {}, data) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/internal/browser/websockify', headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } })
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode }) })
    req.on('upgrade', (res, socket) => {
      if (!data) { socket.destroy(); resolve({ status: res.statusCode }); return }
      socket.once('data', chunk => { socket.destroy(); resolve({ status: res.statusCode, data: chunk.toString() }) })
      socket.on('error', reject)
      socket.write(data)
    })
    req.on('error', reject)
    req.end()
  })
}

test('WebSocket rejeita acesso sem autenticação, origem diferente e modo desativado', async t => {
  const { port } = await setup(t)
  assert.equal((await upgrade(port)).status, 401)
  assert.equal((await upgrade(port, { authorization, Origin: 'https://outro.example' })).status, 403)
  const disabled = await setup(t, false)
  assert.equal((await upgrade(disabled.port, { authorization })).status, 404)
})

test('WebSocket autenticado transmite dados pela mesma porta do app', async t => {
  const { port } = await setup(t)
  assert.deepEqual(await upgrade(port, { authorization, Origin: `http://127.0.0.1:${port}` }, 'teste-vnc'), { status: 101, data: 'teste-vnc' })
})

test('canal de automação permite somente consultas públicas Favareto', () => {
  const origin = 'https://www.favaretoleiloes.com.br'
  assert.equal(validateFavaretoDebugRequest({ url: `${origin}/edital/1651/` }).init.method, 'GET')
  const detail = validateFavaretoDebugRequest({ url: `${origin}/classes/json_lance.php`, init: { method: 'POST', body: 'ordem=1&leilao=1651', headers: { Authorization: 'descartar' } } })
  assert.equal(detail.init.headers.Authorization, undefined)
  assert.equal(detail.init.method, 'POST')
  assert.equal(validateFavaretoDebugRequest({ url: `${origin}/classes/json_historico.php`, init: { method: 'POST', body: 'seq=1&data=1651&dataleilao=28%2F10%2F2026' } }).init.method, 'POST')
  for (const input of [
    { url: 'http://127.0.0.1/health' },
    { url: `${origin}/classes/json_lance.php`, init: { method: 'POST', body: 'ordem=1&leilao=1651&lance=999' } },
    { url: `${origin}/classes/json_lance.php`, init: { method: 'POST', body: 'ordem=1&ordem=2&leilao=1651' } },
    { url: `${origin}/classes/enviar_lance.php`, init: { method: 'POST', body: 'lance=999' } },
    { url: `${origin}/leiloes/?url=http://localhost` },
    { url: `${origin}/edital/1651/`, init: { method: 'DELETE' } },
  ]) assert.throws(() => validateFavaretoDebugRequest(input))
})

test('navegador real autentica a página e o WebSocket com as mesmas credenciais', { skip: process.env.FAVARETO_BROWSER_SMOKE !== '1' }, async t => {
  const { chromium } = await import('playwright')
  const { url, port } = await setup(t)
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ httpCredentials: { username: 'favareto', password: key } })
  const page = await context.newPage()
  await page.goto(`${url}/internal/browser/vnc.html`)
  const result = await page.evaluate(port => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/internal/browser/websockify?smoke=1`)
    const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket não autenticou')) }, 5_000)
    socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(event.data) }
    socket.onerror = () => { clearTimeout(timer); reject(new Error('Falha no WebSocket')) }
  }), port)
  assert.equal(result, 'ok')
})
