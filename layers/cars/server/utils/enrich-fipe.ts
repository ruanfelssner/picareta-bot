import { getFipeConfigFromEnv, lookupFipe } from './fipe'

const BATCH_SIZE = 4
const BATCH_DELAY_MS = 300

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export async function enrichVehiclesWithFipe(
  vehicleIds: string[],
  log: (msg: string) => void = () => {},
): Promise<void> {
  if (vehicleIds.length === 0) return

  const config = getFipeConfigFromEnv()
  if (!config.enabled) {
    log('[fipe] FIPE desabilitado — pulando enriquecimento.')
    return
  }

  log(`[fipe] Enriquecendo ${vehicleIds.length} veículo(s)...`)

  const docs = await VehicleModel.find({ _id: { $in: vehicleIds }, fipeCheckedAt: null }).lean()
  if (docs.length === 0) { log('[fipe] Nenhum veículo pendente de enriquecimento.'); return }

  let enriched = 0
  let failed = 0

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const batch = docs.slice(i, i + BATCH_SIZE)

    await Promise.all(batch.map(async (doc) => {
      const id = String((doc as Record<string, unknown>)['_id'])
      if (!doc.brand || !doc.model || doc.year == null) {
        await VehicleModel.findByIdAndUpdate(id, { $set: { fipeCheckedAt: new Date() } })
        failed++
        return
      }

      const result = await lookupFipe(config, { brand: doc.brand, model: doc.model, year: doc.year })

      if (result.ok) {
        await VehicleModel.findByIdAndUpdate(id, {
          $set: {
            fipe: result.data.price,
            fipeCode: result.data.codeFipe,
            fipeReferenceMonth: result.data.referenceMonth,
            fipeFuel: result.data.fuel,
            fipeBrandMatched: result.data.brandMatched,
            fipeModelMatched: result.data.modelMatched,
            fipeCheckedAt: new Date(),
          },
        })
        enriched++
        log(`[fipe] ✓ ${doc.brand} ${doc.model} ${doc.year} → R$ ${result.data.price?.toLocaleString('pt-BR') ?? '?'}`)
      }
      else {
        await VehicleModel.findByIdAndUpdate(id, { $set: { fipeCheckedAt: new Date() } })
        failed++
        log(`[fipe] ✗ ${doc.brand} ${doc.model} ${doc.year}: ${result.reason}`)
      }
    }))

    if (i + BATCH_SIZE < docs.length) await sleep(BATCH_DELAY_MS)
  }

  log(`[fipe] Concluído: ${enriched} enriquecido(s), ${failed} sem correspondência.`)
}
