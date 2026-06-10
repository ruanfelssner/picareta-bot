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
    doc = await FilterModel.create({ ...DEFAULT_FILTERS, updatedAt: new Date() })
    doc = doc.toObject?.() ?? doc
  }

  const filters: AuctionFilters = {
    ...(doc as unknown as AuctionFilters),
    updatedAt: (doc as Record<string, unknown>)['updatedAt'] as Date,
  }

  return { filters }
})
