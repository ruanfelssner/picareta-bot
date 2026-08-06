import mongoose from 'mongoose'
import dotenv from 'dotenv'
import { getVehicleRetentionDate } from '../shared/utils/vehicle-retention'

dotenv.config()

const COLLECTION = 'scraped_vehicles'
const NO_SALE_POST_AUCTION_TTL_MS = 72 * 60 * 60 * 1000
const BATCH_SIZE = 500

type HistoryDocument = {
  _id: mongoose.Types.ObjectId
  scrapedAt?: Date | null
  expiresAt?: Date | null
  auctionDate?: Date | null
  price?: number | null
  soldPrice?: number | null
}

function validDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime())
}

function hasSaleValue(document: HistoryDocument): boolean {
  return (typeof document.soldPrice === 'number' && document.soldPrice > 0)
    || (typeof document.price === 'number' && document.price > 0)
}

function desiredExpiration(document: HistoryDocument): Date | null {
  if (!hasSaleValue(document) && validDate(document.auctionDate)) {
    return new Date(document.auctionDate.getTime() + NO_SALE_POST_AUCTION_TTL_MS)
  }

  const reference = validDate(document.scrapedAt)
    ? document.scrapedAt
    : validDate(document.expiresAt)
      ? document.expiresAt
      : null
  return reference ? getVehicleRetentionDate(reference) : null
}

async function main() {
  const uri = (process.env.MONGO_DATA_URI || process.env.MONGO_URI || '').trim()
  const dbName = (process.env.MONGO_DATA_DB_NAME || process.env.MONGO_DB_NAME || 'marketplace').trim()
  if (!uri) throw new Error('MONGO_URI ou MONGO_DATA_URI não configurado.')

  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 15_000 })
  const collection = mongoose.connection.db?.collection<HistoryDocument>(COLLECTION)
  if (!collection) throw new Error('Banco Mongo não disponível após a conexão.')

  let scanned = 0
  let updated = 0
  const operations: Array<{
    updateOne: {
      filter: { _id: mongoose.Types.ObjectId }
      update: { $set: { expiresAt: Date } }
    }
  }> = []

  for await (const document of collection.find({}, { projection: { scrapedAt: 1, expiresAt: 1, auctionDate: 1, price: 1, soldPrice: 1 } })) {
    scanned += 1
    const nextExpiration = desiredExpiration(document)
    if (!nextExpiration || (validDate(document.expiresAt) && document.expiresAt.getTime() >= nextExpiration.getTime())) continue

    operations.push({
      updateOne: {
        filter: { _id: document._id },
        update: { $set: { expiresAt: nextExpiration } },
      },
    })

    if (operations.length >= BATCH_SIZE) {
      const result = await collection.bulkWrite(operations, { ordered: false })
      updated += result.modifiedCount
      operations.length = 0
    }
  }

  if (operations.length) {
    const result = await collection.bulkWrite(operations, { ordered: false })
    updated += result.modifiedCount
  }

  console.info(`[retention] ${updated} registro(s) atualizado(s) de ${scanned} analisado(s).`)
}

try {
  await main()
}
finally {
  await mongoose.disconnect()
}
