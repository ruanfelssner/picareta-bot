import { spawn } from 'node:child_process'
import { createServer, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'

dotenv.config()

const publicPort = Number.parseInt(process.env.PORT ?? '4000', 10) || 4000
const publicHost = (process.env.HOST ?? '0.0.0.0').trim() || '0.0.0.0'
const nuxtPort = publicPort === 3101 ? 3102 : 3101
const scraperPort = publicPort === 4101 ? 4102 : 4101
const internalHost = '127.0.0.1'
const children = []
let shuttingDown = false

const nuxtEntry = fileURLToPath(new URL('../.output/server/index.mjs', import.meta.url))
const tsxEntry = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url))
const scraperEntry = fileURLToPath(new URL('../src/cloud-service.ts', import.meta.url))

children.push(startChild('nuxt', process.execPath, [nuxtEntry], {
  PORT: String(nuxtPort),
  HOST: internalHost,
  NITRO_PORT: String(nuxtPort),
  NITRO_HOST: internalHost,
  NODE_ENV: 'production',
  SCRAPER_INTERNAL_PORT: String(scraperPort),
}))
children.push(startChild('scraper', process.execPath, [tsxEntry, scraperEntry], {
  PORT: String(scraperPort),
  HOST: internalHost,
  NODE_ENV: 'production',
}))

const server = createServer((req, res) => {
  const pathname = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`).pathname
  const targetPort = pathname === '/health' || pathname.startsWith('/internal/scraping/')
    ? scraperPort
    : nuxtPort

  const upstream = httpRequest({
    hostname: internalHost,
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
    upstreamResponse.pipe(res)
  })

  upstream.on('error', (error) => {
    if (res.headersSent) {
      res.destroy(error)
      return
    }
    res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, message: 'Servico interno indisponivel.' }))
  })

  req.on('aborted', () => upstream.destroy())
  req.pipe(upstream)
})

server.listen(publicPort, publicHost, () => {
  console.log(`[combined] ouvindo em http://${publicHost}:${publicPort}`)
  console.log(`[combined] Nuxt interno em http://${internalHost}:${nuxtPort}`)
  console.log(`[combined] scraper interno em http://${internalHost}:${scraperPort}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal, 0))
}

function startChild(name, command, args, extraEnv) {
  const child = spawn(command, args, {
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    windowsHide: true,
  })

  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.error(`[combined] ${name} encerrou inesperadamente (code=${code}, signal=${signal}).`)
    shutdown('SIGTERM', code || 1)
  })

  return child
}

function shutdown(signal, exitCode) {
  if (shuttingDown) return
  shuttingDown = true
  server.close()
  for (const child of children) {
    if (!child.killed) child.kill(signal)
  }
  setTimeout(() => process.exit(exitCode), 5_000).unref()
}
