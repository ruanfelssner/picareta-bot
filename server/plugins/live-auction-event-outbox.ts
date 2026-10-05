import { flushLiveVehicleSyncOutbox } from '../../layers/cars/server/utils/live-vehicle-sync-outbox'
import { flushLiveAuctionEventOutbox } from '../../layers/cars/server/utils/live-auction-event-outbox'

declare global {
  var __liveAuctionOutboxStarted: boolean | undefined
}

export default defineNitroPlugin((nitroApp) => {
  if (globalThis.__liveAuctionOutboxStarted) return
  globalThis.__liveAuctionOutboxStarted = true
  let running = false
  const tick = async () => {
    if (running || !isDbConnected()) return
    running = true
    try {
      await Promise.all([flushLiveAuctionEventOutbox(100), flushLiveVehicleSyncOutbox()])
    }
    catch (error) {
      console.error('[live-auction-outbox]', error instanceof Error ? error.message : String(error))
    }
    finally {
      running = false
    }
  }
  const timer = setInterval(() => void tick(), 15_000)
  timer.unref?.()
  nitroApp.hooks.hook('close', () => clearInterval(timer))
})
