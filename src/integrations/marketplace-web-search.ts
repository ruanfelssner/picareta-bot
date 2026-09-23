import mongoose, { type Connection, Types } from "mongoose";
import type { MarketplaceResult } from "../facebook-marketplace.js";
import type { MongoConfig } from "./mongo.js";

/**
 * Fila de buscas do Marketplace disparadas pela tela web (`/marketplace` na Railway)
 * e executadas pelo `pnpm worker` na máquina que tem o perfil do Facebook.
 * O próprio documento da busca guarda logs, prévias e listas finais, e a tela faz polling nele.
 */
export const MARKETPLACE_WEB_SEARCHES_COLLECTION = "marketplace_web_searches";

const LISTINGS_COLLECTION = "listings";
const FLUSH_INTERVAL_MS = 1_500;
const IDLE_TOUCH_INTERVAL_MS = 20_000;
const CANCEL_CHECK_INTERVAL_MS = 3_000;

export type WebSearchStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

/** Somente os campos exibidos na tela; texto bruto/detalhe ficam fora para não inflar o documento. */
export type WebSearchItem = {
  titleRaw: string;
  priceRaw: string | null;
  locationRaw: string | null;
  url: string;
  image: string | null;
  matchScore: number;
  matchApproved: boolean;
  relevanceLevel: MarketplaceResult["relevanceLevel"];
  relevanceScore: number;
  semanticReason: string;
  matchedTokens: string[];
  missingTokens: string[];
  collectedAt: string;
};

export type WebSearchTermState = {
  term: string;
  status: WebSearchStatus;
  total: number | null;
  error: string | null;
};

export type WebSearchLog = { at: Date; term: string | null; message: string };

export type WebSearchDoc = {
  _id: Types.ObjectId;
  terms: string[];
  status: WebSearchStatus;
  cancelRequested: boolean;
  termStates: WebSearchTermState[];
  logs: WebSearchLog[];
  previews: { term: string; item: WebSearchItem }[];
  finals: { term: string; items: WebSearchItem[] }[];
  workerId: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  updatedAt: Date;
};

export type ClaimedWebSearch = {
  id: string;
  terms: string[];
  createdAt: Date;
};

export function toWebSearchItem(item: MarketplaceResult): WebSearchItem {
  return {
    titleRaw: item.titleRaw,
    priceRaw: item.priceRaw,
    locationRaw: item.locationRaw,
    url: item.url,
    image: item.image,
    matchScore: item.matchScore,
    matchApproved: item.matchApproved,
    relevanceLevel: item.relevanceLevel,
    relevanceScore: item.relevanceScore,
    semanticReason: item.semanticReason,
    matchedTokens: [...item.matchedTokens],
    missingTokens: [...item.missingTokens],
    collectedAt: item.collectedAt
  };
}

async function openConnection(config: MongoConfig): Promise<Connection> {
  return mongoose
    .createConnection(config.uri, { dbName: config.dbName, serverSelectionTimeoutMS: 15_000 })
    .asPromise();
}

