import assert from 'node:assert/strict'
import test from 'node:test'
import {
  LOCAL_FALLBACK_LIMITS,
  runLocalFallback,
  shouldDelegateToLocal,
  type LocalFallbackJobView,
  type LocalFallbackStore,
} from '../layers/scrapers/server/utils/local-fallback-coordinator'
import type { AuctionVehicle } from '../src/formatters/auction-card'

const car = (index: number) => ({ source: 'vipleiloes', brand: 'VW', model: 'Polo', year: 2022, damage: null, price: 30000, priceRaw: null, imageUrls: [], description: 'Veículo', url: `https://vip.test/${index}`, auctionDate: null }) satisfies AuctionVehicle
const input = { runId: 'run-12345678', source: 'vipleiloes' as const, label: 'VIP Leilões', cloudError: 'Cloudflare' }

/** Fila em memória com relógio simulado: cada poll avança o tempo e chama `tick` (o "worker"). */
function harness(options: { online?: (at: number) => boolean; tick?: (job: LocalFallbackJobView, at: number) => void; vehicles?: AuctionVehicle[] } = {}) {
  let clock = Date.parse('2026-11-13T12:00:00Z')
  const jobs = new Map<string, LocalFallbackJobView>()
  const calls = { enqueue: 0, abandon: 0, cleanup: 0 }
  const store: LocalFallbackStore = {
    async onlineWorker() { return (options.online ?? (() => true))(clock) ? 'bot-anuncios@PC' : null },
    async enqueue() {
      calls.enqueue++
      const id = `job-${calls.enqueue}`
      jobs.set(id, { id, status: 'queued', workerId: null, message: null, error: null, complete: false, createdAt: new Date(clock), claimedAt: null, heartbeatAt: null })
      return id
    },
    async get(id) { return jobs.get(id) ?? null },
    async abandon(id, reason) {
      calls.abandon++
      const job = jobs.get(id)
      if (!job || (job.status !== 'queued' && job.status !== 'running')) return false
      Object.assign(job, { status: 'failed', error: reason })
      return true
    },
    async readVehicles() { return options.vehicles ?? [] },
    async cleanup() { calls.cleanup++ },
  }
  const sleep = async (ms: number) => {
    clock += ms
    for (const job of jobs.values()) options.tick?.(job, clock)
  }
  return { store, calls, jobs, deps: { sleep, now: () => new Date(clock) } }
}

test('sem worker local online a fonte continua com a falha do Docker e nada é enfileirado', async () => {
  const { store, calls, deps } = harness({ online: () => false })
  const outcome = await runLocalFallback(store, input, {}, deps)
  assert.deepEqual(outcome, { status: 'skipped', reason: 'nenhum worker local online' })
  assert.equal(calls.enqueue, 0)
})

test('worker assume, informa progresso e devolve coleta completa', async () => {
  const events: string[] = []
  let polls = 0
  const { store, deps } = harness({
    vehicles: [car(1), car(2)],
    tick(job, at) {
      polls++
      if (polls === 1) Object.assign(job, { status: 'running', workerId: 'bot-anuncios@PC', claimedAt: new Date(at), heartbeatAt: new Date(at), message: 'Página 1' })
      if (polls === 2) Object.assign(job, { message: 'Página 2', heartbeatAt: new Date(at) })
      if (polls === 3) Object.assign(job, { status: 'completed', complete: true })
    },
  })
  const outcome = await runLocalFallback(store, input, {
    onQueued: id => events.push(`queued:${id}`),
    onClaimed: id => events.push(`claimed:${id}`),
    onMessage: message => events.push(message),
  }, deps)
  assert.equal(outcome.status, 'completed')
  assert.ok(outcome.status !== 'skipped')
  assert.equal(outcome.complete, true)
  assert.equal(outcome.vehicles.length, 2)
  assert.equal(outcome.error, null)
  assert.deepEqual(events, ['queued:bot-anuncios@PC', 'claimed:bot-anuncios@PC', 'Página 1', 'Página 2'])
})

test('falha também no worker local preserva o erro e os parciais', async () => {
  const { store, deps } = harness({
    vehicles: [car(1)],
    tick(job, at) { Object.assign(job, { status: 'failed', workerId: 'bot-anuncios@PC', claimedAt: new Date(at), error: 'CAPTCHA Radware' }) },
  })
  const outcome = await runLocalFallback(store, input, {}, deps)
  assert.ok(outcome.status === 'failed')
  assert.equal(outcome.complete, false)
  assert.equal(outcome.error, 'CAPTCHA Radware')
  assert.equal(outcome.vehicles.length, 1)
})

test('worker que sai do ar antes de assumir encerra a espera', async () => {
  const startedAt = Date.parse('2026-11-13T12:00:00Z')
  const { store, calls, jobs, deps } = harness({ online: at => at - startedAt < 30_000 })
  const outcome = await runLocalFallback(store, input, {}, deps)
  assert.ok(outcome.status === 'failed')
  assert.match(outcome.error ?? '', /offline antes de assumir/)
  assert.equal(calls.abandon, 1)
  assert.equal(jobs.get('job-1')?.status, 'failed')
})

test('job em execução sem heartbeat é abandonado', async () => {
  let claimed = false
  const { store, deps } = harness({
    tick(job, at) {
      if (claimed) return
      claimed = true
      Object.assign(job, { status: 'running', workerId: 'bot-anuncios@PC', claimedAt: new Date(at), heartbeatAt: new Date(at) })
    },
  })
  const outcome = await runLocalFallback(store, input, {}, deps)
  assert.ok(outcome.status === 'failed')
  assert.match(outcome.error ?? '', /parou de responder/)
})

test('conclusão concorrente ao abandono vence e o resultado é lido', async () => {
  let polls = 0
  const { store, deps } = harness({
    vehicles: [car(1)],
    tick(job, at) {
      polls++
      if (polls === 1) Object.assign(job, { status: 'running', workerId: 'bot-anuncios@PC', claimedAt: new Date(at), heartbeatAt: new Date(at) })
    },
  })
  const abandon = store.abandon.bind(store)
  // Simula o worker gravando "completed" no instante em que o cloud decide abandonar.
  store.abandon = async (id, reason) => {
    const job = await store.get(id)
    if (job) Object.assign(job, { status: 'completed', complete: true })
    return abandon(id, reason)
  }
  const outcome = await runLocalFallback(store, input, {}, deps)
  assert.equal(outcome.status, 'completed')
  assert.ok(outcome.status !== 'skipped')
  assert.equal(outcome.vehicles.length, 1)
  assert.ok(polls * LOCAL_FALLBACK_LIMITS.pollMs > LOCAL_FALLBACK_LIMITS.jobHeartbeatMs)
})

test('falha de ingestão no Picareta não é repassada ao worker local', () => {
  assert.equal(shouldDelegateToLocal('Falha ao salvar VIP Leilões: Picareta ingestão HTTP 500'), false)
  assert.equal(shouldDelegateToLocal('[vipleiloes] Bloqueio anti-bot persistente'), true)
  assert.equal(shouldDelegateToLocal(undefined), true)
})
