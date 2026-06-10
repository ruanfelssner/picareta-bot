import mongoose, { Schema, type Connection, type Model, type Types } from "mongoose";
import type { MarketplaceResult } from "../facebook-marketplace.js";
import { sanitizeCityList, sanitizeStateList } from "../location-filter.js";
import { parsePriceToCents } from "../utils.js";
import type { ZApiDispatchLog, ZApiSendInstruction } from "./zapi.js";

export type MongoConfig = {
  enabled: boolean;
  uri: string;
  dbName: string;
};

export type PersistRunInput = {
  searchTerm: string;
  collectedAt: string;
  outputPath: string;
  total: number;
  semanticRuleName: string;
  results: MarketplaceResult[];
};

export type PersistRunOutput = {
  enabled: boolean;
  runId: string | null;
  upsertedListings: number;
};

export type PersistDispatchInput = {
  runId: string | null;
  searchTerm: string;
  logs: ZApiDispatchLog[];
};

export type NotificationPlan = {
  enabled: boolean;
  toSend: ZApiSendInstruction[];
  skipped: Array<{
    url: string;
    reason: string;
    previousPriceRaw: string | null;
    currentPriceRaw: string | null;
  }>;
};

export type LatestSentState = {
  latestPriceRaw: string | null;
  latestPriceCents: number | null;
  lastSentAt: Date | null;
};

export type MarketplaceCommandType =
  | "SEARCH"
  | "DETAILS"
  | "STOP"
  | "AUCTION_SEARCH"
  | "FIPE_LOOKUP"
  | "CONTACT_SEARCH"
  | "CONTACT_INSERT"
  | "CONFIG_UPDATE";
export type MarketplaceCommandStatus =
  | "PENDING"
  | "RUNNING"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
  | "CANCEL_REQUESTED";
export type WorkerHeartbeatStatus = "IDLE" | "RUNNING";

