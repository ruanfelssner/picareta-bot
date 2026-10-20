import { chromium } from 'playwright'
import { setTimeout as delay } from 'node:timers/promises'
import { load } from 'cheerio'
import { buildPlaywrightLaunchOptions } from './playwright-launch'

export const FREITAS_ORIGIN = 'https://www.freitasleiloeiro.com.br'
export const FREITAS_LIST_URL = `${FREITAS_ORIGIN}/Leiloes/Pesquisar?Categoria=1&TipoLoteId=1`
export const FREITAS_TIMEOUT_MS = 30 * 60 * 1000
const REQUEST_INTERVAL_MS = 1000
const REQUEST_TIMEOUT_MS = 25_000
const READ_PATHS = new Set([
  '/Leiloes/Pesquisar', '/Leiloes/PesquisarLotes', '/Leiloes/LoteDetalhes',
  '/Leiloes/ListarFotosLote', '/Leiloes/RetornarMaiorLanceLote', '/Leiloes/RetornarLoteStatus',
])

// Compartilhado entre sessões do processo para não multiplicar a carga no portal.
let queue: Promise<void> = Promise.resolve()
let nextRequestAt = 0
function schedule<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const result = queue.catch(() => undefined).then(async () => {
    signal?.throwIfAborted()
    const remaining = nextRequestAt - Date.now()
    if (remaining > 0) await delay(remaining, undefined, { signal })
    signal?.throwIfAborted()
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS
    return run()
  })
  queue = result.then(() => undefined, () => undefined)
  return result
}

export function assertFreitasReadUrl(value: string): URL {
  const url = new URL(value)
  if (url.origin !== FREITAS_ORIGIN || url.username || url.password || !READ_PATHS.has(url.pathname)) {
    throw new Error('[freitas] Consulta fora dos endpoints públicos de leitura permitidos.')
  }
  return url
}

export function assertFreitasBrowserResponse(status: number, body: string, url: string): void {
  const blocked = /Acesso bloqueado|access denied|Radware Captcha|captcha\.perfdrive|cf-chl-|g-recaptcha\s+(?:class|data-)/i.test(body)
  if (status >= 200 && status <= 299 && !blocked) return
  const text = load(body).text().replace(/\s+/g, ' ')
  const requestId = text.match(/ID da requisição:\s*([a-z0-9-]{8,80})/i)?.[1]
  const protection = /gocache/i.test(body) ? 'GoCache' : 'o portal'
  const detail = status === 403 || blocked
    ? ` ${protection} bloqueou a sessão${requestId ? ` (requisição ${requestId})` : ''}. Se persistir no servidor, solicite ao Freitas a liberação do IP de saída; a coleta foi interrompida sem contornar o bloqueio.`
    : ''
  throw new Error(`[freitas] HTTP ${status} em ${url}.${detail}`)
}

export type FreitasRequest = (_url: string, _options: { signal?: AbortSignal; referer?: string }) => Promise<string>
export type FreitasSession = { request: FreitasRequest; close: () => Promise<void> }

/** Sessão anônima e efêmera: TLS, cookies e consultas executados pelo Chromium real. */
export async function openFreitasSession(options: { headless?: boolean; signal?: AbortSignal } = {}): Promise<FreitasSession> {
  options.signal?.throwIfAborted()
  const browser = await chromium.launch(buildPlaywrightLaunchOptions(options.headless ?? true))
  let closed = false
  let accessFailure: Error | null = null
  const abort = () => { void close().catch(() => undefined) }
  async function close() {
    if (closed) return
    closed = true
    options.signal?.removeEventListener('abort', abort)
    await browser.close()
  }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    options.signal?.throwIfAborted()
    const context = await browser.newContext({ locale: 'pt-BR', serviceWorkers: 'block' })
    const page = await context.newPage()
    // Não executa scripts do portal, tracking, visitas, login, propostas ou downloads.
    await page.route('**/*', route => {
      const request = route.request()
      try {
        assertFreitasReadUrl(request.url())
        if (request.method() === 'GET' && ['document', 'fetch', 'xhr'].includes(request.resourceType())) return route.continue()
      } catch { /* Fora do escopo de leitura. */ }
      return route.abort()
    })
    await schedule(async () => {
      options.signal?.throwIfAborted()
      const response = await page.goto(FREITAS_LIST_URL, { waitUntil: 'domcontentloaded', timeout: REQUEST_TIMEOUT_MS })
      if (!response) throw new Error('[freitas] Não foi possível abrir a sessão pública do portal.')
      assertFreitasBrowserResponse(response.status(), await response.text(), FREITAS_LIST_URL)
    }, options.signal)
    return {
      close,
      request: async (url, requestOptions) => {
        assertFreitasReadUrl(url)
        if (requestOptions.referer) assertFreitasReadUrl(requestOptions.referer)
        return schedule(async () => {
          options.signal?.throwIfAborted()
          requestOptions.signal?.throwIfAborted()
          if (accessFailure) throw accessFailure
          if (closed) throw new Error('[freitas] Sessão pública encerrada.')
          const response = await page.evaluate(async ({ url, referer, timeoutMs }) => {
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), timeoutMs)
            try {
              const ajax = !['/Leiloes/Pesquisar', '/Leiloes/LoteDetalhes'].includes(new URL(url).pathname)
              const response = await fetch(url, {
                method: 'GET', mode: 'same-origin', credentials: 'same-origin', cache: 'no-store',
                referrer: referer, headers: ajax ? { 'X-Requested-With': 'XMLHttpRequest' } : {},
                signal: controller.signal,
              })
              return { status: response.status, body: await response.text() }
            } finally { clearTimeout(timer) }
          }, { url, referer: requestOptions.referer ?? FREITAS_LIST_URL, timeoutMs: REQUEST_TIMEOUT_MS })
          options.signal?.throwIfAborted()
          requestOptions.signal?.throwIfAborted()
          try { assertFreitasBrowserResponse(response.status, response.body, url) }
          catch (error) {
            if ([401, 403, 429].includes(response.status) || /bloque/i.test(String(error))) accessFailure = error as Error
            throw error
          }
          return response.body
        }, requestOptions.signal ?? options.signal)
      },
    }
  } catch (error) {
    await close()
    options.signal?.throwIfAborted()
    throw error
  }
}
