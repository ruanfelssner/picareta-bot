export default defineEventHandler(async () => {
  assertArchiveAvailable()
  return { items: await listArchivedMarketplaceListings() }
})