async function withConnection<T>(config: MongoConfig, fn: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = await openConnection(config);
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

function webSearches(connection: Connection) {
  return connection.collection<WebSearchDoc>(MARKETPLACE_WEB_SEARCHES_COLLECTION);
}

export async function claimNextWebSearch(
  config: MongoConfig,
  workerId: string
): Promise<ClaimedWebSearch | null> {
  if (!config.enabled) {
    return null;
  }

  return withConnection(config, async (connection) => {
    const now = new Date();
    const doc = await webSearches(connection).findOneAndUpdate(
      { status: "PENDING", cancelRequested: { $ne: true } },
      { $set: { status: "RUNNING", workerId, startedAt: now, updatedAt: now } },
      { sort: { createdAt: 1 }, returnDocument: "after" }
    );

    if (!doc) {
      return null;
    }

    return { id: doc._id.toString(), terms: doc.terms, createdAt: doc.createdAt };
  });
}

/** Buscas que ficaram RUNNING quando este worker caiu/reiniciou não serão retomadas. */
export async function failOrphanedWebSearches(config: MongoConfig, workerId: string): Promise<number> {
  if (!config.enabled) {
    return 0;
  }

  return withConnection(config, async (connection) => {
    const now = new Date();
    const result = await webSearches(connection).updateMany(
      { status: "RUNNING", workerId },
      {
        $set: {
          status: "FAILED",
          error: "Worker reiniciado durante a busca.",
          finishedAt: now,
          updatedAt: now
        }
      }
    );
    return result.modifiedCount;
  });
}

export type WebSearchSession = {
  log: (message: string, term?: string | null) => void;
  preview: (term: string, item: MarketplaceResult) => void;
  startTerm: (index: number) => Promise<void>;
  finishTerm: (index: number, term: string, results: MarketplaceResult[]) => Promise<void>;
  failTerm: (index: number, status: "FAILED" | "CANCELLED", error: string) => Promise<void>;
  cancelPendingTerms: () => Promise<void>;
  isCancelRequested: () => Promise<boolean>;
  loadArchivedUrls: () => Promise<Set<string>>;
  finish: (status: "DONE" | "FAILED" | "CANCELLED", error?: string | null) => Promise<void>;
  close: () => Promise<void>;
};

export async function openWebSearchSession(config: MongoConfig, jobId: string): Promise<WebSearchSession> {
  const connection = await openConnection(config);
  const collection = webSearches(connection);
  const filter = { _id: new Types.ObjectId(jobId) };

  let pendingLogs: WebSearchLog[] = [];
  let pendingPreviews: WebSearchDoc["previews"] = [];
  let lastWriteAt = Date.now();
  let flushing: Promise<void> = Promise.resolve();
  let cancelCached = false;
  let lastCancelCheckAt = 0;

  const doFlush = async (): Promise<void> => {
    const logs = pendingLogs;
    const previews = pendingPreviews;
    const needsTouch = Date.now() - lastWriteAt >= IDLE_TOUCH_INTERVAL_MS;
    if (logs.length === 0 && previews.length === 0 && !needsTouch) {
      return;
    }

    pendingLogs = [];
    pendingPreviews = [];
    const push: Record<string, { $each: unknown[] }> = {};
    if (logs.length > 0) push.logs = { $each: logs };
    if (previews.length > 0) push.previews = { $each: previews };

    // updatedAt periódico funciona como heartbeat: a tela marca a busca como travada se parar de mudar.
    await collection.updateOne(filter, {
      $set: { updatedAt: new Date() },
      ...(Object.keys(push).length > 0 ? { $push: push } : {})
    });
    lastWriteAt = Date.now();
  };

  // Serializa os flushes para manter a ordem de logs/prévias.
  const flush = (): Promise<void> => {
    flushing = flushing.then(doFlush).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[web-search ${jobId}] falha ao gravar progresso: ${message}`);
    });
    return flushing;
  };

  const timer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  const setTermFields = async (index: number, fields: Partial<WebSearchTermState>, extra: Record<string, unknown> = {}) => {
    await flush();
    const set: Record<string, unknown> = { updatedAt: new Date(), ...extra };
    for (const [key, value] of Object.entries(fields)) {
      set[`termStates.${index}.${key}`] = value;
    }
    await collection.updateOne(filter, { $set: set });
    lastWriteAt = Date.now();
  };

  return {
    log: (message, term = null) => {
      pendingLogs.push({ at: new Date(), term, message });
    },
    preview: (term, item) => {
      pendingPreviews.push({ term, item: toWebSearchItem(item) });
    },
    startTerm: async (index) => {
      await setTermFields(index, { status: "RUNNING" });
    },
    finishTerm: async (index, term, results) => {
      await flush();
      await collection.updateOne(filter, {
        $set: {
          [`termStates.${index}.status`]: "DONE",
          [`termStates.${index}.total`]: results.length,
          updatedAt: new Date()
        },
        $push: { finals: { term, items: results.map(toWebSearchItem) } }
      });
      lastWriteAt = Date.now();
    },
    failTerm: async (index, status, error) => {
      await setTermFields(index, { status, error });
    },
    cancelPendingTerms: async () => {
      await flush();
      const doc = await collection.findOne(filter, { projection: { termStates: 1 } });
      const set: Record<string, unknown> = { updatedAt: new Date() };
      doc?.termStates.forEach((state, index) => {
        if (state.status === "PENDING" || state.status === "RUNNING") {
          set[`termStates.${index}.status`] = "CANCELLED";
        }
      });
      await collection.updateOne(filter, { $set: set });
    },
    isCancelRequested: async () => {
      if (cancelCached) return true;
      const now = Date.now();
      if (now - lastCancelCheckAt < CANCEL_CHECK_INTERVAL_MS) return false;
      lastCancelCheckAt = now;
      const doc = await collection.findOne(filter, { projection: { cancelRequested: 1, status: 1 } });
      cancelCached = !doc || doc.cancelRequested === true || doc.status === "CANCELLED";
      return cancelCached;
    },
    loadArchivedUrls: async () => {
      const docs = await connection
        .collection<{ url: string; archivedAt?: Date | null }>(LISTINGS_COLLECTION)
        .find({ archivedAt: { $ne: null } }, { projection: { url: 1 } })
        .toArray();
      return new Set(docs.map((doc) => doc.url));
    },
    finish: async (status, error = null) => {
      await flush();
      const now = new Date();
      await collection.updateOne(filter, {
        $set: { status, error, finishedAt: now, updatedAt: now }
      });
    },
    close: async () => {
      clearInterval(timer);
      await flush();
      await connection.close();
    }
  };
}
