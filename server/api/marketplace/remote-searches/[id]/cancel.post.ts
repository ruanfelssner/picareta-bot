export default defineEventHandler(async (event) => {
  assertWebSearchAvailable()

  const id = getRouterParam(event, 'id') ?? ''
  const status = await cancelWebSearch(id)
  return { ok: true, status }
})
