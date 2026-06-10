import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { evaluateVehicleDisplayRules } from '#shared/utils/vehicle-display-rules'
import { FilterModel } from '../../utils/schemas/filter'
import { VehicleModel } from '../../utils/schemas/vehicle'

type SortOption =
  | 'recommended'
  | 'recent'
  | 'distance_pr'
  | 'small_damage'
  | 'price_asc'
  | 'price_desc'
  | 'year_desc'
  | 'fipe_asc'
  | 'km_asc'

function buildSort(opt: SortOption): Record<string, 1 | -1> {
  // _photoPriority keeps vehicles without photos at the end for all ordering modes.
  switch (opt) {
    case 'recent':       return { _priority: 1, _photoPriority: 1, scrapedAt: -1 }
    case 'distance_pr':  return { _priority: 1, _photoPriority: 1, _statePriority: 1, scrapedAt: -1, _fipePct: 1 }
    case 'small_damage': return { _priority: 1, _photoPriority: 1, _damagePriority: 1, scrapedAt: -1, _fipePct: 1 }
    case 'price_asc':    return { _priority: 1, _photoPriority: 1, price: 1, scrapedAt: -1 }
    case 'price_desc':   return { _priority: 1, _photoPriority: 1, price: -1, scrapedAt: -1 }
    case 'year_desc':    return { _priority: 1, _photoPriority: 1, year: -1, scrapedAt: -1 }
    case 'fipe_asc':     return { _priority: 1, _photoPriority: 1, _fipePct: 1, scrapedAt: -1 }
    case 'km_asc':       return { _priority: 1, _photoPriority: 1, _km: 1, scrapedAt: -1 }
    default:
      return {
        _priority: 1,
        _photoPriority: 1,
        scrapedAt: -1,
        _statePriority: 1,
        _damagePriority: 1,
        _fipePct: 1,
      }
  }
}

export default defineEventHandler(async (event) => {
  useDb()

  const query = getQuery(event)
  const page = Math.max(1, parseInt(String(query['page'] ?? '1'), 10))
  const limit = Math.min(200, Math.max(1, parseInt(String(query['limit'] ?? '50'), 10)))
  const skip = (page - 1) * limit
  const sort = (query['sort'] as SortOption | undefined) ?? 'recommended'

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
  const applyDisplayRules = query['rules'] !== 'false'

  const statesParam = query['states'] as string | undefined
  const citiesParam = query['cities'] as string | undefined
  const filterStates = statesParam ? statesParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const filterCities = citiesParam ? citiesParam.split(',').map(c => c.trim()).filter(Boolean) : []

  // Inclui enviados para manter histórico visível na lista.
  const filter: Record<string, unknown> = { status: { $in: ['scraped', 'sent', 'favorite'] } }

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
  const searchableDamageText = {
    $toLower: {
      $concat: [
        { $ifNull: ['$damage', ''] },
        ' ',
        { $ifNull: ['$title', ''] },
        ' ',
        { $ifNull: ['$description', ''] },
      ],
    },
  }

  const addFields = {
    _priority: { $cond: [{ $eq: ['$status', 'favorite'] }, 0, 1] },
    _photoPriority: {
      $cond: [
        { $gt: [{ $size: { $ifNull: ['$imageUrls', []] } }, 0] },
        0,
        1,
      ],
    },
    _statePriority: {
      $cond: [
        { $eq: [{ $toUpper: { $ifNull: ['$state', ''] } }, 'PR'] },
        0,
        1,
      ],
    },
    _damagePriority: {
      $cond: [
        { $regexMatch: { input: searchableDamageText, regex: /pequena/ } },
        0,
        1,
      ],
    },
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

  const filtersDoc = await FilterModel.findOne().lean()
  const comboRules = filtersDoc?.comboRules ?? []

  const docs = (await VehicleModel.aggregate([
    { $match: filter },
    { $addFields: addFields },
    { $sort: buildSort(sort) },
  ])) as Record<string, unknown>[]

  const evaluatedVehicles = docs.map((doc) => {
    const vehicle = {
      ...doc,
      _id: String(doc['_id']),
    } as VehicleRecord

    return {
      ...vehicle,
      displayRule: evaluateVehicleDisplayRules(vehicle, comboRules),
    }
  })

  const visibleVehicles = applyDisplayRules
    ? evaluatedVehicles.filter(vehicle => vehicle.displayRule.passes)
    : evaluatedVehicles

  const total = visibleVehicles.length
  const vehicles = visibleVehicles.slice(skip, skip + limit)
  const hiddenByRules = evaluatedVehicles.filter(vehicle => !vehicle.displayRule.passes).length

  return {
    vehicles,
    total,
    page,
    limit,
    rules: {
      enabled: applyDisplayRules,
      active: comboRules.filter(rule => rule.enabled).length,
      hidden: hiddenByRules,
    },
  }
})
