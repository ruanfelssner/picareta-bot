import type { VehicleRecord, VehicleSaleStatus } from '#shared/types/vehicle'
import { buildExternalId } from '#shared/utils/hash'
import { normalizeDamage } from '#shared/utils/damage'
import { assertLiveAuctionExtensionAuthorized } from '../../utils/live-auction-extension-auth'
import { VehicleModel } from '../../utils/schemas/vehicle'
import { syncVehicleToPicareta } from '../../utils/picareta-sync'

type RecaptureDocument = Omit<VehicleRecord, '_id'> & { _id: unknown }

const MAX_TEXT_LENGTH = 5_000
const COPART_SOURCE = 'copart'

export default defineEventHandler(async event => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)

  const input = await readBody<unknown>(event)
  if (!isRecord(input)) {
    throw createError({ statusCode: 400, message: 'Dados do lote inválidos.' })
  }

  const code = text(input['code']) ?? findCopartLotCode(text(input['vehicleUrl']))
  const url = buildCopartUrl(text(input['vehicleUrl']), code)
  if (!url || !code) {
    throw createError({ statusCode: 400, message: 'A recaptura precisa da URL ou do código do lote Copart.' })
  }

  const externalId = await buildExternalId(COPART_SOURCE, url)
  const existing = await VehicleModel.findOne({
    source: COPART_SOURCE,
    $or: [
      { url },
      { externalId },
      { url: new RegExp(`/lot/${escapeRegExp(code)}(?:[/?#]|$)`, 'i') },
    ],
  }).sort({ createdAt: 1, _id: 1 }).lean()

  if (!existing) {
    throw createError({
      statusCode: 404,
      message: `Lote Copart ${code} não foi encontrado na base para atualização.`,
    })
  }

  const update = buildRecaptureUpdate(input, existing as unknown as RecaptureDocument, url, code)
  if (Object.keys(update).length === 0) {
    throw createError({ statusCode: 422, message: 'Nenhuma informação nova foi encontrada na página do lote.' })
  }

  await VehicleModel.updateOne({ _id: existing._id }, { $set: update })
  const updated = await VehicleModel.findById(existing._id).lean()
  if (!updated) {
    throw createError({ statusCode: 500, message: 'Lote atualizado, mas não foi possível relê-lo.' })
  }

  let picaretaSynced = true
  try {
    await syncVehicleToPicareta(updated)
  } catch (error) {
    picaretaSynced = false
    console.error('[live-auction-recapture] falha ao sincronizar com Picareta', {
      code,
      externalId: String(updated.externalId ?? externalId),
      error: error instanceof Error ? error.message : String(error),
    })
  }

  console.info('[live-auction-recapture] atualizado', {
    at: new Date().toISOString(),
    code,
    url: updated.url,
    fields: Object.keys(update),
    saleStatus: updated.saleStatus ?? 'unknown',
    consignor: updated.consignor ?? null,
    picaretaSynced,
  })

  return {
    ok: true,
    code,
    updated: true,
    fields: Object.keys(update),
    picaretaSynced,
    vehicle: {
      _id: String(updated._id),
      url: updated.url,
      brand: updated.brand,
      model: updated.model,
      saleStatus: updated.saleStatus,
      consignor: updated.consignor ?? null,
      condition: updated.condition ?? null,
      category: (updated as unknown as Record<string, unknown>).category ?? null,
    },
  }
})

