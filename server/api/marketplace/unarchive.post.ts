export default defineEventHandler(async (event) => {
  assertArchiveAvailable()

  const body = await readBody<{ url?: unknown }>(event).catch(() => ({ url: undefined }))
  const url = typeof body.url === 'string' ? body.url.trim() : ''
  if (!url) {
    throw createError({ statusCode: 400, statusMessage: 'Informe a URL do anúncio para restaurar.' })
  }

  const restored = await unarchiveMarketplaceListing(url)
  return { ok: true, restored }
})
