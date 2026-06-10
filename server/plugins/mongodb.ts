import mongoose from 'mongoose'

export default defineNitroPlugin(async () => {
  const uri = (process.env.MONGO_DATA_URI || process.env.MONGO_URI || '').trim()
  const dbName = (process.env.MONGO_DATA_DB_NAME || process.env.MONGO_DB_NAME || 'marketplace').trim()

  if (!uri) {
    console.warn('[mongodb] MONGO_URI não configurado — banco de dados desabilitado')
    return
  }

  try {
    await mongoose.connect(uri, {
      dbName,
      serverSelectionTimeoutMS: 15_000,
    })
    console.info(`[mongodb] conectado — db: ${dbName}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[mongodb] falha na conexão: ${message}`)
  }
})
