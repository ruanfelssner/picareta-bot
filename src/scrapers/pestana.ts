import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { runPestanaScraper } from '../../layers/scrapers/server/utils/sources/pestana.js'

/** CLI e Nuxt usam a mesma coleta e normalização. */
export async function scrapePestana(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (message: string) => void; signal?: AbortSignal },
): Promise<AuctionVehicle[]> {
  const vehicles = await runPestanaScraper(options)
  return vehicles.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'pestana', lot: vehicle.lot ?? undefined }))
}
