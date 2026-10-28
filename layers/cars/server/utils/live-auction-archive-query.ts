import type { mongo } from 'mongoose'

type Document = mongo.Document

export interface AuctionArchiveQuery {
  q?: string
  source?: string
  from?: Date
  to?: Date
  sessionKey?: string
  origin?: string
  page?: number
}

// Only project audit data: user IDs, devices, tokens and images never leave the database.
const first = (...fields: string[]): Document => fields.reduceRight<Document>((fallback, field) => ({
  $ifNull: [{ $cond: [{ $eq: [`$${field}`, ''] }, null, `$${field}`] }, fallback],
}), { $literal: null })
const string = (value: unknown): Document => ({ $convert: { input: value, to: 'string', onError: null, onNull: null } })
const date = (value: unknown): Document => ({ $convert: { input: value, to: 'date', onError: null, onNull: null } })
const money = (...fields: string[]): Document => ({ $convert: { input: first(...fields), to: 'double', onError: null, onNull: null } })

function projection(origin: string): Document {
  const capture = origin === 'capture'
  const raw = origin === 'log' || origin === 'outbox'
  const session = origin === 'session'
  const source = string(first('source', 'lastEvent.source'))
  const auctionId = string(first('auctionId', 'lastEvent.auctionId'))
  return {
    _id: 0,
    id: { $concat: [origin + ':', { $toString: '$_id' }] },
    origin: { $literal: origin },
    source,
    auctionId,
    sessionKey: first('sessionKey', 'auctionSessionKey'),
    fallbackSessionKey: { $cond: [
      { $and: [source, auctionId] }, { $concat: [source, ':', auctionId] },
      { $concat: [source, ':registro:', { $toString: '$_id' }] },
    ] },
    lot: string(first('lot', 'lastEvent.lot')),
    code: string(first('code', 'lastEvent.code')),
    title: first('title', 'description', 'lastEvent.description'),
    label: first('label', 'sessionLabel'),
    observedAt: date(first(...(session ? ['lastEventAt', 'startedAt'] : capture
      ? ['lastEvent.observedAt', 'lastCapturedAt'] : ['observedAt', 'resultObservedAt', 'scrapedAt', 'updatedAt', 'createdAt']))),
    message: first(...(capture ? ['lastEvent.message'] : ['rawText', 'saleStatusRaw'])),
    amount: money(...(capture ? ['lastEvent.bid'] : raw ? ['amount'] : ['finalAmount', 'soldPrice', 'price'])),
    fipe: money('fipe', 'lastEvent.fipe'),
    status: first('finalStatus', 'saleStatus', 'lastEvent.saleStatus'),
    kind: first('kind'),
    url: first('vehicleUrl', 'url', 'lastEvent.vehicleUrl'),
    eventId: first('eventId', 'resultEventId'),
  }
}

export function archivePage(value: unknown): number {
  const page = Number(value)
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1
}

