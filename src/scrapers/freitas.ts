import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { runFreitasScraper } from '../../layers/scrapers/server/utils/sources/freitas.js'
import { enrichPublicAuctionFipe } from '../../layers/cars/server/utils/public-auction-fipe.js'

export async function scrapeFreitas(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (message: string) => void; signal?: AbortSignal },
): Promise<AuctionVehicle[]> {
  const vehicles = await runFreitasScraper(options)
  options.signal?.throwIfAborted()
  const enriched = await enrichPublicAuctionFipe(vehicles, options.log, options.signal)
  options.signal?.throwIfAborted()
  return enriched.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'freitas', lot: vehicle.lot ?? undefined }))
}