export type MarketplaceCommandDoc = {
  _id: Types.ObjectId;
  networkId?: Types.ObjectId | null;
  integrationId?: Types.ObjectId | null;
  instanceId?: string | null;
  groupPhone: string;
  senderPhone?: string | null;
  messageId?: string | null;
  commandText: string;
  commandType: MarketplaceCommandType;
  commandArg?: string | null;
  status: MarketplaceCommandStatus;
  cancelRequested?: boolean;
  metadata?: Record<string, unknown> | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ClaimedMarketplaceCommand = {
  id: string;
  groupPhone: string;
  commandType: MarketplaceCommandType;
  commandArg: string | null;
  status: MarketplaceCommandStatus;
  createdAt: Date;
};

type ListingDoc = {
  url: string;
  titleRaw: string;
  priceRaw: string | null;
  locationRaw: string | null;
  rawText: string;
  relevanceLevel: string;
  relevanceScore: number;
  matchScore: number;
  searchTerms: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

type SearchRunDoc = {
  searchTerm: string;
  collectedAt: Date;
  outputPath: string;
  total: number;
  semanticRuleName: string;
  createdAt: Date;
};

type RunResultDoc = {
  runId: Types.ObjectId;
  position: number;
  searchTerm: string;
  url: string;
  titleRaw: string;
  priceRaw: string | null;
  locationRaw: string | null;
  relevanceLevel: string;
  relevanceScore: number;
  matchScore: number;
  matchedTokens: string[];
  missingTokens: string[];
  excludedTokens: string[];
  collectedAt: Date;
  createdAt: Date;
};

type ZApiDispatchDoc = {
  runId: Types.ObjectId | null;
  runIdRaw: string | null;
  destination: string;
  searchTerm: string;
  url: string;
  title: string;
  status: "sent" | "skipped" | "error";
  priceRaw: string | null;
  priceCents: number | null;
  sendReason: "first_time" | "price_drop" | null;
  collectedAt: Date;
  reason: string | null;
  response: unknown | null;
  sentAt: Date;
};

type MarketplaceWorkerHeartbeatDoc = {
  workerId: string;
  status: WorkerHeartbeatStatus;
  commandId: string | null;
  groupPhone: string | null;
  searchTerm: string | null;
  commandCreatedAt: Date | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

const listingSchema = new Schema<ListingDoc>(
  {
    url: { type: String, required: true, unique: true, index: true },
    titleRaw: { type: String, default: "" },
    priceRaw: { type: String, default: null },
    locationRaw: { type: String, default: null },
    rawText: { type: String, default: "" },
    relevanceLevel: { type: String, default: "baixa" },
    relevanceScore: { type: Number, default: 0 },
    matchScore: { type: Number, default: 0 },
    searchTerms: { type: [String], default: [] },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true }
  },
  { versionKey: false, collection: "listings" }
);

listingSchema.index({ lastSeenAt: -1 });

const searchRunSchema = new Schema<SearchRunDoc>(
  {
    searchTerm: { type: String, required: true },
    collectedAt: { type: Date, required: true, index: true },
    outputPath: { type: String, required: true },
    total: { type: Number, required: true },
    semanticRuleName: { type: String, required: true },
    createdAt: { type: Date, required: true }
  },
  { versionKey: false, collection: "search_runs" }
);

const runResultSchema = new Schema<RunResultDoc>(
  {
    runId: { type: Schema.Types.ObjectId, required: true, index: true },
    position: { type: Number, required: true },
    searchTerm: { type: String, required: true },
    url: { type: String, required: true, index: true },
    titleRaw: { type: String, required: true },
    priceRaw: { type: String, default: null },
    locationRaw: { type: String, default: null },
    relevanceLevel: { type: String, required: true },
    relevanceScore: { type: Number, required: true },
    matchScore: { type: Number, required: true },
    matchedTokens: { type: [String], default: [] },
    missingTokens: { type: [String], default: [] },
    excludedTokens: { type: [String], default: [] },
    collectedAt: { type: Date, required: true },
    createdAt: { type: Date, required: true }
  },
  { versionKey: false, collection: "run_results" }
);

const zApiDispatchSchema = new Schema<ZApiDispatchDoc>(
  {
    runId: { type: Schema.Types.ObjectId, default: null, index: true },
    runIdRaw: { type: String, default: null },
    destination: { type: String, required: true, index: true },
    searchTerm: { type: String, required: true },
    url: { type: String, required: true },
    title: { type: String, default: "" },
    status: { type: String, required: true },
    priceRaw: { type: String, default: null },
    priceCents: { type: Number, default: null },
    sendReason: { type: String, default: null },
    collectedAt: { type: Date, required: true },
    reason: { type: String, default: null },
    response: { type: Schema.Types.Mixed, default: null },
    sentAt: { type: Date, required: true, index: true }
  },
  { versionKey: false, collection: "zapi_dispatches" }
);

type MongoModels = {
  Listing: Model<ListingDoc>;
  SearchRun: Model<SearchRunDoc>;
  RunResult: Model<RunResultDoc>;
  ZApiDispatch: Model<ZApiDispatchDoc>;
};

const MARKETPLACE_COMMANDS_COLLECTION = "marketplace_commands";
const MARKETPLACE_WORKER_HEARTBEATS_COLLECTION = "marketplace_worker_heartbeats";

function getMarketplaceCommandsCollection(connection: Connection) {
  return connection.collection<MarketplaceCommandDoc>(MARKETPLACE_COMMANDS_COLLECTION);
}

function getMarketplaceWorkerHeartbeatsCollection(connection: Connection) {
  return connection.collection<MarketplaceWorkerHeartbeatDoc>(
    MARKETPLACE_WORKER_HEARTBEATS_COLLECTION
  );
}

function normalizeCommandArg(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function toDate(value: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }
  return parsed;
}

function pickFirstEnv(env: NodeJS.ProcessEnv, keys: string[]): string {
  for (const key of keys) {
    const value = (env[key] ?? "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function buildMongoConfigFromEnv(
  env: NodeJS.ProcessEnv,
  options?: {
    uriKeys?: string[];
    dbNameKeys?: string[];
    defaultDbName?: string;
  }
): MongoConfig {
  const uriKeys = options?.uriKeys ?? ["MONGO_URI"];
  const dbNameKeys = options?.dbNameKeys ?? ["MONGO_DB_NAME"];
  const defaultDbName = options?.defaultDbName ?? "marketplace";

  const uri = pickFirstEnv(env, uriKeys);
  const dbName = pickFirstEnv(env, dbNameKeys) || defaultDbName;

  return {
    enabled: Boolean(uri),
    uri,
    dbName
  };
}

export function getMongoConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  return buildMongoConfigFromEnv(env);
}

export function getMongoQueueConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  return buildMongoConfigFromEnv(env, {
    uriKeys: ["MONGO_QUEUE_URI", "MONGO_URI"],
    dbNameKeys: ["MONGO_QUEUE_DB_NAME", "MONGO_DB_NAME"],
    defaultDbName: "marketplace"
  });
}

export function getMongoDataConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MongoConfig {
  return buildMongoConfigFromEnv(env, {
    uriKeys: ["MONGO_DATA_URI", "MONGO_URI"],
    dbNameKeys: ["MONGO_DATA_DB_NAME", "MONGO_DB_NAME"],
    defaultDbName: "marketplace"
  });
}

function getOrCreateModel<T>(connection: Connection, name: string, schema: Schema<T>): Model<T> {
  return (connection.models[name] as Model<T> | undefined) ?? connection.model<T>(name, schema);
}

function getModels(connection: Connection): MongoModels {
  return {
    Listing: getOrCreateModel(connection, "Listing", listingSchema),
    SearchRun: getOrCreateModel(connection, "SearchRun", searchRunSchema),
    RunResult: getOrCreateModel(connection, "RunResult", runResultSchema),
    ZApiDispatch: getOrCreateModel(connection, "ZApiDispatch", zApiDispatchSchema)
  };
}

async function ensureSchema(models: MongoModels): Promise<void> {
  await Promise.all([
    models.Listing.createIndexes(),
    models.SearchRun.createIndexes(),
    models.RunResult.createIndexes(),
    models.ZApiDispatch.createIndexes()
  ]);
}

async function withMongo<T>(config: MongoConfig, fn: (models: MongoModels) => Promise<T>): Promise<T> {
  const connection = await mongoose
    .createConnection(config.uri, {
      dbName: config.dbName,
      serverSelectionTimeoutMS: 15_000
    })
    .asPromise();

  try {
    const models = getModels(connection);
    await ensureSchema(models);
    return await fn(models);
  } finally {
    await connection.close();
  }
}

export async function buildNotificationPlanFromMongo(
  config: MongoConfig,
  input: { destination: string; results: MarketplaceResult[] }
): Promise<NotificationPlan> {
  if (!config.enabled) {
    return {
      enabled: false,
      toSend: input.results.map((item) => ({
        item,
        sendReason: "first_time",
        previousPriceRaw: null,
        previousPriceCents: null,
        priceDropCents: null,
        priceDropPercent: null
      })),
      skipped: []
    };
  }

  if (input.results.length === 0) {
    return {
      enabled: true,
      toSend: [],
      skipped: []
    };
  }

  return withMongo(config, async (models) => {
    const urls = Array.from(new Set(input.results.map((item) => item.url)));

    const previous = await models.ZApiDispatch.aggregate<{
      _id: string;
      latestPriceRaw: string | null;
      latestPriceCents: number | null;
    }>([
      {
        $match: {
          destination: input.destination,
          status: "sent",
          url: { $in: urls }
        }
      },
      { $sort: { sentAt: -1 } },
      {
        $group: {
          _id: "$url",
          latestPriceRaw: { $first: "$priceRaw" },
          latestPriceCents: { $first: "$priceCents" }
        }
      }
    ]);

    const previousByUrl = new Map(previous.map((doc) => [doc._id, doc]));
    const toSend: ZApiSendInstruction[] = [];
    const skipped: NotificationPlan["skipped"] = [];

    for (const item of input.results) {
      const currentPriceCents = parsePriceToCents(item.priceRaw);
      const prev = previousByUrl.get(item.url);

      if (!prev) {
        toSend.push({
          item,
          sendReason: "first_time",
          previousPriceRaw: null,
          previousPriceCents: null,
          priceDropCents: null,
          priceDropPercent: null
        });
        continue;
      }

      const previousPriceCents =
        typeof prev.latestPriceCents === "number" ? prev.latestPriceCents : null;

      if (
        currentPriceCents != null &&
        previousPriceCents != null &&
        currentPriceCents < previousPriceCents
      ) {
        const priceDropCents = previousPriceCents - currentPriceCents;
        const priceDropPercent =
          previousPriceCents > 0 ? (priceDropCents / previousPriceCents) * 100 : null;

        toSend.push({
          item,
          sendReason: "price_drop",
          previousPriceRaw: prev.latestPriceRaw ?? null,
          previousPriceCents,
          priceDropCents,
          priceDropPercent
        });
        continue;
      }

      skipped.push({
        url: item.url,
        reason:
          currentPriceCents == null || previousPriceCents == null
            ? "sem preço comparável para detectar queda"
            : "sem queda de preço",
        previousPriceRaw: prev.latestPriceRaw ?? null,
        currentPriceRaw: item.priceRaw
      });
    }

    return {
      enabled: true,
      toSend,
      skipped
    };
  });
}

export async function loadLatestSentStateByDestination(
  config: MongoConfig,
  destination: string
): Promise<Map<string, LatestSentState>> {
  if (!config.enabled) {
    return new Map();
  }

  return withMongo(config, async (models) => {
    const docs = await models.ZApiDispatch.aggregate<{
      _id: string;
      latestPriceRaw: string | null;
      latestPriceCents: number | null;
      lastSentAt: Date | null;
    }>([
      {
        $match: {
          destination,
          status: "sent"
        }
      },
      { $sort: { sentAt: -1 } },
      {
        $group: {
          _id: "$url",
          latestPriceRaw: { $first: "$priceRaw" },
          latestPriceCents: { $first: "$priceCents" },
          lastSentAt: { $first: "$sentAt" }
        }
      }
    ]);

    return new Map(
      docs.map((doc) => [
        doc._id,
        {
          latestPriceRaw: doc.latestPriceRaw ?? null,
          latestPriceCents:
            typeof doc.latestPriceCents === "number" ? doc.latestPriceCents : null,
          lastSentAt: doc.lastSentAt ?? null
        }
      ])
    );
  });
}

export async function persistRunToMongo(
  config: MongoConfig,
  input: PersistRunInput
): Promise<PersistRunOutput> {
  if (!config.enabled) {
    return {
      enabled: false,
      runId: null,
      upsertedListings: 0
    };
  }

  return withMongo(config, async (models) => {
    const now = new Date();

    const run = await models.SearchRun.create({
      searchTerm: input.searchTerm,
      collectedAt: toDate(input.collectedAt),
      outputPath: input.outputPath,
      total: input.total,
      semanticRuleName: input.semanticRuleName,
      createdAt: now
    });

    const listingOps = input.results.map((item) => ({
      updateOne: {
        filter: { url: item.url },
        update: {
          $set: {
            titleRaw: item.titleRaw,
            priceRaw: item.priceRaw,
            locationRaw: item.locationRaw,
            rawText: item.rawText,
            relevanceLevel: item.relevanceLevel,
            relevanceScore: item.relevanceScore,
            matchScore: item.matchScore,
            lastSeenAt: now,
            updatedAt: now
          },
          $setOnInsert: {
            url: item.url,
            firstSeenAt: now,
            createdAt: now
          },
          $addToSet: {
            searchTerms: input.searchTerm
          }
        },
        upsert: true
      }
    }));

    const listingWrite =
      listingOps.length > 0 ? await models.Listing.bulkWrite(listingOps, { ordered: false }) : null;

    const resultDocs = input.results.map((item, index) => ({
      runId: run._id,
      position: index + 1,
      searchTerm: input.searchTerm,
      url: item.url,
      titleRaw: item.titleRaw,
      priceRaw: item.priceRaw,
      locationRaw: item.locationRaw,
      relevanceLevel: item.relevanceLevel,
      relevanceScore: item.relevanceScore,
      matchScore: item.matchScore,
      matchedTokens: item.matchedTokens,
      missingTokens: item.missingTokens,
      excludedTokens: item.excludedTokens,
      collectedAt: toDate(item.collectedAt),
      createdAt: now
    }));

    if (resultDocs.length > 0) {
      await models.RunResult.insertMany(resultDocs, { ordered: false });
    }

    return {
      enabled: true,
      runId: run._id.toString(),
      upsertedListings: (listingWrite?.upsertedCount ?? 0) + (listingWrite?.modifiedCount ?? 0)
    };
  });
}

export async function persistZApiDispatchesToMongo(
  config: MongoConfig,
  input: PersistDispatchInput
): Promise<void> {
  if (!config.enabled || input.logs.length === 0) {
    return;
  }

  await withMongo(config, async (models) => {
    const now = new Date();
    const runId =
      input.runId && mongoose.isValidObjectId(input.runId)
        ? new mongoose.Types.ObjectId(input.runId)
        : null;

    const docs = input.logs.map((log) => ({
      runId,
      runIdRaw: input.runId,
      destination: log.destination,
      searchTerm: input.searchTerm,
      url: log.url,
      title: log.title,
      status: log.status,
      priceRaw: log.priceRaw ?? null,
      priceCents: log.priceCents ?? null,
      sendReason: log.sendReason ?? null,
      collectedAt: toDate(log.collectedAt),
      reason: log.reason ?? null,
      response: log.response ?? null,
      sentAt: now
    }));

    if (docs.length > 0) {
      await models.ZApiDispatch.insertMany(docs, { ordered: false });
    }
  });
}

export async function claimNextMarketplaceSearchCommand(
  config: MongoConfig
): Promise<ClaimedMarketplaceCommand | null> {
  if (!config.enabled) {
    return null;
  }

  return withMongo(config, async (models) => {
    const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
    const now = new Date();

    const result = await commands.findOneAndUpdate(
      {
        status: "PENDING",
        commandType: "SEARCH",
        cancelRequested: { $ne: true }
      },
      {
        $set: {
          status: "RUNNING",
          startedAt: now,
          updatedAt: now
        }
      },
      {
        sort: { createdAt: 1 },
        returnDocument: "after"
      }
    );

    if (!result) {
      return null;
    }

    return {
      id: result._id.toString(),
      groupPhone: result.groupPhone,
      commandType: result.commandType,
      commandArg: normalizeCommandArg(result.commandArg),
      status: result.status,
      createdAt: result.createdAt
    };
  });
}

export async function isMarketplaceCommandCancelRequested(
  config: MongoConfig,
  commandId: string
): Promise<boolean> {
  if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
    return false;
  }

  return withMongo(config, async (models) => {
    const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
    const command = await commands.findOne(
      { _id: new mongoose.Types.ObjectId(commandId) },
      { projection: { status: 1, cancelRequested: 1 } }
    );

    if (!command) {
      return false;
    }

    return (
      command.cancelRequested === true ||
      command.status === "CANCEL_REQUESTED" ||
      command.status === "CANCELLED"
    );
  });
}

export async function markMarketplaceCommandDone(
  config: MongoConfig,
  commandId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
    return;
  }

  await withMongo(config, async (models) => {
    const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
    const now = new Date();

    await commands.updateOne(
      { _id: new mongoose.Types.ObjectId(commandId) },
      {
        $set: {
          status: "DONE",
          metadata,
          updatedAt: now,
          finishedAt: now
        }
      }
    );
  });
}

export async function markMarketplaceCommandCancelled(
  config: MongoConfig,
  commandId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
    return;
  }

  await withMongo(config, async (models) => {
    const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
    const now = new Date();

    await commands.updateOne(
      { _id: new mongoose.Types.ObjectId(commandId) },
      {
        $set: {
          status: "CANCELLED",
          cancelRequested: true,
          metadata,
          updatedAt: now,
          finishedAt: now
        }
      }
    );
  });
}

export async function markMarketplaceCommandFailed(
  config: MongoConfig,
  commandId: string,
  errorMessage: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
    return;
  }

  await withMongo(config, async (models) => {
    const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
    const now = new Date();

    await commands.updateOne(
      { _id: new mongoose.Types.ObjectId(commandId) },
      {
        $set: {
          status: "FAILED",
          metadata: {
            ...metadata,
            errorMessage
          },
          updatedAt: now,
          finishedAt: now
        }
      }
    );
  });
}

export async function touchMarketplaceWorkerHeartbeat(
  config: MongoConfig,
  input: {
    workerId: string;
    status: WorkerHeartbeatStatus;
    commandId?: string | null;
    groupPhone?: string | null;
    searchTerm?: string | null;
    commandCreatedAt?: Date | null;
  }
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  const workerId = input.workerId.trim();
  if (!workerId) {
    return;
  }

  await withMongo(config, async (models) => {
    const collection = getMarketplaceWorkerHeartbeatsCollection(models.SearchRun.db);
    const now = new Date();

    await collection.updateOne(
      { workerId },
      {
        $set: {
          workerId,
          status: input.status,
          commandId: input.commandId ?? null,
          groupPhone: input.groupPhone ?? null,
          searchTerm: input.searchTerm ?? null,
          commandCreatedAt: input.commandCreatedAt ?? null,
          lastSeenAt: now,
          updatedAt: now
        },
        $setOnInsert: {
          createdAt: now
        }
      },
      { upsert: true }
    );
  });
}

