import { assertLiveAuctionExtensionAuthorized } from '../../../utils/live-auction-extension-auth'
import { getFipeConfigFromEnv, suggestFipe } from '../../../utils/fipe'

export default defineEventHandler(async (event) => {
  assertLiveAuctionExtensionAuthorized(event)

  const rawBody = await readBody<unknown>(event).catch((): unknown => null)
  if (!isRecord(rawBody)) {
    throw createError({ statusCode: 400, message: 'Consulta FIPE inválida.' })
  }

  const brand = readString(rawBody['brand'])
  const model = readString(rawBody['model'])
  const year = readYear(rawBody['year'])
  const requestedLimit = Number(rawBody['limit'])
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(10, Math.floor(requestedLimit)))
    : 6

  if (!brand || !model || year == null) {
    throw createError({ statusCode: 400, message: 'Informe marca, modelo e ano.' })
  }

  const result = await suggestFipe(
    getFipeConfigFromEnv(),
    { brand, model, year },
    { limit },
  )

  if (!result.ok) {
    throw createError({ statusCode: 422, message: result.reason })
  }

  return {
    query: { brand, model, year },
    suggestions: result.data.suggestions,
  }
})

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function readYear(value: unknown): number | null {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 1900 || parsed > 2100) return null
  return Math.floor(parsed)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
