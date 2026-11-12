import type { AuctionVehicle } from '../formatters/auction-card.js'
import type { AuctionFilters } from '../integrations/mongo.js'
import { runLeiloScraper } from '../../layers/scrapers/server/utils/sources/leilo.js'
import { PartialScraperResultError, type RawScrapedVehicle } from '../../layers/scrapers/server/utils/source-types.js'
import { enrichPublicAuctionFipe } from '../../layers/cars/server/utils/public-auction-fipe.js'

export { LEILO_TIMEOUT_MS } from '../../layers/scrapers/server/utils/sources/leilo.js'

export async function scrapeLeilo(
  _filters: AuctionFilters,
  options: { headless: boolean; log: (_message: string) => void; signal?: AbortSignal },
): Promise<AuctionVehicle[]> {
  const finish = async (vehicles: RawScrapedVehicle[]) => {
    options.signal?.throwIfAborted()
    const enriched = await enrichPublicAuctionFipe(vehicles, options.log, options.signal)
    options.signal?.throwIfAborted()
    return enriched.map(vehicle => ({ ...vehicle, source: 'leilo' as const, lot: vehicle.lot ?? undefined }))
  }
  try {
    return await finish(await runLeiloScraper(options))
  } catch (error) {
    // Lotes já coletados seguem como parciais; o runner salva sem fechar o snapshot.
    if (!(error instanceof PartialScraperResultError) || options.signal?.aborted) throw error
    throw new PartialScraperResultError(error.message, await finish(error.vehicles))
  }
}
