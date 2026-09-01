import { assertAuctionAdmin, saveCommunity } from '../../utils/auction-service'

export default defineEventHandler(async (event) => {
  assertAuctionAdmin(event)
  useDb()
  const body = await readBody<Record<string, unknown>>(event)
  if (typeof body?.name !== 'string') throw createError({ statusCode: 400, message: 'Nome é obrigatório.' })
  return { community: await saveCommunity({ name: body.name, zapiCommunityId: typeof body.zapiCommunityId === 'string' ? body.zapiCommunityId : undefined, announcementGroupId: typeof body.announcementGroupId === 'string' ? body.announcementGroupId : undefined }) }
})
