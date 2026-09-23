function readOffset(value: unknown): number {
  const parsed = Number.parseInt(typeof value === 'string' ? value : '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export default defineEventHandler(async (event) => {
  assertWebSearchAvailable()

  const id = getRouterParam(event, 'id') ?? ''
  const query = getQuery(event)
  return getWebSearchDelta(id, {
    logs: readOffset(query.logs),
    previews: readOffset(query.previews),
    finals: readOffset(query.finals),
  })
})
