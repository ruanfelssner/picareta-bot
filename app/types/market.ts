export interface SegmentOutcomeRow {
  key: string
  label: string
  n: number
  nWithFipe: number
  sold: number
  conditional: number
  soldPctOfSegment: number | null
  conditionalPctOfSegment: number | null
  meanSoldFipe: number | null
  meanConditionalFipe: number | null
  sufficient: boolean
}

export interface BandVehicleRow {
  id: string
  brand: string
  model: string
  year: number | null
  source: string
  sourceLabel: string
  damage: string | null
  saleStatus: 'sold' | 'conditional'
  price: number | null
  soldPrice: number | null
  fipe: number | null
  pct: number
  url: string
}

export interface MarketBand {
  label: string
  count: number
  pctOfSample: number
  vehicles: BandVehicleRow[]
}

export interface OpportunityRow {
  source: string
  sourceLabel: string
  damageBucket: string
  damageLabel: string
  n: number
  nWithFipe: number
  soldMean: number | null
  conditionalMean: number | null
  diff: number | null
  level: 'alta' | 'media' | 'baixa' | 'insuficiente'
}

export interface MarketOverviewResponse {
  meta: {
    total: number
    withPrice: number
    withFipe: number
    withPriceAndFipe: number
    withSoldPrice: number
    sourcesActive: number
    coverageDays: number | null
  }
  outcomes: {
    totalFinalized: number
    notSoldExcluded: number
    sold: number
    conditional: number
    soldWithFipe: number
    conditionalWithFipe: number
    totalWithFipe: number
    manualCount: number
    autoCount: number
    soldMeanPct: number | null
    conditionalMeanPct: number | null
    diffPct: number | null
    sufficient: boolean
    minSampleRequired: number
  }
  outcomesByBrand: SegmentOutcomeRow[]
  outcomesBySource: SegmentOutcomeRow[]
  outcomesByDamage: SegmentOutcomeRow[]
  bands: MarketBand[]
  opportunity: OpportunityRow[]
  generatedAt: string
}
