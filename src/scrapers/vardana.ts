import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { enrichPublicAuctionFipe } from '../../layers/cars/server/utils/public-auction-fipe.js'
import { runVardanaScraper } from '../../layers/scrapers/server/utils/sources/vardana.js'

export async function scrapeVardana(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (message: string) => void; signal?: AbortSignal },
): Promise<AuctionVehicle[]> {
  const vehicles = await runVardanaScraper(options)
  const enriched = await enrichPublicAuctionFipe(vehicles, options.log, options.signal)
  return enriched.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'vardana', lot: vehicle.lot ?? undefined }))
}
