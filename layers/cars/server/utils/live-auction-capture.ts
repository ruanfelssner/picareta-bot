import { createHash } from 'node:crypto'
import type { LiveAuctionExtensionActor } from './live-auction-extension-auth'
import { buildLiveAuctionCaptureFields } from './live-auction-capture-fields'
import { LiveAuctionCaptureModel } from './schemas/live-auction-capture'

const RETENTION_MS = 5 * 365 * 24 * 60 * 60 * 1000
function text(value: unknown, max = 1_000): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function identityKey(input: Record<string, unknown>): string | null {
  const source = text(input['source'], 80)
  const code = text(input['code'], 240)
  const vehicleUrl = text(input['vehicleUrl'], 4_096)
  const auctionId = text(input['auctionId'], 240)
  const lot = text(input['lot'], 240)
  if (!source) return null
  const identity = code
    ? `code:${code}`
    : vehicleUrl
      ? `url:${vehicleUrl}`
      : auctionId && lot
        ? `auction:${auctionId}:lot:${lot}`
        : null
  if (identity) return `${source}:${createHash('sha256').update(identity).digest('hex')}`
  return null
}

export async function recordLiveAuctionCapture(
  input: Record<string, unknown>,
  actor: LiveAuctionExtensionActor,
): Promise<boolean> {
  if (actor.kind !== 'user' || !actor.userId || !actor.phone || !actor.deviceId) return false
  const key = identityKey(input)
  const source = text(input['source'], 80)
  if (!key || !source) return false

  const now = new Date()
  await LiveAuctionCaptureModel.updateOne(
    { identityKey: key },
    {
      $set: {
        ...buildLiveAuctionCaptureFields(input),
        source,
        lastCapturedBy: {
          userId: actor.userId,
          phone: actor.phone,
          name: actor.name,
          deviceId: actor.deviceId,
          capturedAt: now,
        },
        lastCapturedAt: now,
        expiresAt: new Date(now.getTime() + RETENTION_MS),
      },
      $setOnInsert: { identityKey: key, firstCapturedAt: now },
      $addToSet: { captureUserIds: actor.userId },
      $inc: { captureCount: 1 },
    },
    { upsert: true },
  )
  return true
}
