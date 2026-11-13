import { setTimeout as delay } from 'node:timers/promises'
import type { AuctionVehicle } from '../../../../src/formatters/auction-card'

/**
 * Saída auxiliar para fontes que falham no Docker (Railway): a coleta é repassada ao
 * `pnpm worker` da máquina local (rede residencial) e o resultado volta pelo Mongo,
 * para o próprio serviço cloud ingerir no mesmo run do Picareta.
 */
export const LOCAL_FALLBACK_LIMITS = {
  /** Heartbeat do worker mais antigo que isso = worker offline (o worker grava a cada 20 s). */
  workerOnlineMs: 2 * 60_000,
  pollMs: 10_000,
  /** O job em execução é tocado pelo worker a cada 15 s; sem toque por 3 min = worker travou/caiu. */
  jobHeartbeatMs: 3 * 60_000,
  /** VIP pode levar 2 × 15 min de tentativas; acima disso a coleta é abandonada. */
  runMs: 60 * 60_000,
  /** O worker processa um job por vez; fila longa (várias fontes) ainda precisa de um teto. */
  queueMs: 2 * 60 * 60_000,
} as const

export type LocalFallbackJobStatus = 'queued' | 'running' | 'completed' | 'failed'

export type LocalFallbackJobView = {
  id: string
  status: LocalFallbackJobStatus
  workerId: string | null
  message: string | null
  error: string | null
  complete: boolean
  createdAt: Date
  claimedAt: Date | null
  heartbeatAt: Date | null
}

export type LocalFallbackInput = {
  runId: string
  source: AuctionVehicle['source']
  label: string
  cloudError: string
}

export interface LocalFallbackStore {
  onlineWorker(now: Date): Promise<string | null>
  enqueue(input: LocalFallbackInput): Promise<string>
  get(id: string): Promise<LocalFallbackJobView | null>
  /** Marca como falha somente se ainda estiver na fila/executando; false = o worker terminou antes. */
  abandon(id: string, reason: string): Promise<boolean>
  readVehicles(id: string): Promise<AuctionVehicle[]>
  cleanup(id: string): Promise<void>
}

export type LocalFallbackOutcome =
  | { status: 'skipped'; reason: string }
  | {
      status: 'completed' | 'failed'
      jobId: string
      workerId: string | null
      vehicles: AuctionVehicle[]
      complete: boolean
      error: string | null
    }

export type LocalFallbackHooks = {
  onQueued?: (workerId: string) => void
  onClaimed?: (workerId: string) => void
  onMessage?: (message: string) => void
}

/** Falha de ingestão no Picareta não é bloqueio de rede: repetir a coleta localmente não ajuda. */
export function shouldDelegateToLocal(error: string | undefined): boolean {
  return !/^Falha ao salvar /.test(error ?? '')
}

export async function runLocalFallback(
  store: LocalFallbackStore,
  input: LocalFallbackInput,
  hooks: LocalFallbackHooks = {},
  deps: { sleep?: (ms: number) => Promise<void>; now?: () => Date } = {},
): Promise<LocalFallbackOutcome> {
  const sleep = deps.sleep ?? (ms => delay(ms))
  const now = deps.now ?? (() => new Date())
  const limits = LOCAL_FALLBACK_LIMITS

  const workerId = await store.onlineWorker(now())
  if (!workerId) return { status: 'skipped', reason: 'nenhum worker local online' }

  const jobId = await store.enqueue(input)
  hooks.onQueued?.(workerId)

  let lastMessage: string | null = null
  let claimed = false
  const fail = (error: string, job?: LocalFallbackJobView | null): LocalFallbackOutcome => ({
    status: 'failed', jobId, workerId: job?.workerId ?? null, vehicles: [], complete: false, error,
  })

  for (;;) {
    await sleep(limits.pollMs)
    const job = await store.get(jobId)
    if (!job) return fail('job local removido antes da conclusão')

    if (job.status === 'completed' || job.status === 'failed') {
      const vehicles = await store.readVehicles(jobId)
      const complete = job.status === 'completed' && job.complete
      return {
        status: complete ? 'completed' : 'failed',
        jobId,
        workerId: job.workerId,
        vehicles,
        complete,
        error: complete ? null : job.error ?? 'coleta local incompleta',
      }
    }

    const at = now().getTime()
    let abandonReason: string | null = null
    if (job.status === 'queued') {
      if (at - job.createdAt.getTime() > limits.queueMs) abandonReason = 'worker local não assumiu a coleta em 2 h'
      else if (!(await store.onlineWorker(now()))) abandonReason = 'worker local ficou offline antes de assumir a coleta'
    } else {
      if (!claimed && job.workerId) {
        claimed = true
        hooks.onClaimed?.(job.workerId)
      }
      const lastTouch = (job.heartbeatAt ?? job.claimedAt ?? job.createdAt).getTime()
      if (at - lastTouch > limits.jobHeartbeatMs) abandonReason = 'worker local parou de responder durante a coleta'
      else if (job.claimedAt && at - job.claimedAt.getTime() > limits.runMs) abandonReason = 'coleta local excedeu 60 min'
    }

    if (abandonReason) {
      // false = o worker concluiu entre a leitura e o abandono; a próxima volta lê o resultado.
      if (await store.abandon(jobId, abandonReason)) return fail(abandonReason, job)
      continue
    }

    if (job.message && job.message !== lastMessage) {
      lastMessage = job.message
      hooks.onMessage?.(job.message)
    }
  }
}
