export default defineEventHandler(async (event) => {
  assertWebSearchAvailable()

  const body = await readBody<{ terms?: unknown }>(event).catch(() => ({ terms: undefined }))
  const terms = normalizeWebSearchTerms(body.terms)
  if (terms.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Informe ao menos um termo para buscar no Marketplace.' })
  }

  const id = await createWebSearch(terms)
  return { id, terms }
})
