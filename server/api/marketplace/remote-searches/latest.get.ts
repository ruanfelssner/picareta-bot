export default defineEventHandler(async () => {
  assertWebSearchAvailable()
  return { search: await getLatestWebSearch() }
})
