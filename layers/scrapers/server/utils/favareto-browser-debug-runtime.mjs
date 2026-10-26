import { spawn } from 'node:child_process'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'
import { validateFavaretoDebugRequest } from './favareto-debug-policy.mjs'

export function startFavaretoBrowserDebug() {
  const LISTING = 'https://www.favaretoleiloes.com.br/leiloes/'
  const PROFILE = join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data', 'favareto-browser')
  const key = process.env.FAVARETO_BROWSER_CONTROL_KEY?.trim()
  if (!key) throw new Error('Canal interno gráfico ausente. Inicie o diagnóstico pelo comando start:combined.')
  const expectedKey = Buffer.from(key)
  const children = []
  let context
  let page
  let lease = null
  let navigationStatus = null
  let startupError = null
  let stopping = false

  function child(name, command, args) {
    const processChild = spawn(command, args, { stdio: 'inherit', env: { ...process.env, DISPLAY: ':99' } })
    children.push(processChild)
    processChild.on('error', error => { console.error(`[browser-debug] ${name}: ${error.message}`); void stop(1) })
    processChild.on('exit', code => { if (!stopping) { console.error(`[browser-debug] ${name} encerrou (${code}).`); void stop(1) } })
  }

  async function until(check, timeoutMs) {
    const end = Date.now() + timeoutMs
    while (Date.now() < end && !stopping) {
      if (await check()) return
      await delay(250)
    }
    throw new Error('Tempo esgotado ao iniciar a tela gráfica.')
  }

  function portReady(port) {
    return new Promise(resolve => {
      const socket = createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => { socket.destroy(); resolve(true) })
      socket.once('error', () => resolve(false))
      socket.setTimeout(500, () => { socket.destroy(); resolve(false) })
    })
  }

  async function start() {
    child('Xvfb', 'Xvfb', [':99', '-screen', '0', '1366x768x24', '-nolisten', 'tcp', '-ac'])
    await until(() => existsSync('/tmp/.X11-unix/X99'), 20_000)
    child('x11vnc', 'x11vnc', ['-display', ':99', '-localhost', '-rfbport', '5900', '-forever', '-shared', '-nopw', '-noxdamage'])
    await until(() => portReady(5900), 20_000)
    child('noVNC', 'websockify', ['--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900'])
    await mkdir(PROFILE, { recursive: true, mode: 0o700 })
    if (!process.env.RAILWAY_VOLUME_MOUNT_PATH) console.warn('[browser-debug] Sem volume Railway detectado; o perfil pode ser perdido no redeploy. Monte /data para persistir.')
    context = await chromium.launchPersistentContext(PROFILE, {
      headless: false,
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      viewport: { width: 1366, height: 680 },
      acceptDownloads: false,
      args: ['--window-position=0,0', '--window-size=1366,768'],
      env: { ...process.env, DISPLAY: ':99' },
    })
    page = context.pages()[0] ?? await context.newPage()
    page.on('response', response => { if (response.request().isNavigationRequest() && response.frame() === page.mainFrame()) navigationStatus = response.status() })
    console.log('[browser-debug] Navegador gráfico iniciado. Abra /internal/browser/ com usuário favareto e a senha configurada para o diagnóstico.')
    await page.goto(LISTING, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(error => {
      console.warn(`[browser-debug] Navegação inicial: ${error.message}. A janela permanece aberta para conferência.`)
    })
  }

  function authorized(req) {
    const actual = Buffer.from(String(req.headers['x-browser-control-key'] ?? ''))
    return actual.length === expectedKey.length && timingSafeEqual(actual, expectedKey)
  }

  async function readBody(req) {
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.length
      if (size > 16_384) throw new Error('Consulta grande demais.')
      chunks.push(chunk)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  }

  function send(res, status, value) {
    if (res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }

  function activeLease() {
    if (lease && lease.expiresAt < Date.now()) lease = null
    return lease
  }

  const server = createServer(async (req, res) => {
    let pendingLease = null
    try {
      if (req.method === 'GET' && req.url === '/status') {
        const current = page && !page.isClosed()
        const url = current ? new URL(page.url()) : null
        return send(res, 200, { enabled: true, browserReady: Boolean(current), url: url ? `${url.origin}${url.pathname}` : null, title: current ? await page.title() : null, navigationStatus, busy: Boolean(activeLease()), profilePath: PROFILE, error: startupError })
      }
      if (req.method !== 'POST' || !authorized(req)) return send(res, 403, { error: 'Consulta não autorizada.' })
      const body = await readBody(req)
      if (!page || page.isClosed()) return send(res, 503, { error: startupError ?? 'Navegador gráfico iniciando. Consulte /internal/browser/status.' })
      if (req.url === '/session') {
        if (activeLease()) return send(res, 409, { error: 'O navegador gráfico já está executando uma coleta Favareto.' })
        const current = { id: randomUUID(), expiresAt: Date.now() + 7 * 60_000 }
        lease = current
        pendingLease = current
        res.once('close', () => { if (!res.writableFinished && lease === current) lease = null })
        const end = Date.now() + 120_000
        while (Date.now() < end && !res.destroyed && !stopping) {
          // Não automatiza o desafio: o operador usa a janela remota da mesma sessão.
          if (!/just a moment|um momento|attention required|checking your browser/i.test(await page.title()) && await page.locator('a[href*="edital/"]').count() > 0) {
            send(res, 200, { session: current.id })
            if (!res.destroyed) pendingLease = null
            return
          }
          await delay(500)
        }
        if (lease === current) lease = null
        return send(res, 409, { error: 'Catálogo não liberado no navegador gráfico. Abra /internal/browser/ e conclua a verificação manual antes de repetir a coleta.' })
      }
      if (!activeLease() || body.session !== lease.id) return send(res, 409, { error: 'Sessão de coleta ausente ou expirada.' })
      if (req.url === '/release') { lease = null; return send(res, 200, { ok: true }) }
      if (req.url !== '/request') return send(res, 404, { error: 'Consulta desconhecida.' })
      const request = validateFavaretoDebugRequest(body)
      lease.expiresAt = Date.now() + 7 * 60_000
      const result = await page.evaluate(async ({ url, init }) => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 25_000)
        try {
          const response = await fetch(url, { method: init.method, body: init.body, headers: init.headers, credentials: 'include', cache: 'no-store', signal: controller.signal })
          return { status: response.status, body: new TextDecoder(init.charset).decode(await response.arrayBuffer()) }
        } finally { clearTimeout(timer) }
      }, request)
      send(res, 200, result)
    } catch (error) {
      send(res, 502, { error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (pendingLease && lease === pendingLease) lease = null
    }
  })

  server.listen(6081, '127.0.0.1')
  void start().catch(error => { startupError = error.message; console.error(`[browser-debug] ${startupError}`); void stop(1) })

  async function stop(code) {
    if (stopping) return
    stopping = true
    server.close()
    const timeout = setTimeout(() => process.exit(code), 5_000)
    await context?.close().catch(() => undefined)
    for (const processChild of children) processChild.kill('SIGTERM')
    clearTimeout(timeout)
    process.exit(code)
  }

  process.on('SIGTERM', () => { void stop(0) })
  process.on('SIGINT', () => { void stop(0) })
}
