import { isDbConnected, useDb } from './db'

// Mesma collection em que `persistRunToMongo` grava os anúncios do Marketplace.
// O upsert das buscas só faz $set em campos de conteúdo, então `archivedAt` sobrevive a novas execuções.
const LISTINGS_COLLECTION = 'listings'
const MAX_ARCHIVED_LIST = 300

export interface ArchiveListingInput {
  url: string
  titleRaw?: string | null
  priceRaw?: string | null
  locationRaw?: string | null
  image?: string | null
  searchTerms?: string[]
}

export interface ArchivedListing {
  url: string
  titleRaw: string
  priceRaw: string | null
  locationRaw: string | null
  image: string | null
  searchTerms: string[]
  archivedAt: string
}

interface ListingArchiveDoc {
  url: string
  titleRaw?: string
  priceRaw?: string | null
  locationRaw?: string | null
  image?: string | null
  searchTerms?: string[]
  archivedAt?: Date | null
}

function listings() {
  return useDb().collection<ListingArchiveDoc>(LISTINGS_COLLECTION)
}

export function assertArchiveAvailable() {
  if (!isDbConnected()) {
    throw createError({
      statusCode: 503,
      statusMessage: 'MongoDB não conectado — configure MONGO_URI para arquivar anúncios.',
    })
  }
}

export async function loadArchivedMarketplaceUrls(): Promise<Set<string>> {
  if (!isDbConnected()) return new Set()
  const docs = await listings()
    .find({ archivedAt: { $ne: null } }, { projection: { url: 1 } })
    .toArray()
  return new Set(docs.map(doc => doc.url))
}

export async function listArchivedMarketplaceListings(): Promise<ArchivedListing[]> {
  const docs = await listings()
    .find({ archivedAt: { $ne: null } })
    .sort({ archivedAt: -1 })
    .limit(MAX_ARCHIVED_LIST)
    .toArray()

  return docs.map(doc => ({
    url: doc.url,
    titleRaw: doc.titleRaw || 'Anúncio sem título',
    priceRaw: doc.priceRaw ?? null,
    locationRaw: doc.locationRaw ?? null,
    image: doc.image ?? null,
    searchTerms: doc.searchTerms ?? [],
    archivedAt: (doc.archivedAt ?? new Date()).toISOString(),
  }))
}

export async function archiveMarketplaceListing(input: ArchiveListingInput): Promise<void> {
  const now = new Date()
  const searchTerms = (input.searchTerms ?? []).filter(term => typeof term === 'string' && term.trim())

  // Upsert: o anúncio pode não existir na collection se a persistência da busca estava desabilitada ou falhou.
  await listings().updateOne(
    { url: input.url },
    {
      $set: {
        archivedAt: now,
        updatedAt: now,
        ...(input.image ? { image: input.image } : {}),
      },
      $setOnInsert: {
        url: input.url,
        titleRaw: input.titleRaw ?? '',
        priceRaw: input.priceRaw ?? null,
        locationRaw: input.locationRaw ?? null,
        rawText: '',
        relevanceLevel: 'baixa',
        relevanceScore: 0,
        matchScore: 0,
        firstSeenAt: now,
        lastSeenAt: now,
        createdAt: now,
      },
      ...(searchTerms.length > 0 ? { $addToSet: { searchTerms: { $each: searchTerms } } } : {}),
    },
    { upsert: true },
  )
}

export async function unarchiveMarketplaceListing(url: string): Promise<boolean> {
  const result = await listings().updateOne(
    { url, archivedAt: { $ne: null } },
    { $set: { archivedAt: null, updatedAt: new Date() } },
  )
  return result.modifiedCount > 0
}
