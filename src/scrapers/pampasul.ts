import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { runPampaSulScraper } from '../../layers/scrapers/server/utils/sources/pampasul.js'

export async function scrapePampaSul(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (message: string) => void; signal?: AbortSignal },
): Promise<AuctionVehicle[]> {
  const vehicles = await runPampaSulScraper(options)
  return vehicles.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'pampasul', lot: vehicle.lot ?? undefined }))
}
