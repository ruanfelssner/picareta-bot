import { getPublicAuction } from '../../../utils/auction-service'

export default defineEventHandler(async (event) => {
  useDb()
  const slug = getRouterParam(event, 'slug')
  if (!slug) throw createError({ statusCode: 400, message: 'Slug inválido.' })
  return await getPublicAuction(slug)
})