export async function claimNextAnyPendingCommand(
  config: MongoConfig
): Promise<ClaimedMarketplaceCommand | null> {
  if (!config.enabled) {
    return null;
  }

  return withMongo(config, async (models) => {
    const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
    const now = new Date();

    const result = await commands.findOneAndUpdate(
      {
        status: "PENDING",
        cancelRequested: { $ne: true }
      },
      {
        $set: {
          status: "RUNNING",
          startedAt: now,
          updatedAt: now
        }
      },
      {
        sort: { createdAt: 1 },
        returnDocument: "after"
      }
    );

    if (!result) {
      return null;
    }

    return {
      id: result._id.toString(),
      groupPhone: result.groupPhone,
      commandType: result.commandType,
      commandArg: normalizeCommandArg(result.commandArg),
      status: result.status,
      createdAt: result.createdAt
    };
  });
}

// ─── Auction filters ──────────────────────────────────────────────────────────

export type AuctionFilters = {
  locations: string[];
  states: string[];
  cities: string[];
  comboRules: AuctionComboRule[];
  updatedAt: Date;
};

export type AuctionComboRule = {
  id: string;
  brand: string | null;
  model: string | null;
  text: string | null;
  minYear: number | null;
  mode: "include" | "exclude";
  enabled: boolean;
};

export type AuctionLegacyMigrationResult = {
  migrated: boolean;
  added: number;
  reason: "migrated" | "preset_seeded" | "already_has_combos" | "legacy_empty" | "mongo_disabled" | "not_found";
  filters: AuctionFilters;
};

const DEFAULT_AUCTION_FILTERS: Omit<AuctionFilters, "updatedAt"> = {
  locations: [],
  states: ["PR"],
  cities: [],
  comboRules: []
};

const LEGACY_PRESET_BRANDS = ["BMW", "AUDI", "MERCEDES-BENZ", "VOLKSWAGEN", "JEEP"];
const LEGACY_PRESET_MODELS = [
  "320", "328", "330", "M3", "M4", "M5",
  "A200", "C180", "C200", "C250", "C300", "GLA",
  "Polo Highline", "Golf GTI", "Jetta", "GLI", "Virtus", "Nivus", "Tiguan",
  "A3", "Avant", "Q3", "Q5",
  "Commander", "Compass"
];
const LEGACY_PRESET_MIN_YEAR = 2010;

const AUCTION_FILTERS_COLLECTION = "auction_filters";
const CONTACTS_COLLECTION = "contacts";
const AUCTION_RESULTS_COLLECTION = "auction_results";
const AUCTION_WHATSAPP_DISPATCHES_COLLECTION = "auction_whatsapp_dispatches";
const MAX_AUCTION_COMBO_RULES = 500;
const AUCTION_VEHICLE_OVERRIDES_COLLECTION = "auction_vehicle_overrides";
const HIDDEN_AUCTION_VEHICLES_COLLECTION = "hidden_auction_vehicles";
const COPART_LIVE_AUCTION_EVENTS_COLLECTION = "copart_live_auction_events";

type AuctionFilterDoc = {
  _id: string;
  locations?: string[];
  states?: string[];
  cities?: string[];
  comboRules?: AuctionComboRule[];
  brands?: string[];
  models?: string[];
  minYear?: number;
  minPrice?: number;
  damageTypes?: string[];
  negativeWords?: string[];
  updatedAt: Date;
};

export type ContactDoc = {
  _id?: unknown;
  category: string;
  name: string;
  phone: string;
  notes: string | null;
  addedBy: string;
  addedAt: Date;
  createdAt: Date;
};

export type AuctionResultDoc = {
  _id?: unknown;
  source: string;
  brand: string;
  model: string;
  year: number | null;
  damage: string | null;
  price: number | null;
  priceRaw: string | null;
  imageUrls: string[];
  description: string;
  url: string;
  auctionDate: Date | null;
  km?: string | null;
  color?: string | null;
  sentToGroup: boolean;
  scrapedAt: Date;
  createdAt: Date;
};

export type AuctionSentVehicle = {
  url: string;
  source: string;
  brand: string;
  model: string;
  year: number | null;
  damage: string | null;
  imageUrl: string | null;
  auctionDate: Date | null;
  targetPhone: string;
  sentAt: Date;
  sentPrice: number | null;
  sentPriceRaw: string | null;
  sentPriceLabel: string | null;
  lastKnownPrice: number | null;
  lastKnownPriceRaw: string | null;
  lastKnownPriceLabel: string | null;
  lastCheckedAt: Date | null;
  sold: boolean;
  soldAt: Date | null;
  soldPrice: number | null;
  soldPriceRaw: string | null;
  soldPriceLabel: string | null;
  soldNotifiedAt: Date | null;
  soldNotifyError: string | null;
  fipePrice: number | null;
  fipePriceRaw: string | null;
  fipeCode: string | null;
  fipeReferenceMonth: string | null;
  fipeModelYear: number | null;
  fipeFuel: string | null;
  fipeBrandMatched: string | null;
  fipeModelMatched: string | null;
  fipeCheckedAt: Date | null;
  fipeLookupError: string | null;
  archivedAt: Date | null;
  archiveReason: string | null;
  updatedAt: Date;
  createdAt: Date;
};

type AuctionSentVehicleDoc = {
  _id?: unknown;
  url: string;
  source: string;
  brand: string;
  model: string;
  year: number | null;
  damage: string | null;
  imageUrl: string | null;
  auctionDate: Date | null;
  targetPhone: string;
  sentAt: Date;
  sentPrice: number | null;
  sentPriceRaw: string | null;
  sentPriceLabel: string | null;
  lastKnownPrice: number | null;
  lastKnownPriceRaw: string | null;
  lastKnownPriceLabel: string | null;
  lastCheckedAt: Date | null;
  sold: boolean;
  soldAt: Date | null;
  soldPrice: number | null;
  soldPriceRaw: string | null;
  soldPriceLabel: string | null;
  soldNotifiedAt: Date | null;
  soldNotifyError: string | null;
  fipePrice: number | null;
  fipePriceRaw: string | null;
  fipeCode: string | null;
  fipeReferenceMonth: string | null;
  fipeModelYear: number | null;
  fipeFuel: string | null;
  fipeBrandMatched: string | null;
  fipeModelMatched: string | null;
  fipeCheckedAt: Date | null;
  fipeLookupError: string | null;
  archivedAt?: Date | null;
  archiveReason?: string | null;
  updatedAt: Date;
  createdAt: Date;
};

export type AuctionVehicleOverride = {
  url: string;
  manualFipe: number | null;
  manualCostsTotal: number | null;
  notes: string | null;
  fipePriceRaw: string | null;
  fipeCode: string | null;
  fipeReferenceMonth: string | null;
  fipeModelYear: number | null;
  fipeFuel: string | null;
  fipeBrandMatched: string | null;
  fipeModelMatched: string | null;
  fipeCheckedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

type AuctionVehicleOverrideDoc = {
  _id?: unknown;
  url: string;
  manualFipe: number | null;
  manualCostsTotal: number | null;
  notes: string | null;
  fipePriceRaw?: string | null;
  fipeCode?: string | null;
  fipeReferenceMonth?: string | null;
  fipeModelYear?: number | null;
  fipeFuel?: string | null;
  fipeBrandMatched?: string | null;
  fipeModelMatched?: string | null;
  fipeCheckedAt?: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

type HiddenAuctionVehicleDoc = {
  _id?: unknown;
  url: string;
  source: string;
  brand: string;
  model: string;
  year: number | null;
  damage: string | null;
  reason: string | null;
  hiddenAt: Date;
  updatedAt: Date;
  createdAt: Date;
};

export type HiddenAuctionVehicle = {
  url: string;
  source: string;
  brand: string;
  model: string;
  year: number | null;
  damage: string | null;
  reason: string | null;
  hiddenAt: Date;
  updatedAt: Date;
  createdAt: Date;
};

export type CopartLiveEventType = "snapshot" | "bid" | "closed" | "sale" | "status";
export type CopartLiveSaleStatus = "open" | "sold" | "conditional" | null;

export type CopartLiveAuctionEvent = {
  eventKey: string;
  source: "copart-live";
  auctionId: string | null;
  lot: string | null;
  code: string | null;
  description: string | null;
  version: string | null;
  yearModel: string | null;
  fipe: number | null;
  fipeRaw: string | null;
  damage: string | null;
  yard: string | null;
  bid: number | null;
  bidRaw: string | null;
  saleStatus: CopartLiveSaleStatus;
  eventType: CopartLiveEventType;
  fipePercent: number | null;
  imageUrl: string | null;
  vehicleUrl: string | null;
  message: string | null;
  observedAt: Date;
  updatedAt: Date;
  createdAt: Date;
};

type CopartLiveAuctionEventDoc = CopartLiveAuctionEvent & {
  _id?: unknown;
};

function normalizeDamageText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function isLargeDamageLabel(value: string | null | undefined): boolean {
  const normalized = normalizeDamageText(value ?? "");
  if (!normalized) return false;
  return (
    normalized.includes("grande") ||
    normalized.includes("sucata") ||
    normalized.includes("perda total")
  );
}

function isLargeDamageHiddenVehicle(doc: Pick<HiddenAuctionVehicleDoc, "damage" | "url" | "reason">): boolean {
  if (isLargeDamageLabel(doc.damage ?? null)) return true;
  if (isLargeDamageLabel(doc.reason ?? null)) return true;

  const normalizedUrl = normalizeDamageText(doc.url ?? "");
  if (!normalizedUrl) return false;
  return (
    normalizedUrl.includes("grande-monta") ||
    normalizedUrl.includes("grande monta") ||
    normalizedUrl.includes("sucata") ||
    normalizedUrl.includes("perda-total") ||
    normalizedUrl.includes("perda total")
  );
}

export async function getAuctionFilters(config: MongoConfig): Promise<AuctionFilters> {
  if (!config.enabled) {
    return { ...DEFAULT_AUCTION_FILTERS, updatedAt: new Date() };
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionFilterDoc>(AUCTION_FILTERS_COLLECTION);
    const doc = await col.findOne({ _id: "default" });
    if (!doc) {
      return { ...DEFAULT_AUCTION_FILTERS, updatedAt: new Date() };
    }
    const comboRulesFromDoc = sanitizeComboRules(doc.comboRules ?? []);
    const comboRules = comboRulesFromDoc.length > 0
      ? comboRulesFromDoc
      : buildLegacyComboRulesFromDoc(doc);
    return {
      locations: sanitizeStringList(doc.locations),
      states: sanitizeStateList(doc.states),
      cities: sanitizeCityList(doc.cities),
      comboRules,
      updatedAt: doc.updatedAt
    };
  });
}

function sanitizeStringList(
  input: unknown,
  options?: { uppercase?: boolean; lowercase?: boolean }
): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of input) {
    if (typeof raw !== "string") continue;
    let value = raw.trim();
    if (!value) continue;
    if (options?.uppercase) value = value.toUpperCase();
    if (options?.lowercase) value = value.toLowerCase();
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function sanitizeNumberInRange(
  value: unknown,
  min: number,
  max: number
): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) return undefined;
  return rounded;
}

