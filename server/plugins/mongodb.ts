import mongoose from 'mongoose'

export default defineNitroPlugin(async () => {
  const config = useRuntimeConfig()
  // A fila de condicionais é criada pelo scraper com getMongoDataConfigFromEnv.
  // O Nitro precisa respeitar exatamente a mesma prioridade para não consultar
  // uma base diferente quando MONGO_DATA_URI e MONGO_URI coexistirem em produção.
  const uri = (process.env.MONGO_DATA_URI || (config.mongoUri as string) || process.env.MONGO_URI || '').trim()
  const dbName = (process.env.MONGO_DATA_DB_NAME || (config.mongoDbName as string) || process.env.MONGO_DB_NAME || 'marketplace').trim()

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
  }
  catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[mongodb] falha na conexão: ${message}`)
  }
})
