import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { ACTIVE_AUCTION_SOURCES } from '#shared/constants/sources'
import { firstUsableVehicleImageUrl, isUsableVehicleImageUrl } from '#shared/utils/vehicle-images'
import { evaluateVehicleDisplayRules } from '#shared/utils/vehicle-display-rules'
import { withEffectiveAuctionLifecycle } from '../../utils/auction-lifecycle'
import { FilterModel } from '../../utils/schemas/filter'
import { VehicleModel } from '../../utils/schemas/vehicle'

type SortOption =
  | 'recommended'
  | 'auction_date'
  | 'recent'
  | 'distance_pr'
  | 'small_damage'
  | 'price_asc'
  | 'price_desc'
  | 'year_desc'
  | 'fipe_asc'
  | 'km_asc'

type DamageLevel = 'small' | 'medium' | 'normal'
type PeriodFilter = 'upcoming' | 'today' | 'tomorrow' | 'past' | 'all'
type FipeFilter = 'all' | 'with' | 'without'
type SaleStatusLevel = 'available' | 'conditional' | 'sold'

const SALE_STATUS_MAP: Record<SaleStatusLevel, string> = {
  available: 'unknown',
  conditional: 'conditional',
  sold: 'sold',
}

function isDamageLevel(value: string): value is DamageLevel {
  return value === 'small' || value === 'medium' || value === 'normal'
}

function isFipeFilter(value: unknown): value is FipeFilter {
  return value === 'all' || value === 'with' || value === 'without'
}

function isSaleStatusLevel(value: string): value is SaleStatusLevel {
  return value === 'available' || value === 'conditional' || value === 'sold'
}

function isPeriodFilter(value: unknown): value is PeriodFilter {
  return value === 'upcoming' || value === 'today' || value === 'tomorrow' || value === 'past' || value === 'all'
}

function startOfLocalDay(offsetDays = 0): Date {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date
}

function buildSort(opt: SortOption, period?: PeriodFilter): Record<string, 1 | -1> {
  // Computed priorities keep missing auction dates/photos after complete records.
  // For past period, sort auctionDate descending (most recent first).
  const auctionDateDir: 1 | -1 = period === 'past' ? -1 : 1
  switch (opt) {
    case 'auction_date': return { _priority: 1, _auctionDatePriority: 1, auctionDate: auctionDateDir, _photoPriority: 1, scrapedAt: -1 }
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
        _auctionDatePriority: 1,
        auctionDate: auctionDateDir,
        _photoPriority: 1,
        scrapedAt: -1,
        _statePriority: 1,
        _damagePriority: 1,
        _fipePct: 1,
      }
  }
}

