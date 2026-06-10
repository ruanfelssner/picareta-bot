export interface AuctionComboRule {
  id: string
  enabled: boolean
  mode: 'include' | 'exclude'
  brand: string | null
  model: string | null
  text: string | null
  minYear: number | null
}

export interface AuctionFilters {
  states: string[]
  cities: string[]
  comboRules: AuctionComboRule[]
  updatedAt: Date
}
