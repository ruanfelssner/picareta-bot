import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { createHash, timingSafeEqual } from 'node:crypto'
import ts from 'typescript'

const file = 'layers/cars/server/api/internal/auction-daily-summary.post.ts'
const compiled = ts.transpileModule(readFileSync(resolve(file), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

function harness(options: { key?: string; expected?: string; body?: unknown; configured?: boolean; disabled?: boolean; status?: number; timeout?: boolean } = {}) {
  const requests: Array<{ url: string; init: RequestInit }> = []
  let reads = 0
  const exports = {} as { default: (_event: unknown) => Promise<{ accepted: boolean }> }
  const mocks: Record<string, unknown> = {
    'node:crypto': { createHash, timingSafeEqual },
    h3: {
      defineEventHandler: (handler: unknown) => handler,
      getRequestHeader: () => options.key ?? 'service-test-key',
      readBody: async () => { reads++; return options.body ?? { message: 'Resumo sem identificação', phone: 'destino-injetado' } },
      createError: (data: { message: string }) => Object.assign(new Error(data.message), data),
    },
    '../../utils/zapi': {
      getZApiConfig: () => ({ baseUrl: 'https://provider.test', instanceId: 'test-instance', token: 'test-token', clientToken: 'test-client', phone: 'grupo-configurado', delayMessage: 2 }),
      validateZApiConfig: () => options.configured === false ? 'não configurado' : null,
    },
  }
  vm.runInNewContext(compiled, {
    exports, require: (id: string) => { if (!(id in mocks)) throw new Error(`Import inesperado: ${id}`); return mocks[id] },
    ...mocks.h3 as Record<string, unknown>,
    process: { env: { SCRAPER_SERVICE_KEY: options.expected ?? 'service-test-key', ZAPI_ENABLED: options.disabled ? 'false' : 'true' } },
    AbortSignal,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      if (options.timeout) throw new Error('timeout')
      return new Response('{}', { status: options.status ?? 200 })
    },
  })
  return { run: () => exports.default({}), requests, reads: () => reads }
}

test('rejeita chave ausente ou inválida antes de ler corpo ou enviar WhatsApp', async () => {
  for (const options of [{ key: 'errada' }, { expected: '' }]) {
    const h = harness(options)
    await assert.rejects(h.run(), { statusCode: 401 })
    assert.equal(h.reads(), 0)
    assert.equal(h.requests.length, 0)
  }
})

test('valida texto e configuração sem iniciar envio', async () => {
  for (const body of [{}, { message: '' }, { message: 100 }, { message: 'a'.repeat(12_001) }]) {
    const h = harness({ body })
    await assert.rejects(h.run(), { statusCode: 400 })
    assert.equal(h.requests.length, 0)
  }
  for (const options of [{ configured: false }, { disabled: true }]) {
    const h = harness(options)
    await assert.rejects(h.run(), { statusCode: 503 })
    assert.equal(h.requests.length, 0)
  }
})

test('envia apenas texto ao grupo existente, ignora destino do corpo e respeita atraso/timeout', async () => {
  const h = harness()
  const result = await h.run()
  assert.equal(result.accepted, true)
  assert.equal(h.requests.length, 1)
  const { url, init } = h.requests[0]!
  assert.match(url, /\/send-text$/)
  const body = JSON.parse(String(init.body))
  assert.equal(body.phone, 'grupo-configurado')
  assert.equal(body.message, 'Resumo sem identificação')
  assert.equal(body.delayMessage, 2)
  assert.ok(init.signal)
})

test('recusa do provedor ou timeout são respostas incertas, sem repetição na rota', async () => {
  for (const options of [{ status: 503 }, { timeout: true }]) {
    const h = harness(options)
    await assert.rejects(h.run(), { statusCode: 502 })
    assert.equal(h.requests.length, 1)
  }
})
