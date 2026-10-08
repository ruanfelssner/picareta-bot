import { timingSafeEqual, createHash } from 'node:crypto'
import mongoose from 'mongoose'
import { applyFipeSelection, getFipeConfigFromEnv, suggestFipe } from '../../utils/fipe'

export default defineEventHandler(async (event) => {
  const expected = (process.env['SCRAPER_SERVICE_KEY'] ?? '').trim()
  const received = getRequestHeader(event, 'x-scraper-service-key') ?? ''
  if (!expected || !timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(received).digest())) {
    throw createError({ statusCode: 401, message: 'Chave do serviço inválida' })
  }
  const raw = await readBody<unknown>(event)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw createError({ statusCode: 400, message: 'Consulta FIPE inválida' })
  const body = raw as Record<string, unknown>
  const text = (key: string) => typeof body[key] === 'string' ? body[key].trim().slice(0, 180) : ''
  const action = text('action')
  const selection = { brandCode: text('brandCode'), brandName: text('brandName'), modelCode: text('modelCode'), modelName: text('modelName'), yearCode: text('yearCode'), yearName: text('yearName') }
  const query = { brand: text('brand'), model: text('model'), year: Number(body['year']) }
  if (action === 'suggestions' ? !query.brand || !query.model || !Number.isInteger(query.year) || query.year < 1900 || query.year > 2100 : action !== 'quote' || Object.values(selection).some(value => !value)) {
    throw createError({ statusCode: 400, message: 'Informe marca, modelo e ano ou uma seleção FIPE completa' })
  }
  const config = getFipeConfigFromEnv()
  if (!config.enabled) throw createError({ statusCode: 503, message: 'Consulta FIPE desabilitada' })
  useDb()
  // A referência mensal faz uma nova consulta ao mudar o mês, mesmo dentro do TTL.
  const key = createHash('sha256').update(JSON.stringify([config.baseUrl, config.vehicleType, config.reference ?? new Date().toISOString().slice(0, 7), action, action === 'suggestions' ? query : selection])).digest('hex')
  const cache = mongoose.connection.collection<{ key: string; value: Record<string, unknown>; expiresAt: Date }>('fipe_cache')
  const cached = await cache.findOne({ key, expiresAt: { $gt: new Date() } })
  if (cached) return cached.value
  const result = action === 'suggestions'
    ? await suggestFipe(config, query, { limit: 12 })
    : await applyFipeSelection(config, selection)
  if (!result.ok) throw createError({ statusCode: 422, message: result.reason })
  const value = result.data
  if ('price' in value && (value.price == null || !Number.isFinite(value.price) || value.price <= 0)) {
    throw createError({ statusCode: 422, message: 'Esta versão não possui valor FIPE disponível' })
  }
  await cache.updateOne({ key }, { $set: { key, value, expiresAt: new Date(Date.now() + 30 * 86400_000) } }, { upsert: true })
  return value
})
