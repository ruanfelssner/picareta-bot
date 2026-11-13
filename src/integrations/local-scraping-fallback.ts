import mongoose, { type Connection, Types } from "mongoose";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { MongoConfig } from "./mongo.js";
import {
  LOCAL_FALLBACK_LIMITS,
  type LocalFallbackInput,
  type LocalFallbackJobStatus,
  type LocalFallbackJobView,
  type LocalFallbackStore
} from "../../layers/scrapers/server/utils/local-fallback-coordinator.js";

/**
 * Fila Mongo entre o serviço cloud (Docker/Railway) e o `pnpm worker` local.
 * O job guarda status/heartbeat; os veículos vão em blocos separados para não
 * esbarrar no limite de 16 MB por documento.
 */
export const LOCAL_FALLBACK_JOBS_COLLECTION = "scraping_local_fallback_jobs";
export const LOCAL_FALLBACK_CHUNKS_COLLECTION = "scraping_local_fallback_chunks";
const WORKER_HEARTBEATS_COLLECTION = "marketplace_worker_heartbeats";
const CHUNK_SIZE = 100;
const RETENTION_MS = 7 * 24 * 60 * 60_000;
const TEXT_MAX = 480;

type LocalFallbackJobDoc = {
  _id: Types.ObjectId;
  runId: string;
  source: AuctionVehicle["source"];
  label: string;
  cloudError: string;
  status: LocalFallbackJobStatus;
  workerId: string | null;
  message: string | null;
  error: string | null;
  found: number;
  complete: boolean;
  chunkCount: number;
  createdAt: Date;
  claimedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
  expiresAt: Date;
};

type LocalFallbackChunkDoc = {
  jobId: Types.ObjectId;
  index: number;
  vehicles: unknown[];
  expiresAt: Date;
};

export type ClaimedLocalFallbackJob = {
  id: string;
  runId: string;
  source: AuctionVehicle["source"];
  label: string;
  cloudError: string;
};

function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > TEXT_MAX ? `${value.slice(0, TEXT_MAX - 3)}...` : value;
}

