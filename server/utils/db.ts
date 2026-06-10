import mongoose from 'mongoose'

export function useDb(): mongoose.Connection {
  if (mongoose.connection.readyState !== 1) {
    throw new Error('[mongodb] banco não conectado — verifique MONGO_URI')
  }
  return mongoose.connection
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1
}
