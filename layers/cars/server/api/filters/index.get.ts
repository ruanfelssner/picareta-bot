import type { AuctionFilters } from '#shared/types/filters'
import { FilterModel } from '../../utils/schemas/filter'

const DEFAULT_FILTERS: Omit<AuctionFilters, 'updatedAt'> = {
  states: ['PR', 'SC', 'SP', 'RS'],
  cities: [],
  comboRules: [],
}

export default defineEventHandler(async () => {
  useDb()

  let doc = await FilterModel.findOne().lean()

  if (!doc) {
    const created = await FilterModel.create({ ...DEFAULT_FILTERS, updatedAt: new Date() })
    doc = created.toObject()
  }

  const filters: AuctionFilters = {
    states: doc.states,
    cities: doc.cities,
    comboRules: doc.comboRules,
    updatedAt: doc.updatedAt,
  }

  return { filters }
})
