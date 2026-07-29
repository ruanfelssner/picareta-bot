import { appendFile, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'

type TextAuctionEvent = {
  savedAt: string
  source: string | null
  auctionId: string | null
  lot: string | null
  code: string | null
  description: string | null
  version: string | null
  yearModel: string | null
  brand: string | null
  model: string | null
  category: string | null
  fipe: number | null
  fipeRaw: string | null
  damage: string | null
  condition: string | null
  yard: string | null
  bid: number | null
  bidRaw: string | null
  saleStatus: string | null
  imageUrl: string | null
  vehicleUrl: string | null
  message: string | null
  observedAt: string
}

const MAX_BATCH_SIZE = 25
let appendQueue: Promise<void> = Promise.resolve()

export default defineEventHandler(async (event) => {
  const config = useRuntimeConfig()
  const expectedToken = getOptionalString(config.liveAuctionExtensionToken)
    ?? getOptionalString(process.env.LIVE_AUCTION_EXTENSION_TOKEN)
    ?? getOptionalString(config.copartExtensionToken)
    ?? getOptionalString(process.env.COPART_EXTENSION_TOKEN)

  if (expectedToken) {
    const providedToken = getHeader(event, 'x-live-auction-extension-token')?.trim()
      ?? getHeader(event, 'x-copart-extension-token')?.trim()
    if (providedToken !== expectedToken) {
      throw createError({
        statusCode: 401,
        statusMessage: 'Unauthorized',
        message: 'Token da extensao de leilao invalido.',
      })
    }
  }

  const body = await readBody<unknown>(event)
  const rawItems = getInputArray(body)
  const events = rawItems
    .slice(0, MAX_BATCH_SIZE)
    .map(normalizeEvent)
    .filter((item): item is TextAuctionEvent => item != null)

  if (events.length === 0) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Bad Request',
      message: 'Nenhum evento valido recebido para o arquivo de texto.',
    })
  }

  const filePath = getTextFilePath(config.liveAuctionTextFile)
  const content = events.map(formatEvent).join('\n\n') + '\n\n'
  await enqueueAppend(filePath, content)

  console.info('[live-auction-text] salvo', {
    at: new Date().toISOString(),
    file: filePath,
    accepted: events.length,
  })

  return {
    ok: true,
    received: rawItems.length,
    accepted: events.length,
    file: basename(filePath),
  }
})

function getInputArray(body: unknown): unknown[] {
  if (Array.isArray(body)) return body
  if (isRecord(body) && Array.isArray(body['events'])) return body['events']
  if (isRecord(body)) return [body]
  return []
}

function normalizeEvent(value: unknown): TextAuctionEvent | null {
  if (!isRecord(value)) return null

  const observedAt = toDateString(value['observedAt']) ?? new Date().toISOString()
  return {
    savedAt: new Date().toISOString(),
    source: normalizeText(value['source']),
    auctionId: normalizeText(value['auctionId']),
    lot: normalizeText(value['lot']),
    code: normalizeText(value['code']),
    description: normalizeText(value['description']),
    version: normalizeText(value['version']),
    yearModel: normalizeText(value['yearModel']),
    brand: normalizeText(value['brand']),
    model: normalizeText(value['model']),
    category: normalizeText(value['category']),
    fipe: toNumber(value['fipe']) ?? toNumber(value['fipeRaw']),
    fipeRaw: normalizeText(value['fipeRaw']),
    damage: normalizeText(value['damage']),
    condition: normalizeText(value['condition']),
    yard: normalizeText(value['yard']),
    bid: toNumber(value['bid']) ?? toNumber(value['bidRaw']),
    bidRaw: normalizeText(value['bidRaw']),
    saleStatus: normalizeText(value['saleStatus']),
    imageUrl: normalizeText(value['imageUrl']),
    vehicleUrl: normalizeText(value['vehicleUrl']),
    message: normalizeText(value['message']),
    observedAt,
  }
}

function formatEvent(event: TextAuctionEvent): string {
  const title = [event.brand, event.model, event.yearModel].filter(Boolean).join(' ') || 'Veiculo sem identificacao'
  const lines = [
    '============================================================',
    `Coletado em: ${event.savedAt}`,
    `Veiculo: ${title}`,
    `Fonte: ${event.source ?? '-'}`,
    `Leilao: ${event.auctionId ?? '-'} | Lote: ${event.lot ?? '-'} | Codigo: ${event.code ?? '-'}`,
    `Status: ${event.saleStatus ?? '-'} | Lance: ${event.bidRaw ?? '-'} | FIPE: ${event.fipeRaw ?? '-'}`,
    `Categoria: ${event.category ?? '-'} | Monta: ${event.damage ?? '-'} | Patio: ${event.yard ?? '-'}`,
    `URL: ${event.vehicleUrl ?? '-'}`,
    `Observado em: ${event.observedAt}`,
    `Mensagem: ${event.message ?? '-'}`,
    'Dados completos:',
    JSON.stringify(event, null, 2),
    '============================================================',
  ]

  return lines.join('\n')
}

async function enqueueAppend(filePath: string, content: string): Promise<void> {
  const next = appendQueue.then(async () => {
    await mkdir(dirname(filePath), { recursive: true })
    await appendFile(filePath, content, 'utf8')
  })

  appendQueue = next.catch(() => undefined)
  await next
}

function getTextFilePath(configuredPath: unknown): string {
  const configured = getOptionalString(configuredPath)
  if (configured) return isAbsolute(configured) ? configured : resolve(process.cwd(), configured)

  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  return resolve(process.cwd(), 'data', `live-auction-${date}.txt`)
}

function toDateString(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value !== 'string') return null

  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  if (typeof value !== 'string') return null

  const match = value.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/)
  if (!match) return null

  const parsed = Number.parseFloat(match[1]!.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(parsed) ? Math.round(parsed) : null
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null

  const text = value.replace(/\s+/g, ' ').trim()
  return text || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function getOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}
