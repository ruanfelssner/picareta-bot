import { Types } from 'mongoose'
import type {
  CopartConditionalJob,
  CopartConditionalJobResult,
} from '#shared/types/copart-conditional-job'

type JobDocument = Omit<CopartConditionalJob, 'originalAuctionDate' | 'availableAt' | 'claimedAt' | 'finishedAt'> & {
  _id: Types.ObjectId
  originalAuctionDate: Date | null
  availableAt: Date
  claimedAt: Date | null
  finishedAt: Date | null
}

function jobsCollection() {
  const connection = useDb()
  if (!connection.db) throw new Error('Banco de dados ainda não está conectado.')
  return connection.db.collection<JobDocument>('copart_conditional_jobs')
}

function iso(value: Date | null): string | null {
  return value && !Number.isNaN(value.getTime()) ? value.toISOString() : null
}

function dateOrNull(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toJob(document: JobDocument): CopartConditionalJob {
  return {
    jobId: document.jobId,
    runId: document.runId,
    vehicleId: document.vehicleId,
    url: document.url,
    lot: document.lot ?? null,
    originalAuctionDate: iso(document.originalAuctionDate),
    status: document.status,
    workerId: document.workerId ?? null,
    attempts: Math.max(0, Math.round(document.attempts ?? 0)),
    availableAt: iso(document.availableAt) ?? new Date(0).toISOString(),
    claimedAt: iso(document.claimedAt),
    finishedAt: iso(document.finishedAt),
    result: document.result ?? null,
    error: document.error ?? null,
  }
}

export async function claimCopartConditionalJob(workerId: string, options: { recover?: boolean } = {}): Promise<CopartConditionalJob | null> {
  const normalizedWorkerId = workerId.trim()
  if (!normalizedWorkerId) return null

  const now = new Date()
  const collection = jobsCollection()
  const document = await collection.findOneAndUpdate(
    {
      $or: [
        { status: 'queued', availableAt: { $lte: now } },
        options.recover === true
          ? { status: 'claimed' }
          : { status: 'claimed', claimedAt: { $lte: new Date(now.getTime() - 10 * 60 * 1000) } },
      ],
    },
    {
      $set: { status: 'claimed', workerId: normalizedWorkerId, claimedAt: now },
      $inc: { attempts: 1 },
    },
    { sort: { availableAt: 1, _id: 1 }, returnDocument: 'after' },
  )
  return document ? toJob(document) : null
}

export async function completeCopartConditionalJob(
  jobId: string,
  workerId: string,
  result: CopartConditionalJobResult,
): Promise<{ job: CopartConditionalJob; finishedRun: boolean }> {
  const collection = jobsCollection()
  const now = new Date()
  const job = await collection.findOneAndUpdate(
    { jobId: jobId.trim(), status: 'claimed', workerId: workerId.trim() },
    {
      $set: {
        status: result.status === 'blocked' ? 'failed' : 'completed',
        result,
        error: result.error,
        finishedAt: now,
      },
    },
    { returnDocument: 'after' },
  )
  if (!job) throw new Error('Job não encontrado, já finalizado ou não pertence a este navegador.')

  const connection = useDb()
  if (!connection.db) throw new Error('Banco de dados ainda não está conectado.')
  const vehicle = Types.ObjectId.isValid(job.vehicleId)
    ? await connection.db.collection<Record<string, unknown>>('scraped_vehicles').findOne(
        { _id: new Types.ObjectId(job.vehicleId) },
        { projection: { title: 1, brand: 1, model: 1, year: 1, auctionDate: 1 } },
      )
    : null
  if (result.status !== 'blocked' && Types.ObjectId.isValid(job.vehicleId)) {
    const checkedAt = now
    const originalAuctionDate = job.originalAuctionDate ? new Date(job.originalAuctionDate) : null
    const nextAuctionDate = result.nextAuctionDate ? new Date(result.nextAuctionDate) : null
    const set: Record<string, unknown> = {
      conditionalStatus: result.status,
      conditionalStatusRaw: result.statusRaw,
      conditionalStatusCheckedAt: checkedAt,
      conditionalOriginalAuctionDate: originalAuctionDate && !Number.isNaN(originalAuctionDate.getTime()) ? originalAuctionDate : null,
      scrapedAt: checkedAt,
    }
    if (result.status === 'approved') {
      set.auctionStatus = 'finished'
      set.auctionStatusRaw = 'Venda Finalizada'
      set.auctionStatusCheckedAt = checkedAt
    }
    else if (result.status === 'removed') {
      set.auctionStatus = 'finished'
      set.auctionStatusRaw = 'Lote removido ou indisponível'
      set.auctionStatusCheckedAt = checkedAt
    }
    else if (result.status === 'refused') {
      set.auctionStatus = 'upcoming'
      set.auctionStatusRaw = result.statusRaw
      set.auctionStatusCheckedAt = checkedAt
      if (nextAuctionDate && !Number.isNaN(nextAuctionDate.getTime())) set.auctionDate = nextAuctionDate
      if (result.currentBid != null && result.currentBid > 0) set.price = result.currentBid
    }
    await connection.db.collection('scraped_vehicles').updateOne(
      {
        _id: new Types.ObjectId(job.vehicleId),
        source: 'copart',
        saleStatus: 'conditional',
        conditionalStatus: { $in: [null, 'pending'] },
      },
      { $set: set },
    )
  }
  const run = await connection.db.collection<{
    runId: string
    trigger: 'schedule' | 'manual'
    status: 'running' | 'completed' | 'failed'
    total: number
    processed: number
    approved: number
    refused: number
    pending: number
    removed: number
    errors: number
    logs: string[]
  }>('copart_conditional_runs').findOne({ runId: job.runId })
  if (!run) return { job: toJob(job), finishedRun: false }

  const startedAt = job.claimedAt ?? now
  const nextAuctionDate = dateOrNull(result.nextAuctionDate)
  await connection.db.collection('copart_conditional_attempts').insertOne({
    _id: new Types.ObjectId(),
    runId: job.runId,
    vehicleId: job.vehicleId,
    url: job.url,
    lot: job.lot ?? null,
    title: typeof vehicle?.title === 'string' ? vehicle.title : null,
    brand: typeof vehicle?.brand === 'string' ? vehicle.brand : null,
    model: typeof vehicle?.model === 'string' ? vehicle.model : null,
    year: typeof vehicle?.year === 'number' ? vehicle.year : null,
    trigger: run.trigger,
    status: result.status === 'blocked' ? 'error' : result.status,
    statusRaw: result.statusRaw,
    startedAt,
    finishedAt: now,
    checkedAt: now,
    durationMs: Math.max(0, now.getTime() - startedAt.getTime()),
    originalAuctionDate: job.originalAuctionDate,
    auctionDate: dateOrNull(vehicle?.auctionDate),
    nextAuctionDate,
    error: result.error,
  })

  const runsCollection = connection.db.collection<typeof run>('copart_conditional_runs')
  const increment: Record<string, number> = { processed: 1 }
  if (result.status === 'approved') increment.approved = 1
  else if (result.status === 'refused') increment.refused = 1
  else if (result.status === 'pending') increment.pending = 1
  else if (result.status === 'removed') increment.removed = 1
  else increment.errors = 1

  const update: Record<string, unknown> = { $inc: increment }
  if (result.error) update.$push = { logs: { $each: [result.error], $slice: -100 } }
  await runsCollection.updateOne({ runId: job.runId }, update)
  const updatedRun = await runsCollection.findOne({ runId: job.runId })
  const finishedRun = Boolean(updatedRun && updatedRun.processed >= updatedRun.total)
  if (updatedRun && finishedRun) {
    await runsCollection.updateOne(
      { runId: job.runId, status: 'running' },
      { $set: { status: updatedRun.errors > 0 ? 'failed' : 'completed', finishedAt: now } },
    )
  }
  return { job: toJob(job), finishedRun }
}

export function parseCopartConditionalJobStatus(value: unknown): CopartConditionalJobResult['status'] | null {
  return value === 'pending' || value === 'approved' || value === 'refused' || value === 'removed' || value === 'blocked'
    ? value
    : null
}

export function parseCopartConditionalJobResult(value: unknown): CopartConditionalJobResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Resultado de consulta inválido.')
  const input = value as Record<string, unknown>
  const status = parseCopartConditionalJobStatus(input.status)
  if (!status) throw new Error('Resultado de consulta desconhecido.')
  const nextAuctionDate = typeof input.nextAuctionDate === 'string' && input.nextAuctionDate.trim()
    ? input.nextAuctionDate
    : null
  const currentBid = typeof input.currentBid === 'number' && Number.isFinite(input.currentBid)
    ? Math.max(0, Math.round(input.currentBid))
    : null
  return {
    status,
    statusRaw: typeof input.statusRaw === 'string' && input.statusRaw.trim() ? input.statusRaw.trim().slice(0, 240) : null,
    nextAuctionDate,
    currentBid,
    error: typeof input.error === 'string' && input.error.trim() ? input.error.trim().slice(0, 500) : null,
    source: 'extension',
  }
}
