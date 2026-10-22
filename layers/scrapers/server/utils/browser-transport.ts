import { chromium } from 'playwright'
import { buildPlaywrightLaunchOptions } from './playwright-launch'

export type BrowserRequestInit = { method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string>; charset?: string }
export type BrowserResponse = { status: number; body: string }
export type BrowserTransport = {
  request: (_url: string, _init?: BrowserRequestInit) => Promise<BrowserResponse>
  close: () => Promise<void>
}

const NAVIGATION_TIMEOUT_MS = 30_000
const CHALLENGE_TIMEOUT_MS = 25_000
const REQUEST_TIMEOUT_MS = 25_000
const CHALLENGE_TITLE = /just a moment|um momento|attention required|checking your browser/i

/**
 * Chromium real para sites cujo WAF recusa ou esvazia respostas ao fetch do Node (fingerprint TLS/IP).
 * Abre `warmupUrl`, aguarda um eventual desafio JS concluir e executa as consultas como `fetch`
 * da própria página: mesma origem, cookies e TLS do navegador. Não executa login nem lances.
 */
export async function openBrowserTransport(options: { warmupUrl: string; headless?: boolean; signal?: AbortSignal; log?: (_message: string) => void }): Promise<BrowserTransport> {
  options.signal?.throwIfAborted()
  const browser = await chromium.launch(buildPlaywrightLaunchOptions(options.headless ?? true))
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    options.signal?.removeEventListener('abort', abort)
    await browser.close()
  }
  const abort = () => { void close().catch(() => undefined) }
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    // UA sem "HeadlessChrome", coerente com a plataforma do container.
    const major = browser.version().split('.')[0]
    const context = await browser.newContext({
      locale: 'pt-BR',
      timezoneId: 'America/Sao_Paulo',
      userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      viewport: { width: 1366, height: 768 },
    })
    // Scripts continuam liberados (desafios JS dependem deles); mídia pesada não é necessária.
    await context.route('**/*', route => ['image', 'media', 'font', 'stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue())
    const page = await context.newPage()
    const response = await page.goto(options.warmupUrl, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS })
    if (CHALLENGE_TITLE.test(await page.title())) {
      options.log?.(`[browser] Desafio anti-bot em ${options.warmupUrl}; aguardando o navegador concluir.`)
      await page.waitForFunction(() => !/just a moment|um momento|attention required|checking your browser/i.test(document.title), undefined, { timeout: CHALLENGE_TIMEOUT_MS })
        .catch(() => { throw new Error(`Desafio anti-bot não foi concluído pelo navegador em ${options.warmupUrl} (HTTP ${response?.status() ?? '?'}).`) })
    }
    else if (response && response.status() >= 400) {
      throw new Error(`HTTP ${response.status()} ao abrir ${options.warmupUrl} pelo navegador.`)
    }
    return {
      close,
      request: async (url, init = {}) => {
        options.signal?.throwIfAborted()
        if (closed) throw new Error('Navegador encerrado.')
        // Sem funções nomeadas aqui: o tsx injeta __name(), inexistente na página.
        return page.evaluate(async ({ url, init, timeoutMs }) => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), timeoutMs)
          try {
            const res = await fetch(url, { method: init.method ?? 'GET', body: init.body, headers: init.headers, credentials: 'include', cache: 'no-store', signal: controller.signal })
            return { status: res.status, body: new TextDecoder(init.charset ?? 'utf-8').decode(await res.arrayBuffer()) }
          }
          finally { clearTimeout(timer) }
        }, { url, init, timeoutMs: REQUEST_TIMEOUT_MS })
      },
    }
  }
  catch (error) {
    await close().catch(() => undefined)
    options.signal?.throwIfAborted()
    throw error
  }
}

/** Resumo curto de uma resposta para diagnosticar o que o servidor recebeu (tamanho e título). */
export function describeResponseBody(body: string): string {
  const title = body.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim()
  return `${body.length} bytes${title ? `, título "${title.slice(0, 80)}"` : ''}`
}
