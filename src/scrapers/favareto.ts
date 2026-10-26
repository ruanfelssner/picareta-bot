import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { runFavaretoScraper, type FavaretoScraperOptions } from '../../layers/scrapers/server/utils/sources/favareto.js'

export { parseFavaretoVehicleIdentity } from '../../layers/scrapers/server/utils/sources/favareto.js'

/** CLI/cloud e Nuxt usam a mesma descoberta, transporte e normalização. */
export async function scrapeFavareto(
  _filters: AuctionFilters,
  options?: FavaretoScraperOptions,
): Promise<AuctionVehicle[]> {
  const vehicles = await runFavaretoScraper(options)
  return vehicles.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'favareto', lot: vehicle.lot ?? undefined }))
}
