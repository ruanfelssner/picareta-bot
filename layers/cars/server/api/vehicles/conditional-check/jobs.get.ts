import { assertLiveAuctionExtensionAuthorized } from '../../../utils/live-auction-extension-auth'
import { claimCopartConditionalJob } from '../../../utils/copart-conditional-job-queue'
import { getQuery } from 'h3'

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)
  const workerId = getHeader(event, 'x-live-auction-worker-id')?.trim() ?? ''
  const job = await claimCopartConditionalJob(workerId, { recover: getQuery(event).recover === 'true' })
  return { ok: true, job }
})
