import { assertLiveAuctionExtensionAuthorized } from '../../../utils/live-auction-extension-auth'
import { claimCopartConditionalJob } from '../../../utils/copart-conditional-job-queue'

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)
  const workerId = getHeader(event, 'x-live-auction-worker-id')?.trim() ?? ''
  const job = await claimCopartConditionalJob(workerId)
  return { ok: true, job }
})