function buildRecaptureUpdate(
  input: Record<string, unknown>,
  existing: RecaptureDocument,
  url: string,
  code: string,
): Record<string, unknown> {
  const update: Record<string, unknown> = {
    collectedVia: 'extension',
  }
  const now = new Date()

  setText(update, input, 'brand')
  setText(update, input, 'model')
  setText(update, input, 'description')
  setText(update, input, 'version')
  setText(update, input, 'category')
  setText(update, input, 'condition')
  setText(update, input, 'yard')
  setText(update, input, 'consignor')
  setText(update, input, 'lot')
  setText(update, input, 'priceRaw')
  setText(update, input, 'fipeRaw')

  const description = text(input['description'])
  const version = text(input['version'])
  const category = text(input['category'])
  const brand = text(input['brand']) ?? existing.brand
  const model = text(input['model']) ?? existing.model
  const baseDescription = description ?? existing.description
  if (description) update.title = description
  else if (text(input['brand']) || text(input['model'])) update.title = [brand, model].filter(Boolean).join(' ')
  if (description || version || category) {
    update.description = [baseDescription, version ? `Versão: ${version}` : null, category ? `Categoria: ${category}` : null]
      .filter(Boolean)
      .join(' | ')
  }

  const year = parseYear(text(input['yearModel']))
  if (year != null) update.year = year

  const price = numberOrNull(input['bid']) ?? parseMoney(text(input['bidRaw']))
  if (price != null) {
    update.price = price
    if (saleStatus(input) === 'sold') {
      update.soldPrice = price
      update.soldPriceRaw = text(input['bidRaw']) ?? null
    }
  }

  const fipe = numberOrNull(input['fipe']) ?? parseMoney(text(input['fipeRaw']))
  if (fipe != null) {
    update.fipe = fipe
    update.fipeCheckedAt = now
  }

  const imageUrl = text(input['imageUrl'])
  if (imageUrl) update.imageUrls = [imageUrl]

  update.url = existing.url || url
  update.lot = text(input['lot']) ?? existing.lot ?? code

  const yard = text(input['yard'])
  if (yard) {
    update.location = yard
    const location = parseLocation(yard)
    if (location.city) update.city = location.city
    if (location.state) update.state = location.state
  }

  const status = saleStatus(input)
  if (status !== 'unknown') {
    update.saleStatus = status
    update.saleStatusRaw = text(input['message']) ?? status
    update.saleStatusCheckedAt = now
    update.auctionStatus = 'finished'
    update.auctionStatusRaw = text(input['message']) ?? status
    update.auctionStatusCheckedAt = now

    if (status === 'sold' && (existing.saleStatus === 'conditional' || existing.conditionalStatus === 'pending')) {
      update.conditionalStatus = 'approved'
      update.conditionalStatusRaw = text(input['message']) ?? 'Venda finalizada na recaptura manual'
      update.conditionalStatusCheckedAt = now
    }
  }

  const normalizedDamage = normalizeDamage(text(input['damage']))
  if (normalizedDamage) update.damage = normalizedDamage

  return removeEmptyUpdates(update)
}

function saleStatus(input: Record<string, unknown>): VehicleSaleStatus {
  const value = normalizeForMatch([text(input['saleStatus']), text(input['message'])].filter(Boolean).join(' '))
  if (value.includes('NAO VENDIDO') || value.includes('NAO FOI VENDIDO')) return 'not_sold'
  if (value.includes('VENDIDO') || value.includes('ARREMATADO') || value.includes('VENDA FINALIZADA') || value.includes('LEILAO FINALIZADO')) return 'sold'
  if (value.includes('CONDICIONAL')) return 'conditional'
  if (input['saleStatus'] === 'conditional') return 'conditional'
  if (input['saleStatus'] === 'not_sold') return 'not_sold'
  if (input['saleStatus'] === 'sold') return 'sold'
  return 'unknown'
}

function buildCopartUrl(value: string | null, code: string | null): string | null {
  const pageCode = findCopartLotCode(value)
  const normalizedCode = pageCode ?? code?.replace(/\D/g, '') ?? null
  return normalizedCode ? `https://www.copart.com.br/lot/${normalizedCode}` : null
}

function findCopartLotCode(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.hostname.endsWith('copart.com.br') || url.hostname.endsWith('copart.com')
      ? url.pathname.match(/\/lot\/(\d+)/i)?.[1] ?? null
      : null
  } catch {
    return value.match(/\/lot\/(\d+)/i)?.[1] ?? null
  }
}

function setText(update: Record<string, unknown>, input: Record<string, unknown>, field: string): void {
  const value = text(input[field])
  if (value) update[field] = value.slice(0, MAX_TEXT_LENGTH)
}

function removeEmptyUpdates(update: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(update).filter(([, value]) => value !== null && value !== undefined && value !== ''))
}

function parseYear(value: string | null): number | null {
  const match = value?.match(/\b(?:19|20)\d{2}\b/g)
  if (!match?.length) return null
  const year = Number(match.at(-1))
  return year >= 1900 && year <= 2100 ? year : null
}

function parseMoney(value: string | null): number | null {
  if (!value) return null
  const match = value.match(/(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/)
  if (!match) return null
  const number = Number.parseFloat(match[1]!.replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(number) ? Math.round(number) : null
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null
  return parseMoney(text(value))
}

function parseLocation(value: string): { city: string | null, state: string | null } {
  const cityStateMatch = value.match(/^(.*?)\s*-\s*([A-Z]{2})$/i)
  if (cityStateMatch) {
    return {
      city: text(cityStateMatch[1]),
      state: cityStateMatch[2]?.toUpperCase() ?? null,
    }
  }

  const state = normalizeForMatch(value).match(/(?:^|[\s,/])([A-Z]{2})(?:$|[\s,.-])/i)?.[1]?.toUpperCase() ?? null
  return { city: value, state }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizeForMatch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/\s+/g, ' ').trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}
