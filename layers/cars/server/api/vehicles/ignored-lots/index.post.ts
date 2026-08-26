import { assertLiveAuctionExtensionAuthorized } from '../../../utils/live-auction-extension-auth'
import { IgnoredLiveAuctionLotModel } from '../../../utils/schemas/ignored-live-auction-lot'

const SUPPORTED_SOURCES = new Set(['copart', 'vipleiloes', 'sodre'])
const MAX_TEXT_LENGTH = 240
const RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000

function text(value: unknown, max = MAX_TEXT_LENGTH): string | null {
  if (typeof value !== 'string') return null
  const valueTrimmed = value.trim()
  return valueTrimmed ? valueTrimmed.slice(0, max) : null
}

function eventValue(event: Record<string, unknown>, key: string, max = MAX_TEXT_LENGTH): string | null {
  return text(event[key], max)
}

function buildIdentityKey(event: Record<string, unknown>): string | null {
  const source = eventValue(event, 'source')
  const vehicleUrl = eventValue(event, 'vehicleUrl', MAX_TEXT_LENGTH * 4)
  const code = eventValue(event, 'code')
  const auctionId = eventValue(event, 'auctionId')
  const lot = eventValue(event, 'lot')
  if (!source) return null
  if (code) return `${source}:code:${code}`
  if (vehicleUrl) return `${source}:url:${vehicleUrl}`
  if (auctionId && lot) return `${source}:auction:${auctionId}:lot:${lot}`
  return null
}

function compactEvent(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const keys = [
    'source', 'auctionId', 'lot', 'code', 'description', 'version', 'yearModel', 'brand', 'model',
    'category', 'fipe', 'fipeRaw', 'damage', 'condition', 'yard', 'consignor', 'bid', 'bidRaw',
    'saleStatus', 'eventType', 'imageUrl', 'vehicleUrl', 'message', 'observedAt', 'manualDecision',
  ]
  return Object.fromEntries(keys.map(key => [key, key === 'description' || key === 'message'
    ? text(input[key], 1000)
    : typeof input[key] === 'number' || typeof input[key] === 'boolean' ? input[key] : text(input[key], 1000)]))
}

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)

  const body = await readBody<unknown>(event)
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    throw createError({ statusCode: 400, message: 'Corpo inválido' })
  }

  const payload = body as Record<string, unknown>
  const rawEvent = payload['event']
  const capturedEvent = rawEvent && typeof rawEvent === 'object' && !Array.isArray(rawEvent)
    ? rawEvent as Record<string, unknown>
    : payload
  const source = eventValue(capturedEvent, 'source')
  const identityKey = buildIdentityKey(capturedEvent)
  const reason = text(payload['reason']) ?? 'Ignorado pela regra automática'

  if (!source || !SUPPORTED_SOURCES.has(source)) {
    throw createError({ statusCode: 400, message: 'Fonte da extensão inválida' })
  }
  if (!identityKey) {
    throw createError({ statusCode: 400, message: 'Lote sem identificador recuperável' })
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + RETENTION_MS)
  const document = await IgnoredLiveAuctionLotModel.findOneAndUpdate(
    { identityKey },
    {
      $set: {
        source,
        auctionId: eventValue(capturedEvent, 'auctionId'),
        lot: eventValue(capturedEvent, 'lot'),
        code: eventValue(capturedEvent, 'code'),
        vehicleUrl: text(capturedEvent['vehicleUrl'], MAX_TEXT_LENGTH * 4),
        brand: eventValue(capturedEvent, 'brand'),
        model: eventValue(capturedEvent, 'model'),
        yearModel: eventValue(capturedEvent, 'yearModel'),
        category: eventValue(capturedEvent, 'category'),
        damage: eventValue(capturedEvent, 'damage'),
        condition: eventValue(capturedEvent, 'condition'),
        yard: eventValue(capturedEvent, 'yard'),
        consignor: eventValue(capturedEvent, 'consignor'),
        saleStatus: eventValue(capturedEvent, 'saleStatus'),
        reason,
        manualDecision: eventValue(capturedEvent, 'manualDecision'),
        decisionMode: text(payload['decisionMode']),
        lastIgnoredAt: now,
        lastEvent: compactEvent(capturedEvent),
        expiresAt,
        status: 'pending',
        resolvedAt: null,
        resolution: null,
        approvedAt: null,
        approvedBy: null,
        promotedVehicleId: null,
      },
      $setOnInsert: {
        identityKey,
        firstIgnoredAt: now,
        ignoredCount: 0,
      },
      $inc: { ignoredCount: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true, lean: true },
  )

  return {
    ok: true,
    item: {
      ...document,
      _id: String((document as Record<string, unknown>)['_id']),
    },
  }
})
