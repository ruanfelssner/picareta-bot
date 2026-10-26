import type { BrowserTransport, openBrowserTransport } from './browser-transport.js'

const CONTROL = 'http://127.0.0.1:6081'

/** Sessão gráfica mantida no mesmo container; close libera o uso, sem apagar o perfil. */
export const openFavaretoDebugTransport: typeof openBrowserTransport = async (options): Promise<BrowserTransport> => {
  const key = process.env.FAVARETO_BROWSER_CONTROL_KEY?.trim()
  if (!key) throw new Error('Canal interno gráfico ausente. Inicie o diagnóstico pelo comando start:combined.')
  options.signal?.throwIfAborted()
  const controller = new AbortController()
  const cancel = () => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', cancel, { once: true })
  const headers = { 'Content-Type': 'application/json', 'x-browser-control-key': key }
  let session: string | null = null

  const call = async (path: string, body: unknown, timeoutMs: number): Promise<unknown> => {
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(`${CONTROL}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal })
      const data: unknown = await res.json()
      if (!res.ok) {
        const message = data && typeof data === 'object' && 'error' in data ? String(data.error) : `HTTP ${res.status}`
        throw new Error(message)
      }
      return data
    } finally { clearTimeout(timeout) }
  }

  const close = async () => {
    options.signal?.removeEventListener('abort', cancel)
    controller.abort()
    if (!session) return
    const id = session
    session = null
    await fetch(`${CONTROL}/release`, { method: 'POST', headers, body: JSON.stringify({ session: id }), signal: AbortSignal.timeout(5_000) }).catch(() => undefined)
  }

  try {
    options.log?.('[favareto] Usando navegador gráfico do container. Se necessário, abra /internal/browser/ e conclua a verificação manual.')
    const result = await call('/session', {}, 135_000)
    if (!result || typeof result !== 'object' || !('session' in result) || typeof result.session !== 'string') throw new Error('Sessão gráfica não reconhecida.')
    session = result.session
    return {
      close,
      request: async (url, init = {}) => {
        const data = await call('/request', { session, url, init }, 30_000)
        if (!data || typeof data !== 'object' || !('status' in data) || typeof data.status !== 'number' || !('body' in data) || typeof data.body !== 'string') throw new Error('Resposta gráfica não reconhecida.')
        return { status: data.status, body: data.body }
      },
    }
  } catch (error) {
    await close()
    throw error
  }
}
