import type { VehicleSource } from '#shared/types/vehicle'
import { ACTIVE_AUCTION_SOURCES } from '#shared/constants/sources'
import { VehicleModel } from '../../utils/schemas/vehicle'

type DamageLevel = 'small' | 'medium' | 'normal'
type PeriodFilter = 'upcoming' | 'today' | 'tomorrow' | 'past' | 'all'
type FipeFilter = 'all' | 'with' | 'without'
type SaleStatusLevel = 'available' | 'conditional' | 'sold'
type CountFacet = 'source' | 'state' | 'damage' | 'period' | 'fipe' | 'saleStatus'

const SALE_STATUS_MAP: Record<SaleStatusLevel, string> = {
  available: 'unknown',
  conditional: 'conditional',
  sold: 'sold',
}

function isDamageLevel(value: string): value is DamageLevel {
  return value === 'small' || value === 'medium' || value === 'normal'
}

function isPeriodFilter(value: unknown): value is PeriodFilter {
  return value === 'upcoming' || value === 'today' || value === 'tomorrow' || value === 'past' || value === 'all'
}

function isFipeFilter(value: unknown): value is FipeFilter {
  return value === 'all' || value === 'with' || value === 'without'
}

function isSaleStatusLevel(value: string): value is SaleStatusLevel {
  return value === 'available' || value === 'conditional' || value === 'sold'
}

function startOfLocalDay(offsetDays = 0): Date {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  date.setDate(date.getDate() + offsetDays)
  return date
}

function getPeriodClause(period: PeriodFilter, saleStatusMapped: string[]): object {
  const todayStart = startOfLocalDay()
  const tomorrowStart = startOfLocalDay(1)
  const dayAfterTomorrowStart = startOfLocalDay(2)
  const finalizedStatuses = ['sold', 'conditional', 'not_sold']
  const selectedFinalizedStatuses = finalizedStatuses.filter(status => saleStatusMapped.includes(status))
  const finalizedStatusesToExclude = finalizedStatuses
    .filter(status => saleStatusMapped.length === 0 || !saleStatusMapped.includes(status))
  // Sold/conditional vehicles always have auctionStatus "finished", so requiring
  // auctionStatus != finished would zero them out whenever explicitly selected.
  const activeAuctionClause = {
    $or: [
      { auctionStatus: { $ne: 'finished' } },
      ...(selectedFinalizedStatuses.length > 0 ? [{ saleStatus: { $in: selectedFinalizedStatuses } }] : []),
    ],
    ...(finalizedStatusesToExclude.length > 0 ? { saleStatus: { $nin: finalizedStatusesToExclude } } : {}),
  }

  if (period === 'upcoming') {
    return {
      ...activeAuctionClause,
      auctionDate: { $gte: todayStart, $lt: dayAfterTomorrowStart },
    }
  }

  if (period === 'today') {
    return {
      ...activeAuctionClause,
      auctionDate: { $gte: todayStart, $lt: tomorrowStart },
    }
  }

  if (period === 'tomorrow') {
    return {
      ...activeAuctionClause,
      auctionDate: { $gte: tomorrowStart, $lt: dayAfterTomorrowStart },
    }
  }

  if (period === 'past') {
    return {
      $or: [
        { auctionStatus: 'finished' },
        { saleStatus: { $in: ['sold', 'conditional', 'not_sold'] } },
        {
          auctionStatus: { $ne: 'future' },
          auctionDate: { $lt: todayStart },
        },
      ],
    }
  }

  return {
    ...activeAuctionClause,
    $or: [
      { auctionStatus: 'future' },
      { auctionDate: null },
      { auctionDate: { $gte: todayStart } },
    ],
  }
}

function getDamageClause(damageLevels: DamageLevel[]): object | null {
  if (damageLevels.length === 0) return null

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

  return { $or: damageClauses }
}

function getStateClause(states: string[]): object | null {
  if (states.length === 0) return null

  return { $or: states.flatMap(uf => [
    { state: { $regex: `^${uf}\\d*$`, $options: 'i' } },
    { yard: { $regex: `(?:^|[^A-Za-z])${uf}\\d*(?:$|[^A-Za-z])`, $options: 'i' } },
    { location: { $regex: `(?:^|[^A-Za-z])${uf}\\d*(?:$|[^A-Za-z])`, $options: 'i' } },
  ]) }
}