async function withConnection<T>(config: MongoConfig, fn: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = await mongoose
    .createConnection(config.uri, { dbName: config.dbName, serverSelectionTimeoutMS: 15_000 })
    .asPromise();
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

const jobs = (connection: Connection) => connection.collection<LocalFallbackJobDoc>(LOCAL_FALLBACK_JOBS_COLLECTION);
const chunks = (connection: Connection) => connection.collection<LocalFallbackChunkDoc>(LOCAL_FALLBACK_CHUNKS_COLLECTION);

let indexesReady = false;
async function ensureIndexes(connection: Connection): Promise<void> {
  if (indexesReady) return;
  await Promise.all([
    jobs(connection).createIndex({ status: 1, createdAt: 1 }),
    jobs(connection).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    chunks(connection).createIndex({ jobId: 1, index: 1 }),
    chunks(connection).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);
  indexesReady = true;
}

function toView(doc: LocalFallbackJobDoc): LocalFallbackJobView {
  return {
    id: doc._id.toString(),
    status: doc.status,
    workerId: doc.workerId,
    message: doc.message,
    error: doc.error,
    complete: doc.complete,
    createdAt: doc.createdAt,
    claimedAt: doc.claimedAt,
    heartbeatAt: doc.heartbeatAt
  };
}

/** Lado cloud: enfileira, acompanha e lê o resultado. */
export function createMongoLocalFallbackStore(config: MongoConfig): LocalFallbackStore {
  return {
    async onlineWorker(now) {
      if (!config.enabled) return null;
      return withConnection(config, async (connection) => {
        const heartbeat = await connection
          .collection<{ workerId: string; lastSeenAt: Date }>(WORKER_HEARTBEATS_COLLECTION)
          .findOne(
            { lastSeenAt: { $gte: new Date(now.getTime() - LOCAL_FALLBACK_LIMITS.workerOnlineMs) } },
            { sort: { lastSeenAt: -1 }, projection: { workerId: 1 } }
          );
        return heartbeat?.workerId ?? null;
      });
    },

    async enqueue(input: LocalFallbackInput) {
      return withConnection(config, async (connection) => {
        await ensureIndexes(connection);
        const now = new Date();
        const _id = new Types.ObjectId();
        await jobs(connection).insertOne({
          _id,
          runId: input.runId,
          source: input.source,
          label: input.label,
          cloudError: clip(input.cloudError) ?? "",
          status: "queued",
          workerId: null,
          message: null,
          error: null,
          found: 0,
          complete: false,
          chunkCount: 0,
          createdAt: now,
          claimedAt: null,
          heartbeatAt: null,
          finishedAt: null,
          updatedAt: now,
          expiresAt: new Date(now.getTime() + RETENTION_MS)
        });
        return _id.toString();
      });
    },

    async get(id) {
      return withConnection(config, async (connection) => {
        const doc = await jobs(connection).findOne({ _id: new Types.ObjectId(id) });
        return doc ? toView(doc) : null;
      });
    },

    async abandon(id, reason) {
      return withConnection(config, async (connection) => {
        const now = new Date();
        const result = await jobs(connection).updateOne(
          { _id: new Types.ObjectId(id), status: { $in: ["queued", "running"] } },
          { $set: { status: "failed", error: clip(reason), finishedAt: now, updatedAt: now } }
        );
        return result.modifiedCount > 0;
      });
    },

    async readVehicles(id) {
      return withConnection(config, async (connection) => {
        const docs = await chunks(connection)
          .find({ jobId: new Types.ObjectId(id) })
          .sort({ index: 1 })
          .toArray();
        return docs.flatMap((doc) => doc.vehicles as AuctionVehicle[]);
      });
    },

    async cleanup(id) {
      await withConnection(config, async (connection) => {
        await chunks(connection).deleteMany({ jobId: new Types.ObjectId(id) });
      });
    }
  };
}

/** Lado worker: assume o próximo job da fila. */
export async function claimNextLocalFallbackJob(
  config: MongoConfig,
  workerId: string
): Promise<ClaimedLocalFallbackJob | null> {
  if (!config.enabled) return null;
  return withConnection(config, async (connection) => {
    const now = new Date();
    const doc = await jobs(connection).findOneAndUpdate(
      { status: "queued" },
      {
        $set: {
          status: "running",
          workerId,
          claimedAt: now,
          heartbeatAt: now,
          message: "Worker local assumiu a coleta.",
          updatedAt: now
        }
      },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );
    if (!doc) return null;
    return { id: doc._id.toString(), runId: doc.runId, source: doc.source, label: doc.label, cloudError: doc.cloudError };
  });
}

export async function touchLocalFallbackJob(
  config: MongoConfig,
  id: string,
  workerId: string,
  progress: { message: string | null; found: number }
): Promise<void> {
  await withConnection(config, async (connection) => {
    const now = new Date();
    await jobs(connection).updateOne(
      { _id: new Types.ObjectId(id), status: "running", workerId },
      { $set: { message: clip(progress.message), found: progress.found, heartbeatAt: now, updatedAt: now } }
    );
  });
}

/**
 * Grava os veículos e fecha o job. Retorna false quando o cloud já tinha
 * abandonado o job (timeout); nesse caso os blocos gravados são descartados.
 */
export async function finishLocalFallbackJob(
  config: MongoConfig,
  id: string,
  workerId: string,
  result: { vehicles: AuctionVehicle[]; complete: boolean; error: string | null }
): Promise<boolean> {
  return withConnection(config, async (connection) => {
    const jobId = new Types.ObjectId(id);
    const expiresAt = new Date(Date.now() + RETENTION_MS);
    // Round-trip JSON = o mesmo formato que a ingestão envia ao Picareta (datas em ISO, sem undefined).
    const plain = JSON.parse(JSON.stringify(result.vehicles)) as unknown[];
    const docs: LocalFallbackChunkDoc[] = [];
    for (let index = 0; index * CHUNK_SIZE < plain.length; index++) {
      docs.push({ jobId, index, vehicles: plain.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE), expiresAt });
    }
    await chunks(connection).deleteMany({ jobId });
    if (docs.length) await chunks(connection).insertMany(docs);

    const now = new Date();
    const updated = await jobs(connection).updateOne(
      { _id: jobId, status: "running", workerId },
      {
        $set: {
          status: result.complete ? "completed" : "failed",
          complete: result.complete,
          error: result.complete ? null : clip(result.error ?? "coleta local incompleta"),
          found: result.vehicles.length,
          chunkCount: docs.length,
          finishedAt: now,
          heartbeatAt: now,
          updatedAt: now
        }
      }
    );
    if (updated.modifiedCount === 0) {
      await chunks(connection).deleteMany({ jobId });
      return false;
    }
    return true;
  });
}

/** Jobs que ficaram "running" quando este worker caiu não serão retomados. */
export async function failOrphanedLocalFallbackJobs(config: MongoConfig, workerId: string): Promise<number> {
  if (!config.enabled) return 0;
  return withConnection(config, async (connection) => {
    const now = new Date();
    const result = await jobs(connection).updateMany(
      { status: "running", workerId },
      { $set: { status: "failed", error: "Worker local reiniciado durante a coleta.", finishedAt: now, updatedAt: now } }
    );
    return result.modifiedCount;
  });
}
