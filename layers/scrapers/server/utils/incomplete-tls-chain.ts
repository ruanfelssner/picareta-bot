import { X509Certificate } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { connect, rootCertificates } from 'node:tls'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'

// Some auction portals (e.g. Freitas) omit the intermediate certificate. Browsers
// and curl complete the chain via AIA; Node's fetch fails with "fetch failed".
// Kept in sync with picareta/server/utils/incompleteTlsChain.ts.
const INCOMPLETE_CHAIN_CODES = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'])
const MAX_AIA_DEPTH = 3
const MAX_REDIRECTS = 5
const issuerCache = new Map<string, Promise<string[]>>()

export interface IntermediateTlsResponse { status: number; headers: Record<string, string>; body: Buffer }

export function isIncompleteTlsChainError(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 4; depth++) {
    if (typeof current === 'object' && 'code' in current && INCOMPLETE_CHAIN_CODES.has(String(current.code))) return true
    current = typeof current === 'object' && 'cause' in current ? current.cause : null
  }
  return false
}

function caIssuersUrl(certificate: X509Certificate): string | null {
  const url = certificate.infoAccess?.match(/CA Issuers - URI:(\S+)/)?.[1]
  return url && /^https?:\/\//i.test(url) ? url : null
}

function leafCertificate(hostname: string, port: number): Promise<X509Certificate> {
  return new Promise((resolve, reject) => {
    // Only reads the presented leaf to discover its AIA; no request is sent on this socket.
    const socket = connect({ host: hostname, port, servername: hostname, rejectUnauthorized: false, timeout: 15_000 }, () => {
      const raw = socket.getPeerCertificate().raw
      socket.end()
      if (raw) resolve(new X509Certificate(raw))
      else reject(new Error(`Certificado TLS de ${hostname} indisponível.`))
    })
    socket.once('timeout', () => socket.destroy(new Error(`Tempo excedido ao ler o certificado de ${hostname}.`)))
    socket.once('error', reject)
  })
}

async function downloadIssuers(hostname: string, port: number): Promise<string[]> {
  const pems: string[] = []
  let current = await leafCertificate(hostname, port)
  for (let depth = 0; depth < MAX_AIA_DEPTH; depth++) {
    const url = caIssuersUrl(current)
    if (!url) break
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status} ao baixar certificado intermediário de ${hostname}.`)
    const issuer = new X509Certificate(Buffer.from(await response.arrayBuffer()))
    // Never trust a self-signed certificate from AIA: only intermediates that
    // still have to chain up to Node's bundled roots are added.
    if (!issuer.ca || issuer.checkIssued(issuer) || !current.checkIssued(issuer) || !current.verify(issuer.publicKey)) break
    pems.push(issuer.toString())
    current = issuer
  }
  if (!pems.length) throw new Error(`Cadeia TLS incompleta em ${hostname} sem intermediário recuperável.`)
  return pems
}

function issuersFor(hostname: string, port: number): Promise<string[]> {
  const key = `${hostname}:${port}`
  let pending = issuerCache.get(key)
  if (!pending) {
    pending = downloadIssuers(hostname, port)
    pending.catch(() => issuerCache.delete(key))
    issuerCache.set(key, pending)
  }
  return pending
}

function decode(body: Buffer, encoding: string | undefined): Promise<Buffer> {
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'br' ? createBrotliDecompress() : encoding === 'deflate' ? createInflate() : null
  if (!decoder) return Promise.resolve(body)
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    decoder.on('data', (chunk: Buffer) => chunks.push(chunk))
    decoder.once('end', () => resolve(Buffer.concat(chunks)))
    decoder.once('error', reject)
    decoder.end(body)
  })
}

/** HTTPS request that keeps full certificate verification, adding only AIA intermediates for the host. */
export async function requestWithIntermediates(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal } = {},
): Promise<IntermediateTlsResponse> {
  let target = new URL(url), method = init.method ?? 'GET', body = init.body
  for (let redirects = 0; ; redirects++) {
    if (target.protocol !== 'https:') throw new Error(`Redirecionamento inseguro para ${target.href}.`)
    const port = Number(target.port || 443)
    const ca = [...rootCertificates, ...await issuersFor(target.hostname, port)]
    const response = await new Promise<IntermediateTlsResponse>((resolve, reject) => {
      const request = httpsRequest(target, {
        method, ca, servername: target.hostname, signal: init.signal,
        headers: { ...init.headers, ...(body != null ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
      }, (incoming) => {
        const chunks: Buffer[] = []
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk))
        incoming.once('error', reject)
        incoming.once('end', () => {
          const headers = Object.fromEntries(Object.entries(incoming.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : String(value ?? '')]))
          decode(Buffer.concat(chunks), headers['content-encoding']?.toLowerCase())
            .then(decoded => resolve({ status: incoming.statusCode ?? 0, headers, body: decoded }), reject)
        })
      })
      request.once('error', reject)
      request.end(body)
    })
    const location = response.headers.location
    if (![301, 302, 303, 307, 308].includes(response.status) || !location) return response
    if (redirects >= MAX_REDIRECTS) throw new Error(`Redirecionamentos demais em ${url}.`)
    target = new URL(location, target)
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) { method = 'GET'; body = undefined }
  }
}
