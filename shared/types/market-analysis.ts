import type { VehicleRecord } from './vehicle'

export type VehicleMarketAnalysisBasis =
  | 'model-year-source-damage'
  | 'model-year-source'
  | 'model-year-damage'
  | 'model-year-market'
  | 'model-source-damage'
  | 'model-source'
  | 'model-damage'
  | 'model-market'
  | 'source-damage'
  | 'source'
  | 'damage-market'
  | 'market'

export interface VehicleMarketAnalysis {
  maxBid: number
  maxTotal: number
  averagePct: number
  conditionalAveragePct: number | null
  sampleSize: number
  basis: VehicleMarketAnalysisBasis
  basisLabel: string
  feesIncluded: boolean
}

export type VehicleWithMarketAnalysis = VehicleRecord & {
  marketAnalysis?: VehicleMarketAnalysis | null
}