export function archiveMatch(options: AuctionArchiveQuery): Document {
  const match: Document = {}
  if (options.source) match.source = options.source
  if (options.sessionKey) match.sessionKey = options.sessionKey
  if (options.origin) match.origin = options.origin
  if (options.from || options.to) match.observedAt = {
    ...(options.from ? { $gte: options.from } : {}),
    ...(options.to ? { $lte: options.to } : {}),
  }
  const term = options.q?.trim().slice(0, 200)
  if (term) {
    const fieldSearch = term.match(/^(lote|c[oó]digo|leil[aã]o)\s*[:#]?\s*(\d+)$/i)
    if (fieldSearch) {
      const field = /^lote$/i.test(fieldSearch[1]!) ? 'lot' : /^c/i.test(fieldSearch[1]!) ? 'code' : 'auctionId'
      match[field] = fieldSearch[2]
      return match
    }
    if (/^\d+$/.test(term)) {
      match.$or = ['auctionId', 'lot', 'code'].map(field => ({ [field]: term }))
      return match
    }
    try {
      const url = new URL(term)
      const code = /^(www\.)?copart\.com\.br$/i.test(url.hostname) ? url.pathname.match(/^\/lot\/(\d+)\/?$/)?.[1] : null
      if (code) {
        match.code = code
        return match
      }
    }
    catch { /* A text search does not need to be a URL. */ }
    const regex = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    match.$or = ['sessionKey', 'auctionId', 'lot', 'code', 'title', 'label', 'url', 'message', 'kind', 'status'].map(field => ({
      [field]: { $regex: regex, $options: 'i' },
    }))
  }
  return match
}

export function archivePipeline(options: AuctionArchiveQuery, includeSessions: boolean): Document[] {
  const collections = [
    ['auction_live_events', 'log'], ['live_auction_event_outbox', 'outbox'],
    ['live_auction_capture_observations', 'capture'], ['scraped_vehicles', 'vehicle'],
    ['auction_lot_results', 'result'],
    ...(includeSessions ? [['auction_sessions', 'session']] : []),
  ]
  const sessionSource = options.sessionKey?.split(':')[0]
  const source = options.source || (sessionSource && ['copart', 'vipleiloes', 'sodre', 'pestana'].includes(sessionSource) ? sessionSource : undefined)
  const initialMatch: Document = { source: source || { $in: ['copart', 'vipleiloes', 'sodre', 'pestana'] } }
  if (source && options.sessionKey && !options.sessionKey.startsWith(`${source}:registro:`)) {
    const auctionId = options.sessionKey.slice(source.length + 1)
    const exact = (value: string) => ({ $regex: `^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' })
    initialMatch.$or = [
      { sessionKey: exact(options.sessionKey) }, { auctionSessionKey: exact(options.sessionKey) },
      { auctionId: exact(auctionId) }, { 'lastEvent.auctionId': exact(auctionId) },
      ...(/^\d+$/.test(auctionId) ? [{ auctionId: Number(auctionId) }] : []),
    ]
  }
  const stages = (origin: string): Document[] => [
    { $match: initialMatch },
    { $project: projection(origin) },
    { $set: { sessionKey: { $toLower: { $ifNull: ['$sessionKey', '$fallbackSessionKey'] } } } },
    { $set: { code: { $ifNull: ['$code', { $let: {
      vars: { found: { $regexFind: { input: { $ifNull: ['$url', ''] }, regex: '/lot/([0-9]+)(?:[^0-9]|$)' } } },
      in: { $arrayElemAt: ['$$found.captures', 0] },
    } }] } } },
    { $match: archiveMatch(options) },
    { $unset: 'fallbackSessionKey' },
  ]
  return [
    ...stages('log'),
    ...collections.slice(1).map(([coll, origin]) => ({ $unionWith: { coll, pipeline: stages(origin!) } })),
    ...(!includeSessions && options.sessionKey ? [{ $unionWith: {
      coll: 'scraped_vehicles',
      pipeline: [
        ...stages('vehicle'),
        { $lookup: { from: 'auction_results', localField: 'url', foreignField: 'url', let: { source: '$source' }, as: 'catalog', pipeline: [
          { $match: { $expr: { $eq: ['$source', '$$source'] } } },
          { $project: { _id: 1, source: 1, url: 1, price: 1, fipe: 1, title: 1, scrapedAt: 1 } },
        ] } },
        { $unwind: '$catalog' },
        { $replaceWith: { $mergeObjects: ['$catalog', { sessionKey: '$sessionKey', auctionId: '$auctionId', lot: '$lot', code: '$code', title: '$title' }] } },
        ...stages('catalog'),
      ],
    } }] : []),
  ]
}

export function archiveFacet(page: number, pageSize: number): Document {
  return { $facet: {
    items: [{ $skip: (page - 1) * pageSize }, { $limit: pageSize }],
    count: [{ $count: 'total' }],
  } }
}
