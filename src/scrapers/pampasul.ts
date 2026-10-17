import type { AuctionVehicle } from '../formatters/auction-card.js'
import { assertAuctionSourceEnabled } from '../../shared/constants/sources.js'
import type { AuctionFilters, MongoConfig } from '../integrations/mongo.js'
import { listUnresolvedPampaSulLotUrls } from '../integrations/mongo.js'
import { runPampaSulScraper } from '../../layers/scrapers/server/utils/sources/pampasul.js'

export async function scrapePampaSul(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (message: string) => void; signal?: AbortSignal; dataMongoConfig?: MongoConfig },
): Promise<AuctionVehicle[]> {
  assertAuctionSourceEnabled('pampasul')
  // Lots leave the listing when they close; recheck stored ones still without a result.
  let knownLotUrls: string[] = []
  if (options.dataMongoConfig) {
    try {
      knownLotUrls = await listUnresolvedPampaSulLotUrls(options.dataMongoConfig)
    } catch (error) {
      options.log(`[pampasul] Lotes pendentes indisponíveis no Mongo: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const vehicles = await runPampaSulScraper(options, knownLotUrls)
  return vehicles.map<AuctionVehicle>(vehicle => ({ ...vehicle, source: 'pampasul', lot: vehicle.lot ?? undefined }))
}
