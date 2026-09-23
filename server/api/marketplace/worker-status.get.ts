export default defineEventHandler(async () => {
  assertWebSearchAvailable()
  return getMarketplaceWorkerStatus()
})