function extractVsVehicleId(url: string): string | null {
  const match = url.match(/\/id-(\d+)(?:[/?#]|$)/)
  return match?.[1] ?? null
}

function getVsDuplicateKey(vehicle: VehicleRecord): string | null {
  if (vehicle.source !== 'vs-veiculos') return null

  const imageUrl = firstUsableVehicleImageUrl(vehicle.imageUrls)
  if (imageUrl) return `vs:image:${imageUrl}`

  const lot = vehicle.lot?.trim()
  if (lot) return `vs:lot:${lot}`

  const vsId = extractVsVehicleId(vehicle.url)
  return vsId ? `vs:id:${vsId}` : null
}

function getStatusRank(status: VehicleRecord['status']): number {
  if (status === 'favorite') return 0
  if (status === 'sent') return 1
  return 2
}

function shouldReplaceDuplicateKeeper(current: VehicleRecord, candidate: VehicleRecord): boolean {
  const currentStatusRank = getStatusRank(current.status)
  const candidateStatusRank = getStatusRank(candidate.status)
  if (candidateStatusRank !== currentStatusRank) return candidateStatusRank < currentStatusRank

  const currentHasPrice = current.price != null
  const candidateHasPrice = candidate.price != null
  if (candidateHasPrice !== currentHasPrice) return candidateHasPrice

  return new Date(candidate.scrapedAt).getTime() > new Date(current.scrapedAt).getTime()
}

function dedupeDisplayVehicles<T extends VehicleRecord>(vehicles: T[]): T[] {
  const keeperByKey = new Map<string, T>()

  for (const vehicle of vehicles) {
    const key = getVsDuplicateKey(vehicle)
    if (!key) continue

    const current = keeperByKey.get(key)
    if (!current || shouldReplaceDuplicateKeeper(current, vehicle)) {
      keeperByKey.set(key, vehicle)
    }
  }

  return vehicles.filter((vehicle) => {
    const key = getVsDuplicateKey(vehicle)
    if (!key) return true
    return keeperByKey.get(key)?._id === vehicle._id
  })
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
  const activeSources = sources.length > 0
    ? sources.filter(source => ACTIVE_AUCTION_SOURCES.includes(source))
    : ACTIVE_AUCTION_SOURCES

  const search = (query['search'] as string | undefined)?.trim()
  const minPrice = query['minPrice'] ? Number(query['minPrice']) : null
  const maxPrice = query['maxPrice'] ? Number(query['maxPrice']) : null
  const minYear = query['minYear'] ? Number(query['minYear']) : null
  const maxYear = query['maxYear'] ? Number(query['maxYear']) : null
  const fipeFilterParam = query['fipeFilter']
  const fipeFilter: FipeFilter = isFipeFilter(fipeFilterParam) ? fipeFilterParam : (query['hasFipe'] === 'true' ? 'with' : 'all')
  const maxFipePct = query['maxFipePct'] ? Number(query['maxFipePct']) : null
  const saleStatusParam = query['saleStatus'] as string | undefined
  const saleStatusLevels = saleStatusParam
    ? saleStatusParam.split(',').map(value => value.trim()).filter(isSaleStatusLevel)
    : []
  const applyDisplayRules = query['rules'] !== 'false'

  const statesParam = query['states'] as string | undefined
  const citiesParam = query['cities'] as string | undefined
  const filterStates = statesParam ? statesParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const filterCities = citiesParam ? citiesParam.split(',').map(c => c.trim()).filter(Boolean) : []
  const legacyTodayOnly = query['today'] === 'true'
  const legacyShowPast = query['showPast'] === 'true'
  const periodParam = query['period']
  const period: PeriodFilter = isPeriodFilter(periodParam)
    ? periodParam
    : legacyTodayOnly
      ? 'today'
      : legacyShowPast
        ? 'past'
        : 'upcoming'
  const damageLevelsParam = query['damageLevels'] as string | undefined
  const damageLevels = damageLevelsParam
    ? damageLevelsParam.split(',').map(value => value.trim()).filter(isDamageLevel)
    : []
  const showNoPhoto = query['showNoPhoto'] !== 'false'

  // Inclui enviados para manter histórico visível na lista.
  const filter: Record<string, unknown> = {
    status: { $in: ['scraped', 'sent', 'favorite'] },
    source: { $in: activeSources },
  }

  // Conditions that use $or internally are collected into $and to avoid conflicts
  const andClauses: object[] = []
  const todayStart = startOfLocalDay()
  const tomorrowStart = startOfLocalDay(1)
  const dayAfterTomorrowStart = startOfLocalDay(2)
  const saleStatusMapped = saleStatusLevels.map(level => SALE_STATUS_MAP[level])
  const finalizedStatusesToExclude = ['sold', 'conditional', 'not_sold']
    .filter(status => saleStatusLevels.length === 0 || !saleStatusMapped.includes(status))
  const activeAuctionClause = {
    auctionStatus: { $ne: 'finished' },
    ...(finalizedStatusesToExclude.length > 0 ? { saleStatus: { $nin: finalizedStatusesToExclude } } : {}),
  }
  const largeDamageRegex = /(?:grande\s+monta|sucata|perda\s+total|irrecuper[aá]vel|recupera[cç][aã]o\s+imposs[ií]vel)/i

  andClauses.push({
    $nor: [
      { damage: largeDamageRegex },
      { title: largeDamageRegex },
      { description: largeDamageRegex },
    ],
  })

  if (period === 'upcoming') {
    andClauses.push({
      ...activeAuctionClause,
      auctionDate: { $gte: todayStart, $lt: dayAfterTomorrowStart },
    })
  }
  else if (period === 'today') {
    andClauses.push({
      ...activeAuctionClause,
      auctionDate: { $gte: todayStart, $lt: tomorrowStart },
    })
  }
  else if (period === 'tomorrow') {
    andClauses.push({
      ...activeAuctionClause,
      auctionDate: { $gte: tomorrowStart, $lt: dayAfterTomorrowStart },
    })
  }
  else if (period === 'past') {
    andClauses.push({
      $or: [
        { auctionStatus: 'finished' },
        { saleStatus: { $in: ['sold', 'conditional', 'not_sold'] } },
        {
          auctionStatus: { $ne: 'future' },
          auctionDate: { $lt: todayStart },
        },
      ],
    })
  }
  else if (period === 'all') {
    andClauses.push({
      ...activeAuctionClause,
      $or: [
        { auctionStatus: 'future' },
        { auctionDate: null },
        { auctionDate: { $gte: todayStart } },
      ],
    })
  }

  if (damageLevels.length > 0) {
    const damageClauses: object[] = []
    const classifiedPatterns = damageLevels
      .filter(level => level !== 'normal')
      .map(level => level === 'small' ? 'pequena' : 'm[eé]dia')

    if (classifiedPatterns.length > 0) {
      const damageRegex = new RegExp(`(?:${classifiedPatterns.join('|')})\\s+monta`, 'i')
      damageClauses.push(
        { damage: damageRegex },
        { title: damageRegex },
        { description: damageRegex },
      )
    }

    if (damageLevels.includes('normal')) {
      const anyMontaRegex = /(?:pequena|m[eé]dia|grande)\s+monta/i
      damageClauses.push({ $nor: [
        { damage: anyMontaRegex },
        { title: anyMontaRegex },
        { description: anyMontaRegex },
      ] })
    }

    andClauses.push({ $or: damageClauses })
  }

  const usableImageCountExpr = {
    $size: {
      $filter: {
        input: { $ifNull: ['$imageUrls', []] },
        as: 'imageUrl',
        cond: {
          $and: [
            { $ne: ['$$imageUrl', ''] },
            { $not: [{ $regexMatch: { input: '$$imageUrl', regex: /\/fotos\/indisp\/|\/_indisp\.|\/foto_em_breve\.|imagem-n-disponivel/i } }] },
          ],
        },
      },
    },
  }

  if (!showNoPhoto) {
    andClauses.push({ $or: [
      { status: { $in: ['sent', 'favorite'] } },
      { $expr: { $gt: [usableImageCountExpr, 0] } },
    ] })
  }

  if (search) {
    andClauses.push({ $or: [
      { brand: { $regex: search, $options: 'i' } },
      { model: { $regex: search, $options: 'i' } },
      { title: { $regex: search, $options: 'i' } },
    ] })
  }

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
  else if (fipeFilter === 'with') {
    filter['fipe'] = { $ne: null }
  }
  else if (fipeFilter === 'without') {
    filter['fipe'] = null
  }

  if (saleStatusMapped.length > 0) {
    andClauses.push({ saleStatus: { $in: saleStatusMapped } })
  }

  // State filter: match state field OR extract UF from end of yard/location
  // (many scrapers store "Curitiba - PR" in yard without a separate state field)
  if (filterStates.length > 0) {
    andClauses.push({ $or: filterStates.flatMap(uf => [
      { state: { $regex: `^${uf}\\d*$`, $options: 'i' } },
      { yard: { $regex: `(?:^|[^A-Za-z])${uf}\\d*(?:$|[^A-Za-z])`, $options: 'i' } },
      { location: { $regex: `(?:^|[^A-Za-z])${uf}\\d*(?:$|[^A-Za-z])`, $options: 'i' } },
    ]) })
  }

  if (andClauses.length > 0) filter['$and'] = andClauses

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
    _auctionDatePriority: {
      $cond: [
        { $ne: ['$auctionDate', null] },
        0,
        1,
      ],
    },
    _photoPriority: {
      $cond: [
        { $gt: [usableImageCountExpr, 0] },
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
    { $sort: buildSort(sort, period) },
  ])) as Record<string, unknown>[]

  const evaluatedVehicles = docs.map((doc) => {
    const rawVehicle = {
      ...doc,
      _id: String(doc['_id']),
      imageUrls: Array.isArray(doc['imageUrls'])
        ? doc['imageUrls'].filter((url): url is string => typeof url === 'string' && isUsableVehicleImageUrl(url))
        : [],
    } as VehicleRecord
    const vehicle = withEffectiveAuctionLifecycle(rawVehicle, todayStart)

    return {
      ...vehicle,
      displayRule: evaluateVehicleDisplayRules(vehicle, comboRules),
    }
  })

  const visibleVehicles = applyDisplayRules
    ? evaluatedVehicles.filter(vehicle => vehicle.displayRule.passes)
    : evaluatedVehicles

  const dedupedVisibleVehicles = dedupeDisplayVehicles(visibleVehicles)

  const total = dedupedVisibleVehicles.length
  const vehicles = dedupedVisibleVehicles.slice(skip, skip + limit)
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
