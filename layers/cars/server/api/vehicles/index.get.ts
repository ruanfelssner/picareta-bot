import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { VehicleModel } from '../../utils/schemas/vehicle'

type SortOption = 'recent' | 'price_asc' | 'price_desc' | 'year_desc' | 'fipe_asc' | 'km_asc'

function buildSort(opt: SortOption): Record<string, 1 | -1> {
  // _priority: 0 = favorite (pinned top), 1 = scraped
  switch (opt) {
    case 'price_asc':  return { _priority: 1, price: 1 }
    case 'price_desc': return { _priority: 1, price: -1 }
    case 'year_desc':  return { _priority: 1, year: -1 }
    case 'fipe_asc':   return { _priority: 1, _fipePct: 1 }
    case 'km_asc':     return { _priority: 1, _km: 1 }
    default:           return { _priority: 1, scrapedAt: -1 }
  }
}

export default defineEventHandler(async (event) => {
  useDb()

  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10))
  const limit = Math.min(200, Math.max(1, parseInt(String(query['limit'] ?? '50'), 10)))
  const skip = (page - 1) * limit
  const sort = (query['sort'] as SortOption | undefined) ?? 'recent'

  const sourcesParam = query['sources'] as string | undefined
  const sourceParam = query['source'] as VehicleSource | undefined
  const sources: VehicleSource[] = sourcesParam
    ? (sourcesParam.split(',').map(s => s.trim()).filter(Boolean) as VehicleSource[])
    : sourceParam ? [sourceParam] : []

  const search = (query['search'] as string | undefined)?.trim()
  const minPrice = query['minPrice'] ? Number(query['minPrice']) : null
  const maxPrice = query['maxPrice'] ? Number(query['maxPrice']) : null
  const minYear = query['minYear'] ? Number(query['minYear']) : null
  const maxYear = query['maxYear'] ? Number(query['maxYear']) : null
  const hasFipe = query['hasFipe'] === 'true'
  const maxFipePct = query['maxFipePct'] ? Number(query['maxFipePct']) : null

  const statesParam = query['states'] as string | undefined
  const citiesParam = query['cities'] as string | undefined
  const filterStates = statesParam ? statesParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const filterCities = citiesParam ? citiesParam.split(',').map(c => c.trim()).filter(Boolean) : []

  // Inclui 'scraped' e 'favorite'; favoritos serão priorizados via _priority
  const filter: Record<string, unknown> = { status: { $in: ['scraped', 'favorite'] } }

  if (sources.length > 0)
    filter['source'] = sources.length === 1 ? sources[0] : { $in: sources }

  if (search)
    filter['$or'] = [
      { brand: { $regex: search, $options: 'i' } },
      { model: { $regex: search, $options: 'i' } },
      { title: { $regex: search, $options: 'i' } },
    ]

  const priceFilter: Record<string, number> = {}
  if (minPrice != null && !Number.isNaN(minPrice)) priceFilter['$gte'] = minPrice
  if (maxPrice != null && !Number.isNaN(maxPrice)) priceFilter['$lte'] = maxPrice
  if (Object.keys(priceFilter).length > 0) filter['price'] = priceFilter

  const yearFilter: Record<string, number> = {}
  if (minYear != null && !Number.isNaN(minYear)) yearFilter['$gte'] = minYear
  if (maxYear != null && !Number.isNaN(maxYear)) yearFilter['$lte'] = maxYear
  if (Object.keys(yearFilter).length > 0) filter['year'] = yearFilter

  if (maxFipePct != null && !Number.isNaN(maxFipePct)) {
    filter['fipe'] = { $ne: null, $gt: 0 }
    filter['price'] = { ...(filter['price'] as object ?? {}), $ne: null }
    filter['$expr'] = { $lte: ['$price', { $multiply: ['$fipe', maxFipePct / 100] }] }
  }
  else if (hasFipe) {
    filter['fipe'] = { $ne: null }
  }

  if (filterStates.length > 0) filter['state'] = { $in: filterStates }

  if (filterCities.length > 0) {
    filter['city'] = { $in: filterCities.map(c => new RegExp(c, 'i')) }
  }

  // Campos computados para ordenação
  const addFields = {
    _priority: { $cond: [{ $eq: ['$status', 'favorite'] }, 0, 1] },
    // ratio price/fipe para ordenar por melhor negócio; null → 999 (vai pro final)
    _fipePct: {
      $cond: [
        { $and: [{ $ne: ['$fipe', null] }, { $gt: ['$fipe', 0] }, { $ne: ['$price', null] }] },
        { $divide: ['$price', '$fipe'] },
        999,
      ],
    },
    // km numérico para ordenação; strips "." separador de milhar e " km"
    _km: {
      $convert: {
        input: {
          $trim: {
            input: {
              $replaceAll: {
                input: {
                  $replaceAll: {
                    input: { $toLower: { $ifNull: ['$km', '9999999'] } },
                    find: '.', replacement: '',
                  },
                },
                find: 'km', replacement: '',
              },
            },
          },
        },
        to: 'long',
        onError: 9999999,
        onNull: 9999999,
      },
    },
  }

  const [result] = await VehicleModel.aggregate([
    { $match: filter },
    { $addFields: addFields },
    {
      $facet: {
        data: [{ $sort: buildSort(sort) }, { $skip: skip }, { $limit: limit }],
        meta: [{ $count: 'total' }],
      },
    },
  ])

  const docs = (result?.data ?? []) as Record<string, unknown>[]
  const total = ((result?.meta as { total: number }[] | undefined)?.[0]?.total ?? 0)

  const vehicles: VehicleRecord[] = docs.map(doc => ({
    ...doc,
    _id: String(doc['_id']),
  })) as VehicleRecord[]

  return { vehicles, total, page, limit }
})
