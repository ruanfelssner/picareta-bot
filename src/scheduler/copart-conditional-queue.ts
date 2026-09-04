import { randomUUID } from 'node:crypto'
import type { MongoConfig } from '../integrations/mongo.js'
import {
  createCopartConditionalJobs,
  createCopartConditionalRun,
  listPendingCopartConditionals,
  updateCopartConditionalRun,
  type CreateCopartConditionalJobInput,
} from '../integrations/mongo.js'
import type { CopartConditionalCheckTrigger } from '../../shared/types/copart-conditional-check.js'

const CONDITIONAL_CHECK_BATCH_LIMIT = 100

export type EnqueueCopartConditionalCheckOptions = {
  dataMongoConfig: MongoConfig
  trigger: CopartConditionalCheckTrigger
  runId?: string
  force?: boolean
  vehicleId?: string
  now?: Date
}

export type EnqueuedCopartConditionalCheck = {
  eligible: number
  queued: number
  runId: string
}

export async function enqueueCopartConditionalStatusCheck(
  options: EnqueueCopartConditionalCheckOptions,
): Promise<EnqueuedCopartConditionalCheck> {
  const now = options.now ?? new Date()
  const runId = options.runId ?? randomUUID()
  const candidates = await listPendingCopartConditionals(options.dataMongoConfig, now, {
    force: options.force,
    vehicleId: options.vehicleId,
    limit: CONDITIONAL_CHECK_BATCH_LIMIT,
  })
  const jobs: CreateCopartConditionalJobInput[] = candidates.map((candidate) => ({
    jobId: `${runId}:${String(candidate._id)}`,
    runId,
    vehicleId: String(candidate._id),
    url: candidate.url,
    lot: candidate.lot ?? null,
    originalAuctionDate: candidate.conditionalOriginalAuctionDate ?? candidate.auctionDate ?? null,
    status: 'queued',
    workerId: null,
    attempts: 0,
    availableAt: now,
    claimedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  }))

  await createCopartConditionalRun(options.dataMongoConfig, {
    runId,
    trigger: options.trigger,
    status: 'running',
    total: candidates.length,
    processed: 0,
    approved: 0,
    refused: 0,
    pending: 0,
    removed: 0,
    errors: 0,
    startedAt: now,
    finishedAt: null,
    error: null,
    logs: [],
  })
  const queued = await createCopartConditionalJobs(options.dataMongoConfig, jobs)

  if (candidates.length === 0) {
    await updateCopartConditionalRun(options.dataMongoConfig, runId, {
      status: 'completed',
      finishedAt: new Date(),
    })
  }

  return { eligible: candidates.length, queued, runId }
}
