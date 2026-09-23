interface ArchiveBody {
  url?: unknown
  titleRaw?: unknown
  priceRaw?: unknown
  locationRaw?: unknown
  image?: unknown
  searchTerms?: unknown
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export default defineEventHandler(async (event) => {
  assertArchiveAvailable()

  const body = await readBody<ArchiveBody>(event).catch((): ArchiveBody => ({}))
  const url = optionalString(body.url)
  if (!url) {
    throw createError({ statusCode: 400, statusMessage: 'Informe a URL do anúncio para arquivar.' })
  }

  await archiveMarketplaceListing({
    url,
    titleRaw: optionalString(body.titleRaw),
    priceRaw: optionalString(body.priceRaw),
    locationRaw: optionalString(body.locationRaw),
    image: optionalString(body.image),
    searchTerms: Array.isArray(body.searchTerms)
      ? body.searchTerms.filter((term): term is string => typeof term === 'string')
      : [],
  })

  return { ok: true }
})
