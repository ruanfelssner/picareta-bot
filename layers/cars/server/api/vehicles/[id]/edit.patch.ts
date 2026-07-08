import type { VehicleRecord, VehicleSaleStatus } from '#shared/types/vehicle'
import { VehicleModel } from '../../../utils/schemas/vehicle'

const VALID_SALE_STATUSES: VehicleSaleStatus[] = ['unknown', 'sold', 'conditional', 'not_sold']

function readNullableNumber(body: Record<string, unknown>, field: string): number | null | undefined {
  if (!(field in body)) return undefined
  const value = body[field]
  if (value === null) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw createError({ statusCode: 400, message: `Campo "${field}" inválido` })
  }
  return parsed
}

function readSaleStatus(body: Record<string, unknown>): VehicleSaleStatus | undefined {
  if (!('saleStatus' in body)) return undefined
  const value = body['saleStatus']
  if (!VALID_SALE_STATUSES.includes(value as VehicleSaleStatus)) {
    throw createError({ statusCode: 400, message: 'Status de venda inválido' })
  }
  return value as VehicleSaleStatus
}

function readNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in body)) return undefined
  const value = body[field]
  if (value === null) return null
  if (typeof value !== 'string') {
    throw createError({ statusCode: 400, message: `Campo "${field}" inválido` })
  }
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function readNullableDate(body: Record<string, unknown>, field: string): Date | null | undefined {
  if (!(field in body)) return undefined
  const value = body[field]
  if (value === null) return null
  const date = new Date(value as string)
  if (Number.isNaN(date.getTime())) {
    throw createError({ statusCode: 400, message: `Campo "${field}" inválido` })
  }
  return date
}

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const rawBody = await readBody<unknown>(event).catch((): unknown => null)
  if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw createError({ statusCode: 400, message: 'Corpo inválido' })
  }

  const body = rawBody as Record<string, unknown>
  const price = readNullableNumber(body, 'price')
  const soldPrice = readNullableNumber(body, 'soldPrice')
  const fipe = readNullableNumber(body, 'fipe')
  const saleStatus = readSaleStatus(body)
  const damage = readNullableString(body, 'damage')
  const auctionDate = readNullableDate(body, 'auctionDate')

  if (
    price === undefined
    && soldPrice === undefined
    && fipe === undefined
    && saleStatus === undefined
    && damage === undefined
    && auctionDate === undefined
  ) {
    throw createError({ statusCode: 400, message: 'Nenhum campo para atualizar' })
  }

  const update: Record<string, unknown> = {}
  if (price !== undefined) update['price'] = price
  if (soldPrice !== undefined) {
    update['soldPrice'] = soldPrice
    update['soldPriceRaw'] = null
  }
  if (fipe !== undefined) {
    update['fipe'] = fipe
    update['fipeCheckedAt'] = new Date()
    update['fipeCode'] = null
    update['fipeReferenceMonth'] = null
    update['fipeFuel'] = null
    update['fipeBrandMatched'] = null
    update['fipeModelMatched'] = null
  }
  if (saleStatus !== undefined) {
    update['saleStatus'] = saleStatus
    update['saleStatusRaw'] = 'Manual'
    update['saleStatusCheckedAt'] = new Date()
  }
  if (damage !== undefined) update['damage'] = damage
  if (auctionDate !== undefined) update['auctionDate'] = auctionDate

  const updatedDoc = await VehicleModel.findByIdAndUpdate(
    id,
    { $set: update },
    { new: true, lean: true },
  )

  if (!updatedDoc) throw createError({ statusCode: 404, message: 'Veículo não encontrado' })

  return {
    vehicle: {
      ...updatedDoc,
      _id: String((updatedDoc as Record<string, unknown>)['_id']),
    } as VehicleRecord,
  }
})
