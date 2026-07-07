import { createHash } from 'node:crypto'

type CopartLiveEventType = 'snapshot' | 'bid' | 'closed' | 'sale' | 'status'
type CopartLiveSaleStatus = 'open' | 'sold' | 'conditional' | null

type CopartLiveAuctionEventInput = {
  eventKey?: string | null
  source?: string | null
  auctionId?: string | null
  lot?: string | null
  code?: string | null
  description?: string | null
  version?: string | null
  yearModel?: string | null
  brand?: string | null
  model?: string | null
  fipe?: number | null
  fipeRaw?: string | null
  damage?: string | null
  yard?: string | null
  bid?: number | null
  bidRaw?: string | null
  saleStatus?: CopartLiveSaleStatus
  eventType?: CopartLiveEventType
  fipePercent?: number | null
  imageUrl?: string | null
  vehicleUrl?: string | null
  message?: string | null
  observedAt?: string | Date | null
}

type CopartLiveAuctionEventDoc = Required<Omit<CopartLiveAuctionEventInput, 'eventKey' | 'source' | 'observedAt'>> & {
  eventKey: string
  source: 'copart-live'
  observedAt: Date
  updatedAt: Date
  createdAt: Date
}

type NormalizedEvent = Omit<CopartLiveAuctionEventDoc, 'updatedAt' | 'createdAt'>

const COLLECTION = 'copart_live_auction_events'
const MAX_BATCH_SIZE = 100

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const expectedToken = getOptionalString(config.copartExtensionToken) ?? getOptionalString(process.env.COPART_EXTENSION_TOKEN)

  if (expectedToken) {
    const providedToken = getHeader(event, 'x-copart-extension-token')?.trim()
    if (providedToken !== expectedToken) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Unauthorized',
        message: 'Token da extensao Copart invalido.',
      })
    }
  }

  const body = await readBody<unknown>(event)
  const rawEvents = getEventArray(body)

  if (rawEvents.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Envie pelo menos um evento em { events: [...] }.',
    })
  }

  const normalizedEvents = rawEvents
    .slice(0, MAX_BATCH_SIZE)
    .map(normalizeEvent)
    .filter((item): item is NormalizedEvent => item != null)

  if (normalizedEvents.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Nenhum evento valido recebido.',
    })
  }

  const db = useDb()
  const collection = db.collection<CopartLiveAuctionEventDoc>(COLLECTION)
  const now = new Date()

  const result = await collection.bulkWrite(
    normalizedEvents.map(item => ({
      updateOne: {
        filter: { eventKey: item.eventKey },
        update: {
          $setOnInsert: {
            createdAt: now,
          },
          $set: {
            ...item,
            updatedAt: now,
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  )

  return {
    ok: true,
    received: rawEvents.length,
    accepted: normalizedEvents.length,
    inserted: result.upsertedCount,
    matched: result.matchedCount,
    modified: result.modifiedCount,
  }
})

function getEventArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body['events'])) return body['events']
  return []
}

function normalizeEvent(value: unknown): NormalizedEvent | null {
  if (!isRecord(value)) return null

  const observedAt = toDate(value['observedAt']) ?? new Date()
  const bid = toNumber(value['bid']) ?? toNumber(value['bidRaw'])
  const fipe = toNumber(value['fipe']) ?? toNumber(value['fipeRaw'])
  const fipePercent = bid != null && fipe != null && fipe > 0
    ? Math.round((bid / fipe) * 100)
    : toNumber(value['fipePercent'])

  const eventType = toEventType(value['eventType'])
  const saleStatus = toSaleStatus(value['saleStatus'])
  const item = {
    eventKey: normalizeText(value['eventKey']),
    source: 'copart-live' as const,
    auctionId: normalizeText(value['auctionId']),
    lot: normalizeText(value['lot']),
    code: normalizeText(value['code']),
    description: normalizeText(value['description']),
    version: normalizeText(value['version']),
    yearModel: normalizeText(value['yearModel']),
    brand: normalizeText(value['brand']),
    model: normalizeText(value['model']),
    fipe,
    fipeRaw: normalizeText(value['fipeRaw']),
    damage: normalizeText(value['damage']),
    yard: normalizeText(value['yard']),
    bid,
    bidRaw: normalizeText(value['bidRaw']),
    saleStatus,
    eventType,
    fipePercent,
    imageUrl: normalizeText(value['imageUrl']),
    vehicleUrl: normalizeText(value['vehicleUrl']),
    message: normalizeText(value['message']),
    observedAt,
  }

  if (!hasUsefulData(item)) return null

  return {
    ...item,
    eventKey: item.eventKey ?? buildEventKey(item),
  }
}

function buildEventKey(event: Omit<NormalizedEvent, 'eventKey'> & { eventKey: string | null }): string {
  const seed = [
    event.source,
    event.auctionId,
    event.lot,
    event.code,
    event.eventType,
    event.saleStatus,
    event.bid,
    event.bidRaw,
    event.message,
  ].map(value => value == null ? '-' : String(value).trim()).join('|')

  return createHash('sha1').update(seed).digest('hex')
}

function hasUsefulData(event: Omit<NormalizedEvent, 'eventKey'> & { eventKey: string | null }): boolean {
  return Boolean(
    event.auctionId ||
    event.lot ||
    event.code ||
    event.description ||
    event.brand ||
    event.model ||
    event.bidRaw ||
    event.message,
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const text = value.replace(/\s+/g, ' ').trim()
  return text || null
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null

  const match = value.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/)
  if (!match) return null

  const parsed = Number.parseFloat(match[1]!.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string') return null

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function toEventType(value: unknown): CopartLiveEventType {
  if (
    value === 'snapshot' ||
    value === 'bid' ||
    value === 'closed' ||
    value === 'sale' ||
    value === 'status'
  ) {
    return value
  }

  return 'snapshot'
}

function toSaleStatus(value: unknown): CopartLiveSaleStatus {
  if (value === 'open' || value === 'sold' || value === 'conditional') return value
  return null
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
