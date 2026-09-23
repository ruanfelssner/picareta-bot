import { Types } from 'mongoose'
import { isDbConnected, useDb } from './db'

// Mesmos nomes usados pelo worker em src/integrations/marketplace-web-search.ts e src/integrations/mongo.ts.
const WEB_SEARCHES_COLLECTION = 'marketplace_web_searches'
const WORKER_HEARTBEATS_COLLECTION = 'marketplace_worker_heartbeats'

export const MAX_WEB_SEARCH_TERMS = 8
const MAX_TERM_LENGTH = 80
/** Heartbeat do worker é gravado a cada 20s; acima disso consideramos o PC desligado. */
const WORKER_ONLINE_WINDOW_MS = 90_000
/** O worker toca `updatedAt` a cada 20s durante a busca; sem mudança por esse tempo, a busca travou. */
const RUNNING_STALE_MS = 5 * 60_000

type WebSearchStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'

interface WebSearchTermState {
  term: string
  status: WebSearchStatus
  total: number | null
  error: string | null
}

interface WebSearchDoc {
  _id: Types.ObjectId
  terms: string[]
  status: WebSearchStatus
  cancelRequested: boolean
  termStates: WebSearchTermState[]
  logs: { at: Date, term: string | null, message: string }[]
  previews: { term: string, item: Record<string, unknown> }[]
  finals: { term: string, items: Record<string, unknown>[] }[]
  workerId: string | null
  error: string | null
  createdAt: Date
  startedAt: Date | null
  finishedAt: Date | null
  updatedAt: Date
}

interface WorkerHeartbeatDoc {
  workerId: string
  status: 'IDLE' | 'RUNNING'
  searchTerm: string | null
  lastSeenAt: Date
}

export interface WebSearchOffsets {
  logs: number
  previews: number
  finals: number
}

let indexesReady = false

function webSearches() {
  const collection = useDb().collection<WebSearchDoc>(WEB_SEARCHES_COLLECTION)
  if (!indexesReady) {
    indexesReady = true
    void collection.createIndex({ status: 1, createdAt: 1 }).catch(() => {
      indexesReady = false
    })
  }
  return collection
}

function isActive(status: WebSearchStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING'
}

function toObjectId(id: string): Types.ObjectId {
  if (!Types.ObjectId.isValid(id)) {
    throw createError({ statusCode: 400, statusMessage: 'Identificador de busca inválido.' })
  }
  return new Types.ObjectId(id)
}

export function assertWebSearchAvailable() {
  if (!isDbConnected()) {
    throw createError({
      statusCode: 503,
      statusMessage: 'MongoDB não conectado — a fila de buscas do worker precisa do banco.',
    })
  }
}

export function normalizeWebSearchTerms(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const term = raw.trim().slice(0, MAX_TERM_LENGTH)
    const key = term.toLowerCase()
    if (!term || seen.has(key)) continue
    seen.add(key)
    terms.push(term)
  }
  return terms.slice(0, MAX_WEB_SEARCH_TERMS)
}

export async function createWebSearch(terms: string[]): Promise<string> {
  const collection = webSearches()
  const active = await collection.findOne(
    { status: { $in: ['PENDING', 'RUNNING'] } },
    { projection: { _id: 1 }, sort: { createdAt: -1 } },
  )
  if (active) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Já existe uma busca na fila ou em andamento. Aguarde ou cancele antes de iniciar outra.',
      data: { id: active._id.toString() },
    })
  }

  const now = new Date()
  const result = await collection.insertOne({
    _id: new Types.ObjectId(),
    terms,
    status: 'PENDING',
    cancelRequested: false,
    termStates: terms.map(term => ({ term, status: 'PENDING', total: null, error: null })),
    logs: [],
    previews: [],
    finals: [],
    workerId: null,
    error: null,
    createdAt: now,
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  })
  return result.insertedId.toString()
}

function toSummary(doc: Pick<WebSearchDoc, '_id' | 'terms' | 'status' | 'createdAt' | 'updatedAt'>) {
  return {
    id: doc._id.toString(),
    terms: doc.terms,
    status: doc.status,
    active: isActive(doc.status),
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  }
}

export async function getLatestWebSearch() {
  const doc = await webSearches().findOne(
    {},
    { projection: { terms: 1, status: 1, createdAt: 1, updatedAt: 1 }, sort: { createdAt: -1 } },
  )
  return doc ? toSummary(doc) : null
}

/** Retorna só o que a tela ainda não recebeu (logs/prévias/listas finais a partir dos offsets). */
export async function getWebSearchDelta(id: string, offsets: WebSearchOffsets) {
  const slice = (offset: number) => ({ $slice: [Math.max(0, offset), 10_000] })
  const doc = await webSearches().findOne(
    { _id: toObjectId(id) },
    {
      projection: {
        terms: 1,
        status: 1,
        cancelRequested: 1,
        termStates: 1,
        workerId: 1,
        error: 1,
        createdAt: 1,
        startedAt: 1,
        finishedAt: 1,
        updatedAt: 1,
        logs: slice(offsets.logs),
        previews: slice(offsets.previews),
        finals: slice(offsets.finals),
      },
    },
  )

  if (!doc) {
    throw createError({ statusCode: 404, statusMessage: 'Busca não encontrada.' })
  }

  const stale = doc.status === 'RUNNING' && Date.now() - doc.updatedAt.getTime() > RUNNING_STALE_MS

  return {
    ...toSummary(doc),
    cancelRequested: doc.cancelRequested === true,
    termStates: doc.termStates ?? [],
    workerId: doc.workerId,
    error: doc.error,
    stale,
    logs: (doc.logs ?? []).map(log => ({ term: log.term, message: log.message, at: log.at.toISOString() })),
    previews: doc.previews ?? [],
    finals: doc.finals ?? [],
  }
}

export async function cancelWebSearch(id: string): Promise<WebSearchStatus> {
  const collection = webSearches()
  const _id = toObjectId(id)
  const now = new Date()

  // Ainda na fila: cancela direto. Em execução: o worker percebe `cancelRequested` e encerra.
  const pending = await collection.findOneAndUpdate(
    { _id, status: 'PENDING' },
    {
      $set: {
        status: 'CANCELLED',
        cancelRequested: true,
        finishedAt: now,
        updatedAt: now,
        'termStates.$[].status': 'CANCELLED',
      },
    },
    { returnDocument: 'after' },
  )
  if (pending) return pending.status

  const running = await collection.findOneAndUpdate(
    { _id, status: 'RUNNING' },
    { $set: { cancelRequested: true } },
    { returnDocument: 'after' },
  )
  if (running) return running.status

  const current = await collection.findOne({ _id }, { projection: { status: 1 } })
  if (!current) throw createError({ statusCode: 404, statusMessage: 'Busca não encontrada.' })
  return current.status
}

export async function getMarketplaceWorkerStatus() {
  const heartbeat = await useDb()
    .collection<WorkerHeartbeatDoc>(WORKER_HEARTBEATS_COLLECTION)
    .findOne({}, { sort: { lastSeenAt: -1 } })

  if (!heartbeat) {
    return { online: false, status: null, workerId: null, searchTerm: null, lastSeenAt: null }
  }

  return {
    online: Date.now() - heartbeat.lastSeenAt.getTime() < WORKER_ONLINE_WINDOW_MS,
    status: heartbeat.status,
    workerId: heartbeat.workerId,
    searchTerm: heartbeat.searchTerm,
    lastSeenAt: heartbeat.lastSeenAt.toISOString(),
  }
}
