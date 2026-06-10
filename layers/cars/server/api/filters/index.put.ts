import type { AuctionFilters, AuctionComboRule } from '#shared/types/filters'
import { FilterModel } from '../../utils/schemas/filter'

interface PutBody {
  states?: string[]
  cities?: string[]
  comboRules?: AuctionComboRule[]
}

export default defineEventHandler(async (event) => {
  useDb()

  const body = await readBody<PutBody>(event)

  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (Array.isArray(body.states)) update['states'] = body.states
  if (Array.isArray(body.cities)) update['cities'] = body.cities
  if (Array.isArray(body.comboRules)) update['comboRules'] = body.comboRules

  const doc = await FilterModel.findOneAndUpdate(
    {},
    { $set: update },
    { upsert: true, new: true, lean: true },
  )

  const filters: AuctionFilters = doc as unknown as AuctionFilters

  return { filters }
})
