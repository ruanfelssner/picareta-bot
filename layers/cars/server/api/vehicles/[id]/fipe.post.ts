import type { FipeApplyInput } from '../../../utils/fipe'
import type { VehicleRecord } from '#shared/types/vehicle'
import { applyFipeSelection, getFipeConfigFromEnv } from '../../../utils/fipe'
import { VehicleModel } from '../../../utils/schemas/vehicle'

function readStringField(body: Record<string, unknown>, field: keyof FipeApplyInput): string | null {
  const value = body[field]
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export default defineEventHandler(async (event) => {
  useDb()

  const id = getRouterParam(event, 'id')
  if (!id) throw createError({ statusCode: 400, message: 'ID inválido' })

  const doc = await VehicleModel.findById(id).lean()
  if (!doc) throw createError({ statusCode: 404, message: 'Veículo não encontrado' })

  const rawBody = await readBody<unknown>(event).catch((): unknown => null)
  if (rawBody == null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw createError({ statusCode: 400, message: 'Seleção FIPE inválida' })
  }

  const body = rawBody as Record<string, unknown>
  const selection: FipeApplyInput = {
    brandCode: readStringField(body, 'brandCode') ?? '',
    brandName: readStringField(body, 'brandName') ?? '',
    modelCode: readStringField(body, 'modelCode') ?? '',
    modelName: readStringField(body, 'modelName') ?? '',
    yearCode: readStringField(body, 'yearCode') ?? '',
    yearName: readStringField(body, 'yearName') ?? '',
  }

  if (!selection.brandCode || !selection.brandName || !selection.modelCode || !selection.modelName || !selection.yearCode || !selection.yearName) {
    throw createError({ statusCode: 400, message: 'Seleção FIPE incompleta' })
  }

  const result = await applyFipeSelection(getFipeConfigFromEnv(), selection)
  if (!result.ok) {
    throw createError({ statusCode: 422, message: result.reason })
  }

  const update = {
    fipe: result.data.price,
    fipeCode: result.data.codeFipe,
    fipeReferenceMonth: result.data.referenceMonth,
    fipeFuel: result.data.fuel,
    fipeCheckedAt: new Date(),
    fipeBrandMatched: result.data.brandMatched,
    fipeModelMatched: result.data.modelMatched,
  } satisfies Partial<Omit<VehicleRecord, '_id'>>

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