function sanitizeComboRules(input: unknown): AuctionComboRule[] {
  if (!Array.isArray(input)) return [];
  const out: AuctionComboRule[] = [];

  for (let i = 0; i < input.length && out.length < MAX_AUCTION_COMBO_RULES; i += 1) {
    const raw = input[i];
    if (!raw || typeof raw !== "object") continue;
    const obj = raw as Record<string, unknown>;

    const brandRaw = typeof obj.brand === "string" ? obj.brand.trim() : "";
    const modelRaw = typeof obj.model === "string" ? obj.model.trim() : "";
    const textRaw = typeof obj.text === "string" ? obj.text.trim() : "";
    const minYear = sanitizeNumberInRange(obj.minYear, 1900, 2035) ?? null;
    const modeRaw = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
    const mode: "include" | "exclude" = modeRaw === "exclude" ? "exclude" : "include";
    const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
    const idRaw = typeof obj.id === "string" ? obj.id.trim() : "";
    const id = idRaw || `rule_${Date.now()}_${i + 1}`;

    out.push({
      id,
      brand: brandRaw || null,
      model: modelRaw || null,
      text: textRaw || null,
      minYear,
      mode,
      enabled
    });
  }

  return out;
}

function sanitizeAuctionFiltersUpdate(
  update: Partial<Omit<AuctionFilters, "updatedAt">>
): Partial<Omit<AuctionFilters, "updatedAt">> {
  const sanitized: Partial<Omit<AuctionFilters, "updatedAt">> = {};

  if (update.locations !== undefined) {
    sanitized.locations = sanitizeStringList(update.locations);
  }
  if (update.states !== undefined) {
    sanitized.states = sanitizeStateList(update.states);
  }
  if (update.cities !== undefined) {
    sanitized.cities = sanitizeCityList(update.cities);
  }
  if (update.comboRules !== undefined) {
    sanitized.comboRules = sanitizeComboRules(update.comboRules);
  }

  return sanitized;
}