function getUsableImageCountExpr() {
  return {
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
}

function getEffectiveStateExpr() {
  return {
    $let: {
      vars: {
        stateM: {
          $regexFind: {
            input: { $toUpper: { $ifNull: ['$state', ''] } },
            regex: '^([A-Z]{2})[0-9]*$',
          },
        },
        yardM: {
          $regexFind: {
            input: { $toUpper: { $ifNull: ['$yard', ''] } },
            regex: '(?:^|[^A-Z])([A-Z]{2})[0-9]*(?:$|[^A-Z])',
          },
        },
        locationM: {
          $regexFind: {
            input: { $toUpper: { $ifNull: ['$location', ''] } },
            regex: '(?:^|[^A-Z])([A-Z]{2})[0-9]*(?:$|[^A-Z])',
          },
        },
      },
      in: {
        $ifNull: [
          { $arrayElemAt: ['$$stateM.captures', 0] },
          {
            $ifNull: [
              { $arrayElemAt: ['$$yardM.captures', 0] },
              { $ifNull: [{ $arrayElemAt: ['$$locationM.captures', 0] }, ''] },
            ],
          },
        ],
      },
    },
  }
}

export default defineEventHandler(async (event) => {
  useDb()

  const query = getQuery(event)
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
  const saleStatusMapped = saleStatusLevels.map(level => SALE_STATUS_MAP[level])
  const statesParam = query['states'] as string | undefined
  const citiesParam = query['cities'] as string | undefined
  const filterStates = statesParam ? statesParam.split(',').map(s => s.trim()).filter(Boolean) : []
  const filterCities = citiesParam ? citiesParam.split(',').map(c => c.trim()).filter(Boolean) : []
  const periodParam = query['period']
  const period: PeriodFilter = isPeriodFilter(periodParam) ? periodParam : 'upcoming'
  const damageLevelsParam = query['damageLevels'] as string | undefined
  const damageLevels = damageLevelsParam
    ? damageLevelsParam.split(',').map(value => value.trim()).filter(isDamageLevel)
    : []
  const showNoPhoto = query['showNoPhoto'] !== 'false'

  // Aggregation-expression counterpart of getPeriodClause's activeAuctionClause,
  // for the byPeriodBase bucket sums below (docs there are already pre-filtered by
  // buildMatch's saleStatus $in, so this only needs to relax the finished/finalized
  // exclusion for statuses the caller explicitly selected).
  const finalizedStatuses = ['sold', 'conditional', 'not_sold']
  const selectedFinalizedStatuses = finalizedStatuses.filter(status => saleStatusMapped.includes(status))
  const finalizedStatusesToExcludeExpr = finalizedStatuses
    .filter(status => saleStatusMapped.length === 0 || !saleStatusMapped.includes(status))
  const activeAuctionExpr = {
    $or: [
      { $ne: ['$auctionStatus', 'finished'] },
      ...(selectedFinalizedStatuses.length > 0 ? [{ $in: ['$saleStatus', selectedFinalizedStatuses] }] : []),
    ],
  }
  const notExcludedFinalizedExpr = { $not: [{ $in: ['$saleStatus', finalizedStatusesToExcludeExpr] }] }

  const buildMatch = (omit?: CountFacet): Record<string, unknown> => {
    const filter: Record<string, unknown> = {
      status: { $in: ['scraped', 'sent', 'favorite'] },
      source: { $in: activeSources },
    }
    const andClauses: object[] = []
    const largeDamageRegex = /(?:grande\s+monta|sucata|perda\s+total|irrecuper[aá]vel|recupera[cç][aã]o\s+imposs[ií]vel)/i

    andClauses.push({
      $nor: [
        { damage: largeDamageRegex },
        { title: largeDamageRegex },
        { description: largeDamageRegex },
      ],
    })

    if (omit === 'source') {
      filter['source'] = { $in: ACTIVE_AUCTION_SOURCES }
    }
    else if (sources.length > 0) {
      filter['source'] = { $in: activeSources }
    }

    if (omit !== 'period') {
      andClauses.push(getPeriodClause(period, omit === 'saleStatus' ? Object.values(SALE_STATUS_MAP) : saleStatusMapped))
    }

    const damageClause = omit !== 'damage' ? getDamageClause(damageLevels) : null
    if (damageClause) andClauses.push(damageClause)

    if (omit !== 'saleStatus' && saleStatusMapped.length > 0) {
      andClauses.push({ saleStatus: { $in: saleStatusMapped } })
    }

    const stateClause = omit !== 'state' ? getStateClause(filterStates) : null
    if (stateClause) andClauses.push(stateClause)

    if (filterCities.length > 0) {
      filter['city'] = { $in: filterCities.map(c => new RegExp(c, 'i')) }
    }

    if (!showNoPhoto) {
      andClauses.push({ $or: [
        { status: { $in: ['sent', 'favorite'] } },
        { $expr: { $gt: [getUsableImageCountExpr(), 0] } },
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

    if (omit !== 'fipe') {
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
    }

    if (andClauses.length > 0) filter['$and'] = andClauses
    return filter
  }

  const [result] = await VehicleModel.aggregate([
    {
      $facet: {
        bySrc: [
          { $match: buildMatch('source') },
          { $group: { _id: '$source', n: { $sum: 1 } } },
        ],
        byState: [
          { $match: buildMatch('state') },
          { $addFields: { _effectiveState: getEffectiveStateExpr() } },
          { $match: { _effectiveState: { $ne: '' } } },
          { $group: { _id: '$_effectiveState', n: { $sum: 1 } } },
        ],
        byDamage: [
          { $match: buildMatch('damage') },
          {
            $group: {
              _id: null,
              all: { $sum: 1 },
              small: {
                $sum: {
                  $cond: [
                    { $regexMatch: { input: { $concat: [{ $ifNull: ['$damage', ''] }, ' ', { $ifNull: ['$title', ''] }, ' ', { $ifNull: ['$description', ''] }] }, regex: /pequena\s+monta/i } },
                    1,
                    0,
                  ],
                },
              },
              medium: {
                $sum: {
                  $cond: [
                    { $regexMatch: { input: { $concat: [{ $ifNull: ['$damage', ''] }, ' ', { $ifNull: ['$title', ''] }, ' ', { $ifNull: ['$description', ''] }] }, regex: /m[eé]dia\s+monta/i } },
                    1,
                    0,
                  ],
                },
              },
              normal: {
                $sum: {
                  $cond: [
                    { $not: [{ $regexMatch: { input: { $concat: [{ $ifNull: ['$damage', ''] }, ' ', { $ifNull: ['$title', ''] }, ' ', { $ifNull: ['$description', ''] }] }, regex: /(?:pequena|m[eé]dia|grande)\s+monta/i } }] },
                    1,
                    0,
                  ],
                },
              },
            },
          },
        ],
        byPeriodBase: [
          { $match: buildMatch('period') },
          {
            $group: {
              _id: null,
              total: { $sum: 1 },
              upcoming: { $sum: { $cond: [{ $and: [{ $gte: ['$auctionDate', startOfLocalDay()] }, { $lt: ['$auctionDate', startOfLocalDay(2)] }, activeAuctionExpr, notExcludedFinalizedExpr] }, 1, 0] } },
              past: { $sum: { $cond: [{ $or: [{ $eq: ['$auctionStatus', 'finished'] }, { $in: ['$saleStatus', ['sold', 'conditional', 'not_sold']] }, { $and: [{ $ne: ['$auctionStatus', 'future'] }, { $lt: ['$auctionDate', startOfLocalDay()] }] }] }, 1, 0] } },
              all: { $sum: { $cond: [{ $and: [activeAuctionExpr, notExcludedFinalizedExpr, { $or: [{ $eq: ['$auctionStatus', 'future'] }, { $eq: ['$auctionDate', null] }, { $gte: ['$auctionDate', startOfLocalDay()] }] }] }, 1, 0] } },
            },
          },
        ],
        byFipe: [
          { $match: buildMatch('fipe') },
          {
            $group: {
              _id: null,
              all: { $sum: 1 },
              withFipe: { $sum: { $cond: [{ $ne: ['$fipe', null] }, 1, 0] } },
              withoutFipe: { $sum: { $cond: [{ $eq: ['$fipe', null] }, 1, 0] } },
            },
          },
        ],
        byStatus: [
          { $match: buildMatch('saleStatus') },
          {
            $group: {
              _id: null,
              all: { $sum: 1 },
              available: { $sum: { $cond: [{ $eq: ['$saleStatus', 'unknown'] }, 1, 0] } },
              conditional: { $sum: { $cond: [{ $eq: ['$saleStatus', 'conditional'] }, 1, 0] } },
              sold: { $sum: { $cond: [{ $eq: ['$saleStatus', 'sold'] }, 1, 0] } },
            },
          },
        ],
      },
    },
  ])

  const bySrc: Record<string, number> = {}
  for (const item of (result?.bySrc ?? []) as { _id: string; n: number }[]) {
    if (item._id) bySrc[item._id] = item.n
  }

  const byState: Record<string, number> = {}
  for (const item of (result?.byState ?? []) as { _id: string; n: number }[]) {
    if (item._id) byState[item._id] = item.n
  }

  const damageDoc = ((result?.byDamage ?? []) as Array<Record<string, number>>)[0] ?? {}
  const byDamage = {
    all: damageDoc['all'] ?? 0,
    small: damageDoc['small'] ?? 0,
    medium: damageDoc['medium'] ?? 0,
    normal: damageDoc['normal'] ?? 0,
  }

  const periodDoc = ((result?.byPeriodBase ?? []) as Array<Record<string, number>>)[0] ?? {}
  const byPeriod = {
    upcoming: periodDoc['upcoming'] ?? 0,
    past: periodDoc['past'] ?? 0,
    all: periodDoc['all'] ?? 0,
  }

  const fipeDoc = ((result?.byFipe ?? []) as Array<Record<string, number>>)[0] ?? {}
  const byFipe = {
    all: fipeDoc['all'] ?? 0,
    with: fipeDoc['withFipe'] ?? 0,
    without: fipeDoc['withoutFipe'] ?? 0,
  }

  const statusDoc = ((result?.byStatus ?? []) as Array<Record<string, number>>)[0] ?? {}
  const byStatus = {
    all: statusDoc['all'] ?? 0,
    available: statusDoc['available'] ?? 0,
    conditional: statusDoc['conditional'] ?? 0,
    sold: statusDoc['sold'] ?? 0,
  }

  return { bySrc, byState, byDamage, byPeriod, byFipe, byStatus }
})
