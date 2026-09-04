import { assertLiveAuctionExtensionAuthorized } from '../../../../../utils/live-auction-extension-auth'
import {
  completeCopartConditionalJob,
  parseCopartConditionalJobResult,
} from '../../../../../utils/copart-conditional-job-queue'

export default defineEventHandler(async (event) => {
  useDb()
  assertLiveAuctionExtensionAuthorized(event)
  const workerId = getHeader(event, 'x-live-auction-worker-id')?.trim() ?? ''
  if (!workerId) throw createError({ statusCode: 400, message: 'Identificador do navegador não informado.' })
  const jobId = getRouterParam(event, 'jobId')?.trim() ?? ''
  if (!jobId) throw createError({ statusCode: 400, message: 'Job não informado.' })
  const result = parseCopartConditionalJobResult(await readBody<unknown>(event))
  const completed = await completeCopartConditionalJob(jobId, workerId, result)
  return { ok: true, job: completed.job, finishedRun: completed.finishedRun }
})
