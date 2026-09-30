import type { PipelineStage } from 'mongoose'
import type { LiveAuctionAuditSource } from '#shared/types/live-auction-audit'
import type {
  LiveAuctionAuditResponse,
  LiveAuctionAuditServerEvent,
  LiveAuctionLotEvidence,
  LiveAuctionSessionAuditSummary,
} from '#shared/types/live-auction-reconciliation'
import { LiveAuctionEventOutboxModel } from '../../utils/schemas/live-auction-event-outbox'
import { LiveAuctionCaptureModel } from '../../utils/schemas/live-auction-capture'
import { VehicleModel } from '../../utils/schemas/vehicle'

const LIVE_SOURCES = new Set<LiveAuctionAuditSource>(['copart', 'vipleiloes', 'sodre'])
const TERMINAL_KINDS = new Set(['lot_sold', 'lot_conditional', 'lot_not_sold'])

function queryText(value: unknown): string | null {
  const item = Array.isArray(value) ? value[0] : value
  return typeof item === 'string' && item.trim() ? item.trim() : null
}

function periodStart(value: string | null): Date {
  if (value === 'today') {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(new Date())
    const part = (type: string) => parts.find(item => item.type === type)?.value ?? ''
    return new Date(`${part('year')}-${part('month')}-${part('day')}T00:00:00-03:00`)
  }
  const days = value === '30d' ? 30 : 7
  return new Date(Date.now() - days * 24 * 60 * 60 * 1_000)
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function nullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function evidenceStatus(value: unknown): LiveAuctionLotEvidence['status'] {
  return value === 'sold' || value === 'conditional' || value === 'not_sold' || value === 'unknown' || value === 'open'
    ? value
    : null
}

function codeFromUrl(value: unknown): string | null {
  const url = nullableText(value)
  return url?.match(/\/lot\/(\d+)/i)?.[1] ?? null
}

function iso(value: unknown): string | null {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null
}

function publicHistoryEndpoint(): URL | null {
  const config = useRuntimeConfig()
  const configured = String(config.picaretaIngestUrl || process.env.PICARETA_INGEST_URL || '').trim()
  if (!configured) return null
  return new URL('/api/v1/public/auction-history', configured)
}

type PublicVehicle = Record<string, unknown>

async function fetchPublicHistory(sessionKey: string, aliases: string[], source: LiveAuctionAuditSource) {
  const endpoint = publicHistoryEndpoint()
  if (!endpoint) return {
    evidence: [] as LiveAuctionLotEvidence[],
    state: { status: 'not_configured' as const, error: 'PICARETA_INGEST_URL não configurado.', historyUrl: null },
  }
  endpoint.searchParams.set('auctionSession', [...new Set([sessionKey, ...aliases])].join(','))
  endpoint.searchParams.set('sources', source)
  endpoint.searchParams.set('saleStatus', 'sold,conditional,not_sold,unknown')
  endpoint.searchParams.set('period', 'all')
  endpoint.searchParams.set('limit', '5000')
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 180)}`)
    const body = await response.json() as { vehicles?: unknown }
    const vehicles = Array.isArray(body.vehicles) ? body.vehicles.filter((item): item is PublicVehicle => Boolean(item) && typeof item === 'object' && !Array.isArray(item)) : []
    const evidence = vehicles.map((item): LiveAuctionLotEvidence => ({
      origin: 'public_history',
      source,
      sessionKey: nullableText(item.auctionSessionKey) ?? sessionKey,
      auctionId: nullableText(item.auctionId),
      lot: nullableText(item.lot),
      code: codeFromUrl(item.url),
      status: item.saleStatus === 'sold' || item.saleStatus === 'conditional' || item.saleStatus === 'not_sold' || item.saleStatus === 'unknown' ? item.saleStatus : null,
      amount: nullableNumber(item.soldPrice) ?? nullableNumber(item.price),
      fipe: nullableNumber(item.fipe),
      damage: nullableText(item.damage),
      title: nullableText(item.title) ?? ([nullableText(item.brand), nullableText(item.model)].filter(Boolean).join(' ') || null),
      observedAt: iso(item.scrapedAt),
      url: nullableText(item.url),
      eventId: null,
    }))
    const historyUrl = new URL('/historico-leiloes-publico', endpoint)
    historyUrl.searchParams.set('auctionSession', sessionKey)
    return { evidence, state: { status: 'available' as const, error: null, historyUrl: historyUrl.toString() } }
  }
  catch (error) {
    return {
      evidence: [] as LiveAuctionLotEvidence[],
      state: {
        status: 'unavailable' as const,
        error: error instanceof Error ? error.message : String(error),
        historyUrl: null,
      },
    }
  }
}

export default defineEventHandler(async (event): Promise<LiveAuctionAuditResponse> => {
  useDb()
  const query = getQuery(event)
  const sessionKey = queryText(query.sessionKey)
  const from = periodStart(queryText(query.period))
  const sessionPipeline: PipelineStage[] = [
    { $match: { observedAt: { $gte: from } } },
    { $set: { _canonicalSessionKey: { $toLower: '$sessionKey' } } },
    { $sort: { observedAt: 1, sequence: 1 } },
    { $group: {
      _id: '$_canonicalSessionKey',
      aliases: { $addToSet: '$sessionKey' },
      source: { $first: '$source' },
      auctionId: { $first: '$auctionId' },
      sessionLabel: { $first: '$sessionLabel' },
      eventCount: { $sum: 1 },
      pendingEvents: { $sum: { $cond: [{ $eq: ['$syncStatus', 'pending'] }, 1, 0] } },
      terminalLotValues: { $addToSet: { $cond: [{ $in: ['$kind', [...TERMINAL_KINDS]] }, '$lot', null] } },
      firstObservedAt: { $first: '$observedAt' },
      lastObservedAt: { $last: '$observedAt' },
    } },
    { $sort: { lastObservedAt: -1 } },
    { $limit: 100 },
  ]

  const [sessionDocs, captureSessionDocs] = await Promise.all([
    LiveAuctionEventOutboxModel.aggregate(sessionPipeline) as Promise<Array<Record<string, unknown>>>,
    LiveAuctionCaptureModel.aggregate([
      { $match: { lastCapturedAt: { $gte: from }, auctionId: { $type: 'string', $ne: '' } } },
      { $sort: { lastCapturedAt: 1 } },
      { $group: {
        _id: { $concat: [{ $toLower: '$source' }, ':', { $toLower: '$auctionId' }] },
        source: { $last: '$source' },
        auctionId: { $last: '$auctionId' },
        observationCount: { $sum: 1 },
        firstObservedAt: { $min: '$firstCapturedAt' },
        lastObservedAt: { $max: '$lastCapturedAt' },
      } },
      { $sort: { lastObservedAt: -1 } },
      { $limit: 100 },
    ]) as Promise<Array<Record<string, unknown>>>,
  ])
  const sessionMap = new Map<string, LiveAuctionSessionAuditSummary>()
  for (const item of sessionDocs) {
    const summary: LiveAuctionSessionAuditSummary = {
      sessionKey: String(item._id),
      aliases: Array.isArray(item.aliases) ? item.aliases.filter((value): value is string => typeof value === 'string') : [String(item._id)],
      source: item.source as LiveAuctionAuditSource,
      auctionId: nullableText(item.auctionId),
      sessionLabel: nullableText(item.sessionLabel),
      eventCount: Number(item.eventCount ?? 0),
      terminalLots: Array.isArray(item.terminalLotValues) ? item.terminalLotValues.filter(Boolean).length : 0,
      pendingEvents: Number(item.pendingEvents ?? 0),
      firstObservedAt: iso(item.firstObservedAt) ?? new Date(0).toISOString(),
      lastObservedAt: iso(item.lastObservedAt) ?? new Date(0).toISOString(),
    }
    if (LIVE_SOURCES.has(summary.source)) sessionMap.set(summary.sessionKey, summary)
  }
  for (const item of captureSessionDocs) {
    const key = String(item._id)
    const source = String(item.source).toLowerCase() as LiveAuctionAuditSource
    if (!LIVE_SOURCES.has(source)) continue
    const current = sessionMap.get(key)
    if (current) {
      if (Date.parse(iso(item.lastObservedAt) ?? '') > Date.parse(current.lastObservedAt)) current.lastObservedAt = iso(item.lastObservedAt) ?? current.lastObservedAt
      continue
    }
    sessionMap.set(key, {
      sessionKey: key,
      aliases: [key],
      source,
      auctionId: nullableText(item.auctionId),
      sessionLabel: null,
      eventCount: 0,
      terminalLots: 0,
      pendingEvents: 0,
      firstObservedAt: iso(item.firstObservedAt) ?? new Date(0).toISOString(),
      lastObservedAt: iso(item.lastObservedAt) ?? new Date(0).toISOString(),
    })
  }
  const sessions = [...sessionMap.values()].sort((first, second) => Date.parse(second.lastObservedAt) - Date.parse(first.lastObservedAt))

  if (!sessionKey) {
    return {
      selectedSessionKey: null,
      sessions,
      events: [],
      extensionCaptures: [],
      botCaptures: [],
      publicHistory: [],
      publicHistoryState: { status: 'available', error: null, historyUrl: null },
      generatedAt: new Date().toISOString(),
    }
  }

  const canonicalSessionKey = sessionKey.toLowerCase()
  const selected = sessions.find(item => item.sessionKey === canonicalSessionKey || item.aliases.some(alias => alias.toLowerCase() === canonicalSessionKey))
  const inferredSource = sessionKey.split(':')[0]?.toLowerCase() as LiveAuctionAuditSource
  const selectedSource = selected?.source ?? (LIVE_SOURCES.has(inferredSource) ? inferredSource : null)
  if (!selectedSource) throw createError({ statusCode: 400, message: 'Origem da sessão inválida.' })
  const auctionId = selected?.auctionId ?? sessionKey.split(':')[1] ?? null

  const aliases = selected?.aliases?.length ? selected.aliases : [sessionKey]
  const sessionKeyPattern = new RegExp(`^${canonicalSessionKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i')
  const auctionIdPattern = auctionId ? new RegExp(`^${auctionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') : null
  const [eventDocs, observationDocs, captureDocs, publicResult] = await Promise.all([
    LiveAuctionEventOutboxModel.find({ sessionKey: sessionKeyPattern }).sort({ observedAt: 1, sequence: 1 }).limit(5_000).lean(),
    LiveAuctionCaptureModel.find({
      source: selectedSource,
      ...(auctionIdPattern ? { auctionId: auctionIdPattern } : {}),
    }).sort({ lastCapturedAt: -1 }).limit(5_000).lean(),
    VehicleModel.find({
      collectedVia: 'extension',
      source: selectedSource,
      $or: [
        { auctionSessionKey: sessionKeyPattern },
        ...(auctionIdPattern ? [{ auctionSessionKey: { $in: [null, ''] }, auctionId: auctionIdPattern }] : []),
      ],
    }).sort({ scrapedAt: -1 }).limit(5_000).lean(),
    fetchPublicHistory(canonicalSessionKey, aliases, selectedSource),
  ])

  const events = eventDocs.map((item): LiveAuctionAuditServerEvent => ({
    schemaVersion: 1,
    eventId: item.eventId,
    sessionKey: item.sessionKey,
    source: item.source,
    auctionId: item.auctionId,
    sessionLabel: item.sessionLabel,
    sequence: item.sequence,
    observedAt: item.observedAt.toISOString(),
    rawText: item.rawText,
    normalizedText: item.normalizedText,
    kind: item.kind,
    lot: item.lot,
    code: item.code,
    amount: item.amount,
    parserVersion: item.parserVersion,
    chassisRaw: item.chassisRaw,
    chassisNormalized: item.chassisNormalized,
    vehicleUrl: item.vehicleUrl,
    description: item.description,
    consignor: item.consignor,
    yard: item.yard,
    extensionVersion: item.extensionVersion,
    collectorUserId: null,
    deviceId: null,
    receivedAt: item.receivedAt.toISOString(),
    syncStatus: item.syncStatus,
    syncedAt: item.syncedAt?.toISOString() ?? null,
    syncAttempts: item.syncAttempts,
    lastSyncError: item.lastSyncError,
  }))
  const extensionCaptures = observationDocs.map((item): LiveAuctionLotEvidence => ({
    origin: 'extension_observation',
    source: selectedSource,
    sessionKey: canonicalSessionKey,
    auctionId: nullableText(item.auctionId),
    lot: nullableText(item.lot),
    code: nullableText(item.code) ?? codeFromUrl(item.vehicleUrl),
    status: evidenceStatus(item.lastEvent?.saleStatus),
    amount: nullableNumber(item.lastEvent?.bid),
    fipe: nullableNumber(item.lastEvent?.fipe),
    damage: nullableText(item.lastEvent?.damage),
    title: [nullableText(item.brand), nullableText(item.model)].filter(Boolean).join(' ') || nullableText(item.lastEvent?.description),
    observedAt: iso(item.lastCapturedAt),
    url: nullableText(item.vehicleUrl),
    eventId: null,
  }))
  const botCaptures = captureDocs.map((item): LiveAuctionLotEvidence => ({
    origin: 'bot_capture',
    source: selectedSource,
    sessionKey: nullableText(item.auctionSessionKey) ?? canonicalSessionKey,
    auctionId: nullableText(item.auctionId),
    lot: nullableText(item.lot),
    code: codeFromUrl(item.url),
    status: item.saleStatus,
    amount: nullableNumber(item.soldPrice) ?? nullableNumber(item.price),
    fipe: nullableNumber(item.fipe),
    damage: nullableText(item.damage),
    title: nullableText(item.title) ?? (`${item.brand} ${item.model}`.trim() || null),
    observedAt: iso(item.scrapedAt),
    url: nullableText(item.url),
    eventId: null,
  }))

  return {
    selectedSessionKey: canonicalSessionKey,
    sessions,
    events,
    extensionCaptures,
    botCaptures,
    publicHistory: publicResult.evidence,
    publicHistoryState: publicResult.state,
    generatedAt: new Date().toISOString(),
  }
})

