import sharp from 'sharp'
import type { VehicleWithMarketAnalysis } from '#shared/types/market-analysis'
import { formatVehicleCaption } from './vehicle-formatter'

export interface ZApiConfig {
  baseUrl: string
  instanceId: string
  token: string
  clientToken: string
  phone: string
  maxImages: number
  delayMessage: number
  viewOnce: boolean
}

export interface ZApiSendResult {
  ok: boolean
  zapiResponse?: unknown
  reason?: string
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)))
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = parseInt(raw ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  return fallback
}

async function parseZApiResponse(res: Response): Promise<unknown> {
  const text = await res.text()
  if (!text.trim()) return null
  try { return JSON.parse(text) }
  catch { return text }
}

export function getZApiConfig(): ZApiConfig {
  const env = process.env
  const baseUrl = (env['ZAPI_BASE_URL'] ?? 'https://api.z-api.io').trim().replace(/\/$/, '')
  const instanceId = (env['ZAPI_INSTANCE_ID'] ?? env['Z_INSTANCE'] ?? '').trim()
  const token = (env['ZAPI_TOKEN'] ?? env['Z_TOKEN'] ?? '').trim()
  const clientToken = (env['ZAPI_CLIENT_TOKEN'] ?? env['Z_CLIENT_TOKEN'] ?? '').trim()
  const phone = (env['ZAPI_PHONE'] ?? env['Z_PHONE'] ?? '').trim()
  const maxImages = clampInt(parsePositiveInt(env['ZAPI_MAX_IMAGES'], 5), 1, 20)
  const delayMessage = clampInt(parsePositiveInt(env['ZAPI_DELAY_MESSAGE'], 2), 1, 15)
  const viewOnce = parseBoolean(env['ZAPI_VIEW_ONCE'], false)

  return { baseUrl, instanceId, token, clientToken, phone, maxImages, delayMessage, viewOnce }
}

export function validateZApiConfig(cfg: ZApiConfig): string | null {
  if (!cfg.instanceId || !cfg.token || !cfg.clientToken) {
    return 'Z-API: variáveis de ambiente obrigatórias ausentes (ZAPI_INSTANCE_ID / ZAPI_TOKEN / ZAPI_CLIENT_TOKEN)'
  }
  if (!cfg.phone) {
    return 'Z-API: destino não configurado (ZAPI_PHONE)'
  }
  return null
}

async function toGrayscaleDataUrl(imageUrl: string): Promise<string | null> {
  try {
    const res = await fetch(imageUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    if (!res.ok) return null
    const buffer = Buffer.from(await res.arrayBuffer())
    const grayscale = await sharp(buffer).grayscale().jpeg({ quality: 85 }).toBuffer()
    return `data:image/jpeg;base64,${grayscale.toString('base64')}`
  }
  catch {
    return null
  }
}

export async function sendVehicleToZApi(vehicle: VehicleWithMarketAnalysis): Promise<ZApiSendResult> {
  const cfg = getZApiConfig()
  const error = validateZApiConfig(cfg)
  if (error) return { ok: false, reason: error }

  const caption = formatVehicleCaption(vehicle)
  const rawImage = vehicle.imageUrls[0] ?? null
  const isFinished = vehicle.auctionStatus === 'finished'
  const image = (rawImage && isFinished)
    ? (await toGrayscaleDataUrl(rawImage)) ?? rawImage
    : rawImage

  const endpoint = image
    ? `${cfg.baseUrl}/instances/${encodeURIComponent(cfg.instanceId)}/token/${encodeURIComponent(cfg.token)}/send-image`
    : `${cfg.baseUrl}/instances/${encodeURIComponent(cfg.instanceId)}/token/${encodeURIComponent(cfg.token)}/send-text`

  const body = image
    ? { phone: cfg.phone, image, caption, delayMessage: cfg.delayMessage, viewOnce: cfg.viewOnce }
    : { phone: cfg.phone, message: caption, delayMessage: cfg.delayMessage }

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Client-Token': cfg.clientToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const zapiResponse = await parseZApiResponse(res)
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, zapiResponse }
    return { ok: true, zapiResponse }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}
