import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { runFreitasScraper } from '../../layers/scrapers/server/utils/sources/freitas.js'
import { enrichPublicAuctionFipe } from '../../layers/cars/server/utils/public-auction-fipe.js'

export { FREITAS_TIMEOUT_MS } from '../../layers/scrapers/server/utils/freitas-session.js'

export async function scrapeFreitas(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (_message: string) => void; signal?: AbortSignal },
): Promise<AuctionVehicle[]> {
  const vehicles = await runFreitasScraper(options)
  options.signal?.throwIfAborted()
  const enriched = await enrichPublicAuctionFipe(vehicles, options.log, options.signal)
  options.signal?.throwIfAborted()
  return enriched.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'freitas', lot: vehicle.lot ?? undefined }))
}