function normalizeLegacyToken(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildLegacyComboRulesFromDoc(doc: AuctionFilterDoc): AuctionComboRule[] {
  const brands = sanitizeStringList(doc.brands, { uppercase: true });
  const models = sanitizeStringList(doc.models);
  const minYear = sanitizeNumberInRange(doc.minYear, 1900, 2035) ?? null;

  if (brands.length === 0 && models.length === 0) {
    return [];
  }

  const byLength = [...brands].sort((a, b) => b.length - a.length);
  const seen = new Set<string>();
  const out: AuctionComboRule[] = [];

  const pushRule = (brand: string | null, model: string | null, text: string | null, idx: number) => {
    const normalizedBrand = brand?.trim() || null;
    const normalizedModel = model?.trim() || null;
    const normalizedText = text?.trim() || null;
    const key = `${normalizeLegacyToken(normalizedBrand ?? "")}|${normalizeLegacyToken(normalizedModel ?? "")}|${normalizeLegacyToken(normalizedText ?? "")}|${minYear ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      id: `legacy_rule_${idx + 1}`,
      brand: normalizedBrand,
      model: normalizedModel,
      text: normalizedText,
      minYear,
      mode: "include",
      enabled: true
    });
  };

  if (models.length > 0) {
    models.forEach((model, idx) => {
      const normalizedModel = normalizeLegacyToken(model);
      const matchedBrand =
        byLength.find((brand) => {
          const b = normalizeLegacyToken(brand);
          if (!b) return false;
          return normalizedModel === b || normalizedModel.startsWith(`${b} `) || normalizedModel.includes(` ${b} `);
        }) ?? null;
      pushRule(matchedBrand, model, null, idx);
    });
  } else {
    byLength.forEach((brand, idx) => {
      pushRule(brand, null, null, idx);
    });
  }

  return sanitizeComboRules(out);
}

function buildLegacyPresetComboRules(): AuctionComboRule[] {
  const now = new Date();
  const presetDoc: AuctionFilterDoc = {
    _id: "legacy_preset",
    updatedAt: now,
    brands: LEGACY_PRESET_BRANDS,
    models: LEGACY_PRESET_MODELS,
    minYear: LEGACY_PRESET_MIN_YEAR
  };

  return buildLegacyComboRulesFromDoc(presetDoc).map((rule, idx) => ({
    ...rule,
    id: `preset_rule_${idx + 1}`
  }));
}

export async function upsertAuctionFilters(
  config: MongoConfig,
  update: Partial<Omit<AuctionFilters, "updatedAt">>
): Promise<AuctionFilters> {
  const now = new Date();
  const sanitizedUpdate = sanitizeAuctionFiltersUpdate(update);

  if (!config.enabled) {
    return { ...DEFAULT_AUCTION_FILTERS, ...sanitizedUpdate, updatedAt: now };
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionFilterDoc>(AUCTION_FILTERS_COLLECTION);
    const setOnInsertDefaults: Record<string, unknown> = {
      _id: "default",
      locations: DEFAULT_AUCTION_FILTERS.locations,
      states: DEFAULT_AUCTION_FILTERS.states,
      cities: DEFAULT_AUCTION_FILTERS.cities,
      comboRules: DEFAULT_AUCTION_FILTERS.comboRules
    };
    for (const key of Object.keys(sanitizedUpdate)) {
      delete setOnInsertDefaults[key];
    }

    await col.updateOne(
      { _id: "default" },
      {
        $set: { ...sanitizedUpdate, updatedAt: now },
        $setOnInsert: setOnInsertDefaults
      },
      { upsert: true }
    );

    const doc = await col.findOne({ _id: "default" });
    if (!doc) {
      return { ...DEFAULT_AUCTION_FILTERS, ...sanitizedUpdate, updatedAt: now };
    }

    return {
      locations: sanitizeStringList(doc.locations),
      states: sanitizeStateList(doc.states),
      cities: sanitizeCityList(doc.cities),
      comboRules: sanitizeComboRules(doc.comboRules ?? []),
      updatedAt: doc.updatedAt
    };
  });
}

export async function migrateLegacyAuctionFiltersToCombos(
  config: MongoConfig,
  options?: { force?: boolean }
): Promise<AuctionLegacyMigrationResult> {
  if (!config.enabled) {
    const filters = { ...DEFAULT_AUCTION_FILTERS, updatedAt: new Date() };
    return {
      migrated: false,
      added: 0,
      reason: "mongo_disabled",
      filters
    };
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionFilterDoc>(AUCTION_FILTERS_COLLECTION);
    const doc = await col.findOne({ _id: "default" });
    if (!doc) {
      const filters = { ...DEFAULT_AUCTION_FILTERS, updatedAt: new Date() };
      return {
        migrated: false,
        added: 0,
        reason: "not_found" as const,
        filters
      };
    }

    const currentCombos = sanitizeComboRules(doc.comboRules ?? []);
    if (currentCombos.length > 0 && !options?.force) {
      return {
        migrated: false,
        added: 0,
        reason: "already_has_combos" as const,
        filters: {
          locations: sanitizeStringList(doc.locations),
          states: sanitizeStateList(doc.states),
          cities: sanitizeCityList(doc.cities),
          comboRules: currentCombos,
          updatedAt: doc.updatedAt
        }
      };
    }

    const migratedRules = buildLegacyComboRulesFromDoc(doc);
    const presetRules = buildLegacyPresetComboRules();
    const finalRules = migratedRules.length > 0 ? migratedRules : presetRules;
    const usedPreset = migratedRules.length === 0;

    if (finalRules.length === 0) {
      return {
        migrated: false,
        added: 0,
        reason: "legacy_empty" as const,
        filters: {
          locations: sanitizeStringList(doc.locations),
          states: sanitizeStateList(doc.states),
          cities: sanitizeCityList(doc.cities),
          comboRules: currentCombos,
          updatedAt: doc.updatedAt
        }
      };
    }

    const now = new Date();
    await col.updateOne(
      { _id: "default" },
      {
        $set: {
          comboRules: finalRules,
          updatedAt: now
        }
      }
    );

    return {
      migrated: true,
      added: finalRules.length,
      reason: usedPreset ? "preset_seeded" as const : "migrated" as const,
      filters: {
        locations: sanitizeStringList(doc.locations),
        states: sanitizeStateList(doc.states),
        cities: sanitizeCityList(doc.cities),
        comboRules: finalRules,
        updatedAt: now
      }
    };
  });
}

export async function seedAuctionFilters(config: MongoConfig): Promise<void> {
  if (!config.enabled) {
    return;
  }

  await withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionFilterDoc>(AUCTION_FILTERS_COLLECTION);
    const exists = await col.findOne({ _id: "default" });
    if (!exists) {
      await col.insertOne({
        _id: "default",
        ...DEFAULT_AUCTION_FILTERS,
        updatedAt: new Date()
      });
    }
  });
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export const CONTACT_CATEGORIES = [
  "lataria",
  "pneus",
  "rodas",
  "transmissao",
  "motor",
  "pecas",
  "airbag",
  "modulos",
  "injecao",
  "autocenter"
] as const;

export type ContactCategory = (typeof CONTACT_CATEGORIES)[number];

export async function addContact(
  config: MongoConfig,
  contact: Omit<ContactDoc, "_id" | "createdAt">
): Promise<void> {
  if (!config.enabled) {
    return;
  }

  await withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<ContactDoc>(CONTACTS_COLLECTION);
    await col.insertOne({
      ...contact,
      createdAt: new Date()
    });
  });
}

export async function searchContacts(
  config: MongoConfig,
  category?: string
): Promise<ContactDoc[]> {
  if (!config.enabled) {
    return [];
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<ContactDoc>(CONTACTS_COLLECTION);
    const filter = category ? { category: category.toLowerCase() } : {};
    return col.find(filter).sort({ addedAt: -1 }).toArray();
  });
}

// ─── Auction results ──────────────────────────────────────────────────────────

export async function saveAuctionResults(
  config: MongoConfig,
  results: Omit<AuctionResultDoc, "_id" | "createdAt" | "sentToGroup">[]
): Promise<void> {
  if (!config.enabled || results.length === 0) {
    return;
  }

  await withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionResultDoc>(AUCTION_RESULTS_COLLECTION);
    const now = new Date();

    const ops = results.map((result) => ({
      updateOne: {
        filter: { url: result.url },
        update: {
          $set: { ...result, scrapedAt: now },
          $setOnInsert: { sentToGroup: false, createdAt: now }
        },
        upsert: true
      }
    }));

    await col.bulkWrite(ops, { ordered: false });
  });
}

export async function getUnsentAuctionResults(config: MongoConfig): Promise<AuctionResultDoc[]> {
  if (!config.enabled) {
    return [];
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionResultDoc>(AUCTION_RESULTS_COLLECTION);
    return col
      .find({ sentToGroup: false })
      .sort({ price: 1 })
      .toArray();
  });
}

export async function markAuctionResultsSent(
  config: MongoConfig,
  urls: string[]
): Promise<void> {
  if (!config.enabled || urls.length === 0) {
    return;
  }

  await withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionResultDoc>(AUCTION_RESULTS_COLLECTION);
    await col.updateMany({ url: { $in: urls } }, { $set: { sentToGroup: true } });
  });
}

function mapAuctionSentVehicleDoc(doc: AuctionSentVehicleDoc): AuctionSentVehicle {
  return {
    url: doc.url,
    source: doc.source ?? "",
    brand: doc.brand ?? "",
    model: doc.model ?? "",
    year: typeof doc.year === "number" && Number.isFinite(doc.year) ? doc.year : null,
    damage: doc.damage ?? null,
    imageUrl: doc.imageUrl ?? null,
    auctionDate: doc.auctionDate ?? null,
    targetPhone: doc.targetPhone ?? "",
    sentAt: doc.sentAt,
    sentPrice: typeof doc.sentPrice === "number" && Number.isFinite(doc.sentPrice) ? doc.sentPrice : null,
    sentPriceRaw: doc.sentPriceRaw ?? null,
    sentPriceLabel: doc.sentPriceLabel ?? null,
    lastKnownPrice:
      typeof doc.lastKnownPrice === "number" && Number.isFinite(doc.lastKnownPrice)
        ? doc.lastKnownPrice
        : null,
    lastKnownPriceRaw: doc.lastKnownPriceRaw ?? null,
    lastKnownPriceLabel: doc.lastKnownPriceLabel ?? null,
    lastCheckedAt: doc.lastCheckedAt ?? null,
    sold: doc.sold === true,
    soldAt: doc.soldAt ?? null,
    soldPrice:
      typeof doc.soldPrice === "number" && Number.isFinite(doc.soldPrice) ? doc.soldPrice : null,
    soldPriceRaw: doc.soldPriceRaw ?? null,
    soldPriceLabel: doc.soldPriceLabel ?? null,
    soldNotifiedAt: doc.soldNotifiedAt ?? null,
    soldNotifyError: doc.soldNotifyError ?? null,
    fipePrice: typeof doc.fipePrice === "number" && Number.isFinite(doc.fipePrice) ? doc.fipePrice : null,
    fipePriceRaw: doc.fipePriceRaw ?? null,
    fipeCode: doc.fipeCode ?? null,
    fipeReferenceMonth: doc.fipeReferenceMonth ?? null,
    fipeModelYear:
      typeof doc.fipeModelYear === "number" && Number.isFinite(doc.fipeModelYear)
        ? doc.fipeModelYear
        : null,
    fipeFuel: doc.fipeFuel ?? null,
    fipeBrandMatched: doc.fipeBrandMatched ?? null,
    fipeModelMatched: doc.fipeModelMatched ?? null,
    fipeCheckedAt: doc.fipeCheckedAt ?? null,
    fipeLookupError: doc.fipeLookupError ?? null,
    archivedAt: doc.archivedAt ?? null,
    archiveReason: doc.archiveReason ?? null,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt
  };
}

function mergeSentVehicleWithOverride(
  item: AuctionSentVehicle,
  override: AuctionVehicleOverride | undefined
): AuctionSentVehicle {
  if (!override || override.manualFipe == null) return item;

  return {
    ...item,
    fipePrice: override.manualFipe,
    fipePriceRaw: override.fipePriceRaw ?? item.fipePriceRaw,
    fipeCode: override.fipeCode ?? item.fipeCode,
    fipeReferenceMonth: override.fipeReferenceMonth ?? item.fipeReferenceMonth,
    fipeModelYear: override.fipeModelYear ?? item.fipeModelYear,
    fipeFuel: override.fipeFuel ?? item.fipeFuel,
    fipeBrandMatched: override.fipeBrandMatched ?? item.fipeBrandMatched,
    fipeModelMatched: override.fipeModelMatched ?? item.fipeModelMatched,
    fipeCheckedAt: override.fipeCheckedAt ?? item.fipeCheckedAt
  };
}

export async function upsertAuctionSentVehicles(
  config: MongoConfig,
  input: {
    targetPhone: string;
    vehicles: Array<{
      url: string;
      source?: string;
      brand?: string;
      model?: string;
      year?: number | null;
      damage?: string | null;
      price?: number | null;
      priceRaw?: string | null;
      priceLabel?: string | null;
      auctionDate?: string | Date | null;
      imageUrls?: string[];
      fipe?: number | null;
      fipeRaw?: string | null;
      fipeCode?: string | null;
      fipeReferenceMonth?: string | null;
      fipeModelYear?: number | null;
      fipeFuel?: string | null;
      fipeBrandMatched?: string | null;
      fipeModelMatched?: string | null;
      fipeCheckedAt?: string | Date | null;
    }>;
  }
): Promise<void> {
  if (!config.enabled || !Array.isArray(input.vehicles) || input.vehicles.length === 0) {
    return;
  }

  const targetPhone = input.targetPhone.trim();
  const now = new Date();
  const byUrl = new Map<string, AuctionSentVehicleDoc>();

  for (const vehicle of input.vehicles) {
    const url = String(vehicle.url ?? "").trim();
    if (!url) continue;

    const source = normalizeOptionalText(vehicle.source) ?? "";
    const brand = normalizeOptionalText(vehicle.brand) ?? "";
    const model = normalizeOptionalText(vehicle.model) ?? "";
    const year = typeof vehicle.year === "number" && Number.isFinite(vehicle.year) ? vehicle.year : null;
    const damage = normalizeOptionalText(vehicle.damage);
    const price = normalizeOptionalMoney(vehicle.price);
    const priceRaw = normalizeOptionalText(vehicle.priceRaw);
    const priceLabel = normalizeOptionalText(vehicle.priceLabel);
    const auctionDate = normalizeOptionalDate(vehicle.auctionDate);
    const fipePrice = normalizeOptionalMoney(vehicle.fipe);
    const fipePriceRaw = normalizeOptionalText(vehicle.fipeRaw);
    const fipeCode = normalizeOptionalText(vehicle.fipeCode);
    const fipeReferenceMonth = normalizeOptionalText(vehicle.fipeReferenceMonth);
    const fipeModelYear =
      typeof vehicle.fipeModelYear === "number" && Number.isFinite(vehicle.fipeModelYear)
        ? Math.round(vehicle.fipeModelYear)
        : null;
    const fipeFuel = normalizeOptionalText(vehicle.fipeFuel);
    const fipeBrandMatched = normalizeOptionalText(vehicle.fipeBrandMatched);
    const fipeModelMatched = normalizeOptionalText(vehicle.fipeModelMatched);
    const fipeCheckedAt = normalizeOptionalDate(vehicle.fipeCheckedAt);
    const imageUrl = Array.isArray(vehicle.imageUrls)
      ? normalizeOptionalText(vehicle.imageUrls.find((item) => typeof item === "string") ?? null)
      : null;

    byUrl.set(url, {
      url,
      source,
      brand,
      model,
      year,
      damage,
      imageUrl,
      auctionDate,
      targetPhone,
      sentAt: now,
      sentPrice: price,
      sentPriceRaw: priceRaw,
      sentPriceLabel: priceLabel,
      lastKnownPrice: price,
      lastKnownPriceRaw: priceRaw,
      lastKnownPriceLabel: priceLabel,
      lastCheckedAt: now,
      sold: false,
      soldAt: null,
      soldPrice: null,
      soldPriceRaw: null,
      soldPriceLabel: null,
      soldNotifiedAt: null,
      soldNotifyError: null,
      fipePrice,
      fipePriceRaw,
      fipeCode,
      fipeReferenceMonth,
      fipeModelYear,
      fipeFuel,
      fipeBrandMatched,
      fipeModelMatched,
      fipeCheckedAt,
      fipeLookupError: null,
      updatedAt: now,
      createdAt: now
    });
  }

  if (byUrl.size === 0) {
    return;
  }

  await withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionSentVehicleDoc>(
      AUCTION_WHATSAPP_DISPATCHES_COLLECTION
    );

    const ops = Array.from(byUrl.values()).map((item) => ({
      updateOne: {
        filter: { url: item.url },
        update: {
          $set: {
            url: item.url,
            source: item.source,
            brand: item.brand,
            model: item.model,
            year: item.year,
            damage: item.damage,
            imageUrl: item.imageUrl,
            auctionDate: item.auctionDate,
            targetPhone: item.targetPhone,
            sentAt: item.sentAt,
            sentPrice: item.sentPrice,
            sentPriceRaw: item.sentPriceRaw,
            sentPriceLabel: item.sentPriceLabel,
            lastKnownPrice: item.lastKnownPrice,
            lastKnownPriceRaw: item.lastKnownPriceRaw,
            lastKnownPriceLabel: item.lastKnownPriceLabel,
            lastCheckedAt: item.lastCheckedAt,
            sold: false,
            soldAt: null,
            soldPrice: null,
            soldPriceRaw: null,
            soldPriceLabel: null,
            soldNotifiedAt: null,
            soldNotifyError: null,
            fipePrice: item.fipePrice,
            fipePriceRaw: item.fipePriceRaw,
            fipeCode: item.fipeCode,
            fipeReferenceMonth: item.fipeReferenceMonth,
            fipeModelYear: item.fipeModelYear,
            fipeFuel: item.fipeFuel,
            fipeBrandMatched: item.fipeBrandMatched,
            fipeModelMatched: item.fipeModelMatched,
            fipeCheckedAt: item.fipeCheckedAt,
            fipeLookupError: null,
            updatedAt: now
          },
          $setOnInsert: {
            createdAt: now
          }
        },
        upsert: true
      }
    }));

    await col.bulkWrite(ops, { ordered: false });
  });
}

export async function listAuctionSentVehicles(
  config: MongoConfig,
  options?: { q?: string; sold?: boolean | null; limit?: number }
): Promise<AuctionSentVehicle[]> {
  if (!config.enabled) {
    return [];
  }

  const q = normalizeOptionalText(options?.q) ?? "";
  const sold = typeof options?.sold === "boolean" ? options.sold : null;
  const limit = Number.isFinite(options?.limit)
    ? Math.max(1, Math.min(500, Math.floor(options?.limit as number)))
    : 200;

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionSentVehicleDoc>(
      AUCTION_WHATSAPP_DISPATCHES_COLLECTION
    );

    const query: Record<string, unknown> = {};
    query.archivedAt = null;
    if (sold != null) {
      query.sold = sold;
    }
    if (q) {
      query.$or = [
        { url: { $regex: escapeRegex(q), $options: "i" } },
        { source: { $regex: escapeRegex(q), $options: "i" } },
        { brand: { $regex: escapeRegex(q), $options: "i" } },
        { model: { $regex: escapeRegex(q), $options: "i" } },
        { targetPhone: { $regex: escapeRegex(q), $options: "i" } }
      ];
    }

    const docs = await col
      .find(query)
      .sort({ sold: 1, sentAt: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();

    const items = docs.map(mapAuctionSentVehicleDoc);
    const overrideCol = models.SearchRun.db.collection<AuctionVehicleOverrideDoc>(
      AUCTION_VEHICLE_OVERRIDES_COLLECTION
    );
    const overrides = await overrideCol
      .find({ url: { $in: items.map((item) => item.url) } })
      .toArray();
    const overridesByUrl = new Map(
      overrides.map((doc) => [
        doc.url,
        {
          url: doc.url,
          manualFipe: doc.manualFipe ?? null,
          manualCostsTotal: doc.manualCostsTotal ?? null,
          notes: doc.notes ?? null,
          fipePriceRaw: doc.fipePriceRaw ?? null,
          fipeCode: doc.fipeCode ?? null,
          fipeReferenceMonth: doc.fipeReferenceMonth ?? null,
          fipeModelYear:
            typeof doc.fipeModelYear === "number" && Number.isFinite(doc.fipeModelYear)
              ? doc.fipeModelYear
              : null,
          fipeFuel: doc.fipeFuel ?? null,
          fipeBrandMatched: doc.fipeBrandMatched ?? null,
          fipeModelMatched: doc.fipeModelMatched ?? null,
          fipeCheckedAt: doc.fipeCheckedAt ?? null,
          updatedAt: doc.updatedAt,
          createdAt: doc.createdAt
        } satisfies AuctionVehicleOverride
      ])
    );

    return items.map((item) => mergeSentVehicleWithOverride(item, overridesByUrl.get(item.url)));
  });
}

export async function getAuctionSentVehicleByUrl(
  config: MongoConfig,
  urlInput: string
): Promise<AuctionSentVehicle | null> {
  const url = urlInput.trim();
  if (!config.enabled || !url) {
    return null;
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionSentVehicleDoc>(
      AUCTION_WHATSAPP_DISPATCHES_COLLECTION
    );
    const doc = await col.findOne({ url });
    return doc ? mapAuctionSentVehicleDoc(doc) : null;
  });
}

export async function archiveAuctionSentVehicle(
  config: MongoConfig,
  input: { url: string; reason?: string | null }
): Promise<AuctionSentVehicle | null> {
  const url = input.url.trim();
  if (!url) return null;

  const now = new Date();
  const archiveReason = normalizeOptionalText(input.reason);

  if (!config.enabled) {
    return null;
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionSentVehicleDoc>(
      AUCTION_WHATSAPP_DISPATCHES_COLLECTION
    );

    await col.updateOne(
      { url },
      {
        $set: {
          archivedAt: now,
          archiveReason,
          updatedAt: now
        }
      }
    );

    const doc = await col.findOne({ url });
    return doc ? mapAuctionSentVehicleDoc(doc) : null;
  });
}

export async function markAuctionSentVehicleSold(
  config: MongoConfig,
  input: {
    url: string;
    targetPhone?: string | null;
    source?: string | null;
    brand?: string | null;
    model?: string | null;
    year?: number | null;
    damage?: string | null;
    imageUrl?: string | null;
    latestPrice?: number | null;
    latestPriceRaw?: string | null;
    latestPriceLabel?: string | null;
    auctionDate?: string | Date | null;
    sold?: boolean;
    soldAt?: Date | null;
    notifiedAt?: Date | null;
    notifyError?: string | null;
  }
): Promise<AuctionSentVehicle | null> {
  const url = input.url.trim();
  if (!url) return null;

  const now = new Date();
  const targetPhone = normalizeOptionalText(input.targetPhone);
  const source = normalizeOptionalText(input.source);
  const brand = normalizeOptionalText(input.brand);
  const model = normalizeOptionalText(input.model);
  const year = typeof input.year === "number" && Number.isFinite(input.year) ? input.year : null;
  const damage = normalizeOptionalText(input.damage);
  const imageUrl = normalizeOptionalText(input.imageUrl);
  const latestPrice = normalizeOptionalMoney(input.latestPrice);
  const latestPriceRaw = normalizeOptionalText(input.latestPriceRaw);
  const latestPriceLabel = normalizeOptionalText(input.latestPriceLabel);
  const auctionDate = normalizeOptionalDate(input.auctionDate);
  const sold = input.sold !== false;
  const soldAt = sold ? input.soldAt ?? now : null;
  const notifiedAt = input.notifiedAt ?? null;
  const notifyError = normalizeOptionalText(input.notifyError);

  if (!config.enabled) {
    return {
      url,
      source: source ?? "",
      brand: brand ?? "",
      model: model ?? "",
      year,
      damage,
      imageUrl,
      auctionDate,
      targetPhone: targetPhone ?? "",
      sentAt: now,
      sentPrice: latestPrice,
      sentPriceRaw: latestPriceRaw,
      sentPriceLabel: latestPriceLabel,
      lastKnownPrice: latestPrice,
      lastKnownPriceRaw: latestPriceRaw,
      lastKnownPriceLabel: latestPriceLabel,
      lastCheckedAt: now,
      sold,
      soldAt,
      soldPrice: sold ? latestPrice : null,
      soldPriceRaw: sold ? latestPriceRaw : null,
      soldPriceLabel: sold ? latestPriceLabel : null,
      soldNotifiedAt: sold ? notifiedAt : null,
      soldNotifyError: sold ? notifyError : null,
      archivedAt: null,
      archiveReason: null,
      fipePrice: null,
      fipePriceRaw: null,
      fipeCode: null,
      fipeReferenceMonth: null,
      fipeModelYear: null,
      fipeFuel: null,
      fipeBrandMatched: null,
      fipeModelMatched: null,
      fipeCheckedAt: null,
      fipeLookupError: null,
      updatedAt: now,
      createdAt: now
    };
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionSentVehicleDoc>(
      AUCTION_WHATSAPP_DISPATCHES_COLLECTION
    );

    await col.updateOne(
      { url },
      {
        $set: {
          url,
          ...(targetPhone != null ? { targetPhone } : {}),
          ...(source != null ? { source } : {}),
          ...(brand != null ? { brand } : {}),
          ...(model != null ? { model } : {}),
          year,
          damage,
          imageUrl,
          ...(auctionDate != null ? { auctionDate } : {}),
          lastKnownPrice: latestPrice,
          lastKnownPriceRaw: latestPriceRaw,
          lastKnownPriceLabel: latestPriceLabel,
          lastCheckedAt: now,
          sold,
          soldAt,
          soldPrice: sold ? latestPrice : null,
          soldPriceRaw: sold ? latestPriceRaw : null,
          soldPriceLabel: sold ? latestPriceLabel : null,
          soldNotifiedAt: sold ? notifiedAt : null,
          soldNotifyError: sold ? notifyError : null,
          updatedAt: now
        }
      }
    );

    const doc = await col.findOne({ url });
    return doc ? mapAuctionSentVehicleDoc(doc) : null;
  });
}

export async function upsertAuctionSentVehicleFipe(
  config: MongoConfig,
  input: {
    url: string;
    fipePrice?: number | null;
    fipePriceRaw?: string | null;
    fipeCode?: string | null;
    fipeReferenceMonth?: string | null;
    fipeModelYear?: number | null;
    fipeFuel?: string | null;
    fipeBrandMatched?: string | null;
    fipeModelMatched?: string | null;
    fipeLookupError?: string | null;
  }
): Promise<AuctionSentVehicle | null> {
  const url = input.url.trim();
  if (!url) return null;

  const now = new Date();
  const fipePrice = normalizeOptionalMoney(input.fipePrice);
  const fipePriceRaw = normalizeOptionalText(input.fipePriceRaw);
  const fipeCode = normalizeOptionalText(input.fipeCode);
  const fipeReferenceMonth = normalizeOptionalText(input.fipeReferenceMonth);
  const fipeModelYear =
    typeof input.fipeModelYear === "number" && Number.isFinite(input.fipeModelYear)
      ? Math.round(input.fipeModelYear)
      : null;
  const fipeFuel = normalizeOptionalText(input.fipeFuel);
  const fipeBrandMatched = normalizeOptionalText(input.fipeBrandMatched);
  const fipeModelMatched = normalizeOptionalText(input.fipeModelMatched);
  const fipeLookupError = normalizeOptionalText(input.fipeLookupError);

  if (!config.enabled) {
    return {
      url,
      source: "",
      brand: "",
      model: "",
      year: null,
      damage: null,
      imageUrl: null,
      auctionDate: null,
      targetPhone: "",
      sentAt: now,
      sentPrice: null,
      sentPriceRaw: null,
      sentPriceLabel: null,
      lastKnownPrice: null,
      lastKnownPriceRaw: null,
      lastKnownPriceLabel: null,
      lastCheckedAt: now,
      sold: false,
      soldAt: null,
      soldPrice: null,
      soldPriceRaw: null,
      soldPriceLabel: null,
      soldNotifiedAt: null,
      soldNotifyError: null,
      archivedAt: null,
      archiveReason: null,
      fipePrice,
      fipePriceRaw,
      fipeCode,
      fipeReferenceMonth,
      fipeModelYear,
      fipeFuel,
      fipeBrandMatched,
      fipeModelMatched,
      fipeCheckedAt: now,
      fipeLookupError,
      updatedAt: now,
      createdAt: now
    };
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionSentVehicleDoc>(
      AUCTION_WHATSAPP_DISPATCHES_COLLECTION
    );

    await col.updateOne(
      { url },
      {
        $set: {
          url,
          fipePrice,
          fipePriceRaw,
          fipeCode,
          fipeReferenceMonth,
          fipeModelYear,
          fipeFuel,
          fipeBrandMatched,
          fipeModelMatched,
          fipeCheckedAt: now,
          fipeLookupError,
          updatedAt: now
        }
      }
    );

    const doc = await col.findOne({ url });
    return doc ? mapAuctionSentVehicleDoc(doc) : null;
  });
}

function normalizeCopartLiveEventType(value: unknown): CopartLiveEventType {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (
    normalized === "snapshot" ||
    normalized === "bid" ||
    normalized === "closed" ||
    normalized === "sale" ||
    normalized === "status"
  ) {
    return normalized;
  }
  return "snapshot";
}

function normalizeCopartLiveSaleStatus(value: unknown): CopartLiveSaleStatus {
  const normalized = normalizeOptionalText(value)?.toLowerCase();
  if (normalized === "open" || normalized === "sold" || normalized === "conditional") {
    return normalized;
  }
  return null;
}

function normalizeCopartLiveEventInput(
  input: Omit<CopartLiveAuctionEvent, "source" | "updatedAt" | "createdAt">
): Omit<CopartLiveAuctionEvent, "updatedAt" | "createdAt"> {
  const auctionId = normalizeOptionalText(input.auctionId);
  const lot = normalizeOptionalText(input.lot);
  const code = normalizeOptionalText(input.code);
  const description = normalizeOptionalText(input.description);
  const version = normalizeOptionalText(input.version);
  const yearModel = normalizeOptionalText(input.yearModel);
  const fipe = normalizeOptionalMoney(input.fipe);
  const fipeRaw = normalizeOptionalText(input.fipeRaw);
  const damage = normalizeOptionalText(input.damage);
  const yard = normalizeOptionalText(input.yard);
  const bid = normalizeOptionalMoney(input.bid);
  const bidRaw = normalizeOptionalText(input.bidRaw);
  const saleStatus = normalizeCopartLiveSaleStatus(input.saleStatus);
  const eventType = normalizeCopartLiveEventType(input.eventType);
  const fipePercent = typeof input.fipePercent === "number" && Number.isFinite(input.fipePercent)
    ? Math.round(input.fipePercent)
    : bid != null && fipe != null && fipe > 0
      ? Math.round((bid / fipe) * 100)
      : null;
  const imageUrl = normalizeOptionalText(input.imageUrl);
  const vehicleUrl = normalizeOptionalText(input.vehicleUrl);
  const message = normalizeOptionalText(input.message);
  const observedAt = normalizeOptionalDate(input.observedAt) ?? new Date();
  const providedKey = normalizeOptionalText(input.eventKey);
  const eventKey = providedKey ?? [
    "copart-live",
    auctionId ?? "",
    lot ?? "",
    eventType,
    saleStatus ?? "",
    bid != null ? String(bid) : "",
    normalizeOptionalText(message)?.toLowerCase() ?? ""
  ].join("|");

  return {
    eventKey,
    source: "copart-live",
    auctionId,
    lot,
    code,
    description,
    version,
    yearModel,
    fipe,
    fipeRaw,
    damage,
    yard,
    bid,
    bidRaw,
    saleStatus,
    eventType,
    fipePercent,
    imageUrl,
    vehicleUrl,
    message,
    observedAt
  };
}

function mapCopartLiveAuctionEventDoc(doc: CopartLiveAuctionEventDoc): CopartLiveAuctionEvent {
  return {
    eventKey: doc.eventKey,
    source: "copart-live",
    auctionId: doc.auctionId ?? null,
    lot: doc.lot ?? null,
    code: doc.code ?? null,
    description: doc.description ?? null,
    version: doc.version ?? null,
    yearModel: doc.yearModel ?? null,
    fipe: typeof doc.fipe === "number" && Number.isFinite(doc.fipe) ? doc.fipe : null,
    fipeRaw: doc.fipeRaw ?? null,
    damage: doc.damage ?? null,
    yard: doc.yard ?? null,
    bid: typeof doc.bid === "number" && Number.isFinite(doc.bid) ? doc.bid : null,
    bidRaw: doc.bidRaw ?? null,
    saleStatus: normalizeCopartLiveSaleStatus(doc.saleStatus),
    eventType: normalizeCopartLiveEventType(doc.eventType),
    fipePercent:
      typeof doc.fipePercent === "number" && Number.isFinite(doc.fipePercent)
        ? doc.fipePercent
        : null,
    imageUrl: doc.imageUrl ?? null,
    vehicleUrl: doc.vehicleUrl ?? null,
    message: doc.message ?? null,
    observedAt: doc.observedAt,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt
  };
}

export async function upsertCopartLiveAuctionEvents(
  config: MongoConfig,
  events: Array<Omit<CopartLiveAuctionEvent, "source" | "updatedAt" | "createdAt">>
): Promise<CopartLiveAuctionEvent[]> {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }

  const now = new Date();
  const byKey = new Map<string, Omit<CopartLiveAuctionEvent, "updatedAt" | "createdAt">>();
  for (const event of events) {
    const normalized = normalizeCopartLiveEventInput(event);
    if (!normalized.eventKey) continue;
    byKey.set(normalized.eventKey, normalized);
  }

  if (byKey.size === 0) {
    return [];
  }

  if (!config.enabled) {
    return Array.from(byKey.values()).map((event) => ({
      ...event,
      updatedAt: now,
      createdAt: now
    }));
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<CopartLiveAuctionEventDoc>(
      COPART_LIVE_AUCTION_EVENTS_COLLECTION
    );
    await Promise.all([
      col.createIndex({ eventKey: 1 }, { unique: true }),
      col.createIndex({ observedAt: -1 }),
      col.createIndex({ auctionId: 1, lot: 1, observedAt: -1 })
    ]);

    const values = Array.from(byKey.values());
    await col.bulkWrite(
      values.map((event) => ({
        updateOne: {
          filter: { eventKey: event.eventKey },
          update: {
            $set: {
              ...event,
              updatedAt: now
            },
            $setOnInsert: {
              createdAt: now
            }
          },
          upsert: true
        }
      })),
      { ordered: false }
    );

    const docs = await col.find({ eventKey: { $in: values.map((event) => event.eventKey) } }).toArray();
    return docs.map(mapCopartLiveAuctionEventDoc);
  });
}

export async function listCopartLiveAuctionEvents(
  config: MongoConfig,
  options?: { q?: string; limit?: number }
): Promise<CopartLiveAuctionEvent[]> {
  if (!config.enabled) {
    return [];
  }

  const q = normalizeOptionalText(options?.q) ?? "";
  const limit = Number.isFinite(options?.limit)
    ? Math.max(1, Math.min(500, Math.floor(options?.limit as number)))
    : 200;

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<CopartLiveAuctionEventDoc>(
      COPART_LIVE_AUCTION_EVENTS_COLLECTION
    );
    await Promise.all([
      col.createIndex({ eventKey: 1 }, { unique: true }),
      col.createIndex({ observedAt: -1 }),
      col.createIndex({ auctionId: 1, lot: 1, observedAt: -1 })
    ]);

    const query: Record<string, unknown> = {};
    if (q) {
      query.$or = [
        { auctionId: { $regex: escapeRegex(q), $options: "i" } },
        { lot: { $regex: escapeRegex(q), $options: "i" } },
        { code: { $regex: escapeRegex(q), $options: "i" } },
        { description: { $regex: escapeRegex(q), $options: "i" } },
        { version: { $regex: escapeRegex(q), $options: "i" } },
        { yard: { $regex: escapeRegex(q), $options: "i" } },
        { message: { $regex: escapeRegex(q), $options: "i" } }
      ];
    }

    const docs = await col
      .find(query)
      .sort({ observedAt: -1, updatedAt: -1 })
      .limit(limit)
      .toArray();

    return docs.map(mapCopartLiveAuctionEventDoc);
  });
}

function normalizeOptionalMoney(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeOptionalDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function upsertAuctionVehicleOverride(
  config: MongoConfig,
  input: {
    url: string;
    manualFipe?: unknown;
    manualCostsTotal?: unknown;
    notes?: unknown;
    fipePriceRaw?: unknown;
    fipeCode?: unknown;
    fipeReferenceMonth?: unknown;
    fipeModelYear?: unknown;
    fipeFuel?: unknown;
    fipeBrandMatched?: unknown;
    fipeModelMatched?: unknown;
    fipeCheckedAt?: unknown;
  }
): Promise<AuctionVehicleOverride | null> {
  const url = input.url.trim();
  if (!url) return null;

  const now = new Date();
  const setFields: Partial<AuctionVehicleOverrideDoc> = {
    url,
    updatedAt: now
  };

  if ("manualFipe" in input) setFields.manualFipe = normalizeOptionalMoney(input.manualFipe);
  if ("manualCostsTotal" in input) setFields.manualCostsTotal = normalizeOptionalMoney(input.manualCostsTotal);
  if ("notes" in input) setFields.notes = normalizeOptionalText(input.notes);
  if ("fipePriceRaw" in input) setFields.fipePriceRaw = normalizeOptionalText(input.fipePriceRaw);
  if ("fipeCode" in input) setFields.fipeCode = normalizeOptionalText(input.fipeCode);
  if ("fipeReferenceMonth" in input) setFields.fipeReferenceMonth = normalizeOptionalText(input.fipeReferenceMonth);
  if ("fipeModelYear" in input) {
    const value = Number(input.fipeModelYear);
    setFields.fipeModelYear = Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  }
  if ("fipeFuel" in input) setFields.fipeFuel = normalizeOptionalText(input.fipeFuel);
  if ("fipeBrandMatched" in input) setFields.fipeBrandMatched = normalizeOptionalText(input.fipeBrandMatched);
  if ("fipeModelMatched" in input) setFields.fipeModelMatched = normalizeOptionalText(input.fipeModelMatched);
  if ("fipeCheckedAt" in input) setFields.fipeCheckedAt = normalizeOptionalDate(input.fipeCheckedAt);

  if (!config.enabled) {
    return {
      url,
      manualFipe: setFields.manualFipe ?? null,
      manualCostsTotal: setFields.manualCostsTotal ?? null,
      notes: setFields.notes ?? null,
      fipePriceRaw: setFields.fipePriceRaw ?? null,
      fipeCode: setFields.fipeCode ?? null,
      fipeReferenceMonth: setFields.fipeReferenceMonth ?? null,
      fipeModelYear: setFields.fipeModelYear ?? null,
      fipeFuel: setFields.fipeFuel ?? null,
      fipeBrandMatched: setFields.fipeBrandMatched ?? null,
      fipeModelMatched: setFields.fipeModelMatched ?? null,
      fipeCheckedAt: setFields.fipeCheckedAt ?? null,
      updatedAt: now,
      createdAt: now
    };
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionVehicleOverrideDoc>(
      AUCTION_VEHICLE_OVERRIDES_COLLECTION
    );
    await col.updateOne(
      { url },
      {
        $set: setFields,
        $setOnInsert: { createdAt: now }
      },
      { upsert: true }
    );

    const doc = await col.findOne({ url });
    if (!doc) return null;

    return {
      url: doc.url,
      manualFipe: doc.manualFipe ?? null,
      manualCostsTotal: doc.manualCostsTotal ?? null,
      notes: doc.notes ?? null,
      fipePriceRaw: doc.fipePriceRaw ?? null,
      fipeCode: doc.fipeCode ?? null,
      fipeReferenceMonth: doc.fipeReferenceMonth ?? null,
      fipeModelYear:
        typeof doc.fipeModelYear === "number" && Number.isFinite(doc.fipeModelYear)
          ? doc.fipeModelYear
          : null,
      fipeFuel: doc.fipeFuel ?? null,
      fipeBrandMatched: doc.fipeBrandMatched ?? null,
      fipeModelMatched: doc.fipeModelMatched ?? null,
      fipeCheckedAt: doc.fipeCheckedAt ?? null,
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt
    };
  });
}

export async function getAuctionVehicleOverridesByUrls(
  config: MongoConfig,
  urls: string[]
): Promise<Map<string, AuctionVehicleOverride>> {
  const normalized = Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
  if (!config.enabled || normalized.length === 0) {
    return new Map();
  }

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<AuctionVehicleOverrideDoc>(
      AUCTION_VEHICLE_OVERRIDES_COLLECTION
    );
    const docs = await col.find({ url: { $in: normalized } }).toArray();
    return new Map(
      docs.map((doc) => [
        doc.url,
        {
          url: doc.url,
          manualFipe: doc.manualFipe ?? null,
          manualCostsTotal: doc.manualCostsTotal ?? null,
          notes: doc.notes ?? null,
          fipePriceRaw: doc.fipePriceRaw ?? null,
          fipeCode: doc.fipeCode ?? null,
          fipeReferenceMonth: doc.fipeReferenceMonth ?? null,
          fipeModelYear:
            typeof doc.fipeModelYear === "number" && Number.isFinite(doc.fipeModelYear)
              ? doc.fipeModelYear
              : null,
          fipeFuel: doc.fipeFuel ?? null,
          fipeBrandMatched: doc.fipeBrandMatched ?? null,
          fipeModelMatched: doc.fipeModelMatched ?? null,
          fipeCheckedAt: doc.fipeCheckedAt ?? null,
          updatedAt: doc.updatedAt,
          createdAt: doc.createdAt
        }
      ])
    );
  });
}

export async function hideAuctionVehicle(
  config: MongoConfig,
  input: {
    url: string;
    source?: string;
    brand?: string;
    model?: string;
    year?: number | null;
    damage?: string | null;
    reason?: string | null;
  }
): Promise<void> {
  await hideAuctionVehicles(config, [input]);
}

export async function hideAuctionVehicles(
  config: MongoConfig,
  inputs: Array<{
    url: string;
    source?: string;
    brand?: string;
    model?: string;
    year?: number | null;
    damage?: string | null;
    reason?: string | null;
  }>
): Promise<void> {
  if (!config.enabled || inputs.length === 0) return;

  const byUrl = new Map<
    string,
    {
      url: string;
      source: string;
      brand: string;
      model: string;
      year: number | null;
      damage: string | null;
      reason: string | null;
    }
  >();

  for (const input of inputs) {
    const url = input.url.trim();
    if (!url) continue;
    byUrl.set(url, {
      url,
      source: normalizeOptionalText(input.source) ?? "",
      brand: normalizeOptionalText(input.brand) ?? "",
      model: normalizeOptionalText(input.model) ?? "",
      year: typeof input.year === "number" && Number.isFinite(input.year) ? input.year : null,
      damage: normalizeOptionalText(input.damage),
      reason: normalizeOptionalText(input.reason)
    });
  }

  if (byUrl.size === 0) return;
  const now = new Date();

  await withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<HiddenAuctionVehicleDoc>(
      HIDDEN_AUCTION_VEHICLES_COLLECTION
    );
    const ops = Array.from(byUrl.values()).map((item) => ({
      updateOne: {
        filter: { url: item.url },
        update: {
          $set: {
            url: item.url,
            source: item.source,
            brand: item.brand,
            model: item.model,
            year: item.year,
            damage: item.damage,
            reason: item.reason,
            hiddenAt: now,
            updatedAt: now
          },
          $setOnInsert: { createdAt: now }
        },
        upsert: true
      }
    }));

    await col.bulkWrite(ops, { ordered: false });
  });
}

export async function getHiddenAuctionVehicleUrlSet(
  config: MongoConfig,
  urls?: string[]
): Promise<Set<string>> {
  if (!config.enabled) return new Set();

  const normalized = urls?.map((url) => url.trim()).filter(Boolean) ?? [];

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<HiddenAuctionVehicleDoc>(
      HIDDEN_AUCTION_VEHICLES_COLLECTION
    );
    const query = normalized.length > 0 ? { url: { $in: normalized } } : {};
    const docs = await col.find(query, { projection: { url: 1 } }).toArray();
    return new Set(docs.map((doc) => doc.url));
  });
}

export async function listHiddenAuctionVehicles(
  config: MongoConfig,
  options?: { q?: string; limit?: number; includeLargeDamage?: boolean }
): Promise<HiddenAuctionVehicle[]> {
  if (!config.enabled) return [];

  const rawQ = normalizeOptionalText(options?.q) ?? "";
  const includeLargeDamage = options?.includeLargeDamage !== false;
  const limit = Number.isFinite(options?.limit)
    ? Math.max(1, Math.min(500, Math.floor(options?.limit as number)))
    : 200;

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<HiddenAuctionVehicleDoc>(
      HIDDEN_AUCTION_VEHICLES_COLLECTION
    );

    const query = rawQ
      ? {
          $or: [
            { url: { $regex: escapeRegex(rawQ), $options: "i" } },
            { source: { $regex: escapeRegex(rawQ), $options: "i" } },
            { brand: { $regex: escapeRegex(rawQ), $options: "i" } },
            { model: { $regex: escapeRegex(rawQ), $options: "i" } },
            { damage: { $regex: escapeRegex(rawQ), $options: "i" } },
            { reason: { $regex: escapeRegex(rawQ), $options: "i" } }
          ]
        }
      : {};

    const docs = await col
      .find(query)
      .sort({ hiddenAt: -1, updatedAt: -1 })
      .limit(includeLargeDamage ? limit : Math.min(1_000, limit * 4))
      .toArray();

    const docsWithDamage = docs.map((doc) => ({
      ...doc,
      damage: doc.damage ?? null
    }));

    if (!includeLargeDamage) {
      const missingDamageUrls = Array.from(
        new Set(
          docsWithDamage
            .filter((doc) => !normalizeOptionalText(doc.damage))
            .map((doc) => doc.url)
            .filter(Boolean)
        )
      );

      if (missingDamageUrls.length > 0) {
        const resultsCol = models.SearchRun.db.collection<AuctionResultDoc>(
          AUCTION_RESULTS_COLLECTION
        );
        const knownDamageResults = await resultsCol
          .find(
            {
              url: { $in: missingDamageUrls },
              damage: { $ne: null }
            },
            { projection: { url: 1, damage: 1, scrapedAt: 1 } }
          )
          .sort({ scrapedAt: -1 })
          .toArray();

        const backfilledDamageByUrl = new Map<string, string>();
        for (const result of knownDamageResults) {
          const url = result.url?.trim();
          const damage = normalizeOptionalText(result.damage);
          if (!url || !damage || backfilledDamageByUrl.has(url)) continue;
          backfilledDamageByUrl.set(url, damage);
        }

        for (const doc of docsWithDamage) {
          if (normalizeOptionalText(doc.damage)) continue;
          const backfilled = backfilledDamageByUrl.get(doc.url);
          if (backfilled) {
            doc.damage = backfilled;
          }
        }
      }
    }

    const filteredDocs = includeLargeDamage
      ? docsWithDamage
      : docsWithDamage.filter((doc) => !isLargeDamageHiddenVehicle(doc));

    return filteredDocs.slice(0, limit).map((doc) => ({
      url: doc.url,
      source: doc.source ?? "",
      brand: doc.brand ?? "",
      model: doc.model ?? "",
      year: typeof doc.year === "number" && Number.isFinite(doc.year) ? doc.year : null,
      damage: doc.damage ?? null,
      reason: doc.reason ?? null,
      hiddenAt: doc.hiddenAt,
      updatedAt: doc.updatedAt,
      createdAt: doc.createdAt
    }));
  });
}

export async function unhideAuctionVehicle(
  config: MongoConfig,
  urlInput: string
): Promise<boolean> {
  const url = urlInput.trim();
  if (!url) return false;
  if (!config.enabled) return true;

  return withMongo(config, async (models) => {
    const col = models.SearchRun.db.collection<HiddenAuctionVehicleDoc>(
      HIDDEN_AUCTION_VEHICLES_COLLECTION
    );
    const result = await col.deleteOne({ url });
    return result.deletedCount > 0;
  });
}

export async function isAnyMarketplaceWorkerOnline(
  config: MongoConfig,
  maxSilenceSeconds = 45
): Promise<boolean> {
  if (!config.enabled) {
    return false;
  }

  const safeSeconds = Number.isFinite(maxSilenceSeconds) ? Math.max(5, Math.floor(maxSilenceSeconds)) : 45;
  const minLastSeenAt = new Date(Date.now() - safeSeconds * 1000);

  return withMongo(config, async (models) => {
    const collection = getMarketplaceWorkerHeartbeatsCollection(models.SearchRun.db);
    const online = await collection.findOne({
      lastSeenAt: { $gte: minLastSeenAt }
    });

    return Boolean(online);
  });
}
