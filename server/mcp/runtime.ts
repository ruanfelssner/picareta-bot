/** Erro com mensagem segura para o usuário final (aparece no ChatGPT). Outros erros viram mensagem genérica. */
export class McpToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpToolError'
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new McpToolError(`${label}: tempo limite de ${Math.round(ms / 1000)} s excedido.`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  }
  finally {
    clearTimeout(timer)
  }
}

export class HttpStatusError extends Error {
  constructor(readonly status: number, readonly body: string, label: string) {
    super(`${label}: HTTP ${status}`)
  }
}

/** GET/POST JSON com timeout; corpo do erro truncado para log (nunca devolvido ao usuário). */
export async function fetchJson<T>(url: string, init: RequestInit & { timeoutMs: number, label: string }): Promise<T> {
  const { timeoutMs, label, ...requestInit } = init
  let response: Response
  try {
    response = await fetch(url, { ...requestInit, signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new McpToolError(`${label}: tempo limite de ${Math.round(timeoutMs / 1000)} s excedido.`)
    }
    throw new McpToolError(`${label}: falha de rede (${error instanceof Error ? error.message : String(error)}).`)
  }
  const text = await response.text()
  if (!response.ok) throw new HttpStatusError(response.status, text.slice(0, 300), label)
  try {
    return JSON.parse(text) as T
  }
  catch {
    throw new McpToolError(`${label}: resposta inválida da origem.`)
  }
}

export function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value == null || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
