import { timingSafeEqual } from 'node:crypto'
import { request as httpRequest } from 'node:http'

const PREFIX = '/internal/browser'
const LOGIN = 'favareto'

export function browserDebugPassword(key) {
  return key?.trim() || 'favareto-debug'
}

export function browserDebugEnabled(env = process.env) {
  return env.FAVARETO_BROWSER_DEBUG === '1'
}

export function createBrowserDebugGateway({ enabled, key, webPort = 6080, controlPort = 6081 }) {
  const expected = Buffer.from(`${LOGIN}:${browserDebugPassword(key)}`)
  const owns = req => req.url?.split('?')[0] === PREFIX || req.url?.startsWith(`${PREFIX}/`)
  const authorized = req => {
    const match = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization ?? '')
    if (!match) return false
    const actual = Buffer.from(match[1], 'base64')
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }
  const target = req => {
    const suffix = req.url.slice(PREFIX.length) || '/'
    return suffix === '/status'
      ? { path: '/status', port: controlPort }
      : { path: suffix, port: webPort }
  }
  const upstreamHeaders = req => {
    // A chave autentica somente o gateway; não encaminhar credenciais ao noVNC.
    const { authorization, cookie, ...headers } = req.headers
    return { ...headers, host: '127.0.0.1' }
  }

  return {
    handle(req, res) {
      if (!owns(req)) return false
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Referrer-Policy', 'no-referrer')
      if (!enabled) { res.writeHead(404); res.end(); return true }
      if (!authorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Diagnostico Favareto", charset="UTF-8"' })
        res.end('Acesso restrito ao operador do bot.')
        return true
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return true
      }
      if ([PREFIX, `${PREFIX}/`].includes(req.url)) {
        res.writeHead(302, { Location: `${PREFIX}/vnc.html?autoconnect=1&resize=scale&path=internal/browser/websockify` })
        res.end(); return true
      }
      const upstream = httpRequest({ hostname: '127.0.0.1', ...target(req), method: req.method, headers: upstreamHeaders(req) }, response => {
        const { 'set-cookie': ignored, ...headers } = response.headers
        res.writeHead(response.statusCode ?? 502, { ...headers, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
        response.pipe(res)
      })
      upstream.on('error', () => {
        if (res.headersSent) return res.destroy()
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Navegador de diagnóstico iniciando ou indisponível. Consulte os logs do serviço.')
      })
      req.on('aborted', () => upstream.destroy())
      res.on('close', () => upstream.destroy())
      upstream.end()
      return true
    },
    upgrade(req, socket, head) {
      if (!owns(req)) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return }
      if (!enabled || req.url?.split('?')[0] !== `${PREFIX}/websockify`) {
        socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return
      }
      if (!authorized(req)) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="Diagnostico Favareto"\r\nConnection: close\r\n\r\n'); return
      }
      // A interface e o WebSocket devem vir do mesmo domínio público.
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== req.headers.host) throw new Error('Origem diferente')
        } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
      }
      const upstream = httpRequest({ hostname: '127.0.0.1', ...target(req), headers: upstreamHeaders(req) })
      upstream.on('upgrade', (response, remote, remoteHead) => {
        socket.write(`HTTP/1.1 101 Switching Protocols\r\n${response.rawHeaders.reduce((lines, value, i, values) => i % 2 ? lines : `${lines}${value}: ${values[i + 1]}\r\n`, '')}\r\n`)
        if (remoteHead.length) socket.write(remoteHead)
        if (head.length) remote.write(head)
        socket.pipe(remote).pipe(socket)
        socket.on('close', () => remote.destroy())
        remote.on('close', () => socket.destroy())
        remote.on('error', () => socket.destroy())
      })
      upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n') })
      upstream.on('error', () => socket.destroy())
      socket.on('error', () => upstream.destroy())
      upstream.end()
    },
  }
}
