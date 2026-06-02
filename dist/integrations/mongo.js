import mongoose, { Schema } from "mongoose";
import { sanitizeCityList, sanitizeStateList } from "../location-filter.js";
import { parsePriceToCents } from "../utils.js";
const listingSchema = new Schema({
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
}, { versionKey: false, collection: "listings" });
listingSchema.index({ lastSeenAt: -1 });
const searchRunSchema = new Schema({
    searchTerm: { type: String, required: true },
    collectedAt: { type: Date, required: true, index: true },
    outputPath: { type: String, required: true },
    total: { type: Number, required: true },
    semanticRuleName: { type: String, required: true },
    createdAt: { type: Date, required: true }
}, { versionKey: false, collection: "search_runs" });
const runResultSchema = new Schema({
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
}, { versionKey: false, collection: "run_results" });
const zApiDispatchSchema = new Schema({
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
}, { versionKey: false, collection: "zapi_dispatches" });
const MARKETPLACE_COMMANDS_COLLECTION = "marketplace_commands";
const MARKETPLACE_WORKER_HEARTBEATS_COLLECTION = "marketplace_worker_heartbeats";
function getMarketplaceCommandsCollection(connection) {
    return connection.collection(MARKETPLACE_COMMANDS_COLLECTION);
}
function getMarketplaceWorkerHeartbeatsCollection(connection) {
    return connection.collection(MARKETPLACE_WORKER_HEARTBEATS_COLLECTION);
}
function normalizeCommandArg(value) {
    if (typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function toDate(value) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
        return new Date();
    }
    return parsed;
}
function pickFirstEnv(env, keys) {
    for (const key of keys) {
        const value = (env[key] ?? "").trim();
        if (value) {
            return value;
        }
    }
    return "";
}
function buildMongoConfigFromEnv(env, options) {
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
export function getMongoConfigFromEnv(env = process.env) {
    return buildMongoConfigFromEnv(env);
}
export function getMongoQueueConfigFromEnv(env = process.env) {
    return buildMongoConfigFromEnv(env, {
        uriKeys: ["MONGO_QUEUE_URI", "MONGO_URI"],
        dbNameKeys: ["MONGO_QUEUE_DB_NAME", "MONGO_DB_NAME"],
        defaultDbName: "marketplace"
    });
}
export function getMongoDataConfigFromEnv(env = process.env) {
    return buildMongoConfigFromEnv(env, {
        uriKeys: ["MONGO_DATA_URI", "MONGO_URI"],
        dbNameKeys: ["MONGO_DATA_DB_NAME", "MONGO_DB_NAME"],
        defaultDbName: "marketplace"
    });
}
function getOrCreateModel(connection, name, schema) {
    return connection.models[name] ?? connection.model(name, schema);
}
function getModels(connection) {
    return {
        Listing: getOrCreateModel(connection, "Listing", listingSchema),
        SearchRun: getOrCreateModel(connection, "SearchRun", searchRunSchema),
        RunResult: getOrCreateModel(connection, "RunResult", runResultSchema),
        ZApiDispatch: getOrCreateModel(connection, "ZApiDispatch", zApiDispatchSchema)
    };
}
async function ensureSchema(models) {
    await Promise.all([
        models.Listing.createIndexes(),
        models.SearchRun.createIndexes(),
        models.RunResult.createIndexes(),
        models.ZApiDispatch.createIndexes()
    ]);
}
async function withMongo(config, fn) {
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
    }
    finally {
        await connection.close();
    }
}
export async function buildNotificationPlanFromMongo(config, input) {
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
        const previous = await models.ZApiDispatch.aggregate([
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
        const toSend = [];
        const skipped = [];
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
            const previousPriceCents = typeof prev.latestPriceCents === "number" ? prev.latestPriceCents : null;
            if (currentPriceCents != null &&
                previousPriceCents != null &&
                currentPriceCents < previousPriceCents) {
                const priceDropCents = previousPriceCents - currentPriceCents;
                const priceDropPercent = previousPriceCents > 0 ? (priceDropCents / previousPriceCents) * 100 : null;
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
                reason: currentPriceCents == null || previousPriceCents == null
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
export async function loadLatestSentStateByDestination(config, destination) {
    if (!config.enabled) {
        return new Map();
    }
    return withMongo(config, async (models) => {
        const docs = await models.ZApiDispatch.aggregate([
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
        return new Map(docs.map((doc) => [
            doc._id,
            {
                latestPriceRaw: doc.latestPriceRaw ?? null,
                latestPriceCents: typeof doc.latestPriceCents === "number" ? doc.latestPriceCents : null,
                lastSentAt: doc.lastSentAt ?? null
            }
        ]));
    });
}
export async function persistRunToMongo(config, input) {
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
        const listingWrite = listingOps.length > 0 ? await models.Listing.bulkWrite(listingOps, { ordered: false }) : null;
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
export async function persistZApiDispatchesToMongo(config, input) {
    if (!config.enabled || input.logs.length === 0) {
        return;
    }
    await withMongo(config, async (models) => {
        const now = new Date();
        const runId = input.runId && mongoose.isValidObjectId(input.runId)
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
export async function claimNextMarketplaceSearchCommand(config) {
    if (!config.enabled) {
        return null;
    }
    return withMongo(config, async (models) => {
        const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
        const now = new Date();
        const result = await commands.findOneAndUpdate({
            status: "PENDING",
            commandType: "SEARCH",
            cancelRequested: { $ne: true }
        }, {
            $set: {
                status: "RUNNING",
                startedAt: now,
                updatedAt: now
            }
        }, {
            sort: { createdAt: 1 },
            returnDocument: "after"
        });
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
export async function isMarketplaceCommandCancelRequested(config, commandId) {
    if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
        return false;
    }
    return withMongo(config, async (models) => {
        const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
        const command = await commands.findOne({ _id: new mongoose.Types.ObjectId(commandId) }, { projection: { status: 1, cancelRequested: 1 } });
        if (!command) {
            return false;
        }
        return (command.cancelRequested === true ||
            command.status === "CANCEL_REQUESTED" ||
            command.status === "CANCELLED");
    });
}
export async function markMarketplaceCommandDone(config, commandId, metadata = {}) {
    if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
        return;
    }
    await withMongo(config, async (models) => {
        const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
        const now = new Date();
        await commands.updateOne({ _id: new mongoose.Types.ObjectId(commandId) }, {
            $set: {
                status: "DONE",
                metadata,
                updatedAt: now,
                finishedAt: now
            }
        });
    });
}
export async function markMarketplaceCommandCancelled(config, commandId, metadata = {}) {
    if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
        return;
    }
    await withMongo(config, async (models) => {
        const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
        const now = new Date();
        await commands.updateOne({ _id: new mongoose.Types.ObjectId(commandId) }, {
            $set: {
                status: "CANCELLED",
                cancelRequested: true,
                metadata,
                updatedAt: now,
                finishedAt: now
            }
        });
    });
}
export async function markMarketplaceCommandFailed(config, commandId, errorMessage, metadata = {}) {
    if (!config.enabled || !mongoose.isValidObjectId(commandId)) {
        return;
    }
    await withMongo(config, async (models) => {
        const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
        const now = new Date();
        await commands.updateOne({ _id: new mongoose.Types.ObjectId(commandId) }, {
            $set: {
                status: "FAILED",
                metadata: {
                    ...metadata,
                    errorMessage
                },
                updatedAt: now,
                finishedAt: now
            }
        });
    });
}
export async function touchMarketplaceWorkerHeartbeat(config, input) {
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
        await collection.updateOne({ workerId }, {
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
        }, { upsert: true });
    });
}
export async function claimNextAnyPendingCommand(config) {
    if (!config.enabled) {
        return null;
    }
    return withMongo(config, async (models) => {
        const commands = getMarketplaceCommandsCollection(models.SearchRun.db);
        const now = new Date();
        const result = await commands.findOneAndUpdate({
            status: "PENDING",
            cancelRequested: { $ne: true }
        }, {
            $set: {
                status: "RUNNING",
                startedAt: now,
                updatedAt: now
            }
        }, {
            sort: { createdAt: 1 },
            returnDocument: "after"
        });
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
const DEFAULT_AUCTION_FILTERS = {
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
const AUCTION_VEHICLE_OVERRIDES_COLLECTION = "auction_vehicle_overrides";
const HIDDEN_AUCTION_VEHICLES_COLLECTION = "hidden_auction_vehicles";
function normalizeDamageText(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}
function isLargeDamageLabel(value) {
    const normalized = normalizeDamageText(value ?? "");
    if (!normalized)
        return false;
    return (normalized.includes("grande") ||
        normalized.includes("sucata") ||
        normalized.includes("perda total"));
}
function isLargeDamageHiddenVehicle(doc) {
    if (isLargeDamageLabel(doc.damage ?? null))
        return true;
    if (isLargeDamageLabel(doc.reason ?? null))
        return true;
    const normalizedUrl = normalizeDamageText(doc.url ?? "");
    if (!normalizedUrl)
        return false;
    return (normalizedUrl.includes("grande-monta") ||
        normalizedUrl.includes("grande monta") ||
        normalizedUrl.includes("sucata") ||
        normalizedUrl.includes("perda-total") ||
        normalizedUrl.includes("perda total"));
}
export async function getAuctionFilters(config) {
    if (!config.enabled) {
        return { ...DEFAULT_AUCTION_FILTERS, updatedAt: new Date() };
    }
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_FILTERS_COLLECTION);
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
function sanitizeStringList(input, options) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
        if (typeof raw !== "string")
            continue;
        let value = raw.trim();
        if (!value)
            continue;
        if (options?.uppercase)
            value = value.toUpperCase();
        if (options?.lowercase)
            value = value.toLowerCase();
        const key = value.toLowerCase();
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push(value);
    }
    return out;
}
function sanitizeNumberInRange(value, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n))
        return undefined;
    const rounded = Math.round(n);
    if (rounded < min || rounded > max)
        return undefined;
    return rounded;
}
function sanitizeComboRules(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    for (let i = 0; i < input.length && out.length < 80; i += 1) {
        const raw = input[i];
        if (!raw || typeof raw !== "object")
            continue;
        const obj = raw;
        const brandRaw = typeof obj.brand === "string" ? obj.brand.trim() : "";
        const modelRaw = typeof obj.model === "string" ? obj.model.trim() : "";
        const textRaw = typeof obj.text === "string" ? obj.text.trim() : "";
        const minYear = sanitizeNumberInRange(obj.minYear, 1900, 2035) ?? null;
        const modeRaw = typeof obj.mode === "string" ? obj.mode.trim().toLowerCase() : "";
        const mode = modeRaw === "exclude" ? "exclude" : "include";
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
function sanitizeAuctionFiltersUpdate(update) {
    const sanitized = {};
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
function normalizeLegacyToken(raw) {
    return raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function buildLegacyComboRulesFromDoc(doc) {
    const brands = sanitizeStringList(doc.brands, { uppercase: true });
    const models = sanitizeStringList(doc.models);
    const minYear = sanitizeNumberInRange(doc.minYear, 1900, 2035) ?? null;
    if (brands.length === 0 && models.length === 0) {
        return [];
    }
    const byLength = [...brands].sort((a, b) => b.length - a.length);
    const seen = new Set();
    const out = [];
    const pushRule = (brand, model, text, idx) => {
        const normalizedBrand = brand?.trim() || null;
        const normalizedModel = model?.trim() || null;
        const normalizedText = text?.trim() || null;
        const key = `${normalizeLegacyToken(normalizedBrand ?? "")}|${normalizeLegacyToken(normalizedModel ?? "")}|${normalizeLegacyToken(normalizedText ?? "")}|${minYear ?? ""}`;
        if (seen.has(key))
            return;
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
            const matchedBrand = byLength.find((brand) => {
                const b = normalizeLegacyToken(brand);
                if (!b)
                    return false;
                return normalizedModel === b || normalizedModel.startsWith(`${b} `) || normalizedModel.includes(` ${b} `);
            }) ?? null;
            pushRule(matchedBrand, model, null, idx);
        });
    }
    else {
        byLength.forEach((brand, idx) => {
            pushRule(brand, null, null, idx);
        });
    }
    return sanitizeComboRules(out);
}
function buildLegacyPresetComboRules() {
    const now = new Date();
    const presetDoc = {
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
export async function upsertAuctionFilters(config, update) {
    const now = new Date();
    const sanitizedUpdate = sanitizeAuctionFiltersUpdate(update);
    if (!config.enabled) {
        return { ...DEFAULT_AUCTION_FILTERS, ...sanitizedUpdate, updatedAt: now };
    }
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_FILTERS_COLLECTION);
        const setOnInsertDefaults = {
            _id: "default",
            locations: DEFAULT_AUCTION_FILTERS.locations,
            states: DEFAULT_AUCTION_FILTERS.states,
            cities: DEFAULT_AUCTION_FILTERS.cities,
            comboRules: DEFAULT_AUCTION_FILTERS.comboRules
        };
        for (const key of Object.keys(sanitizedUpdate)) {
            delete setOnInsertDefaults[key];
        }
        await col.updateOne({ _id: "default" }, {
            $set: { ...sanitizedUpdate, updatedAt: now },
            $setOnInsert: setOnInsertDefaults
        }, { upsert: true });
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
export async function migrateLegacyAuctionFiltersToCombos(config, options) {
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
        const col = models.SearchRun.db.collection(AUCTION_FILTERS_COLLECTION);
        const doc = await col.findOne({ _id: "default" });
        if (!doc) {
            const filters = { ...DEFAULT_AUCTION_FILTERS, updatedAt: new Date() };
            return {
                migrated: false,
                added: 0,
                reason: "not_found",
                filters
            };
        }
        const currentCombos = sanitizeComboRules(doc.comboRules ?? []);
        if (currentCombos.length > 0 && !options?.force) {
            return {
                migrated: false,
                added: 0,
                reason: "already_has_combos",
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
                reason: "legacy_empty",
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
        await col.updateOne({ _id: "default" }, {
            $set: {
                comboRules: finalRules,
                updatedAt: now
            }
        });
        return {
            migrated: true,
            added: finalRules.length,
            reason: usedPreset ? "preset_seeded" : "migrated",
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
export async function seedAuctionFilters(config) {
    if (!config.enabled) {
        return;
    }
    await withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_FILTERS_COLLECTION);
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
];
export async function addContact(config, contact) {
    if (!config.enabled) {
        return;
    }
    await withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(CONTACTS_COLLECTION);
        await col.insertOne({
            ...contact,
            createdAt: new Date()
        });
    });
}
export async function searchContacts(config, category) {
    if (!config.enabled) {
        return [];
    }
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(CONTACTS_COLLECTION);
        const filter = category ? { category: category.toLowerCase() } : {};
        return col.find(filter).sort({ addedAt: -1 }).toArray();
    });
}
// ─── Auction results ──────────────────────────────────────────────────────────
export async function saveAuctionResults(config, results) {
    if (!config.enabled || results.length === 0) {
        return;
    }
    await withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_RESULTS_COLLECTION);
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
export async function getUnsentAuctionResults(config) {
    if (!config.enabled) {
        return [];
    }
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_RESULTS_COLLECTION);
        return col
            .find({ sentToGroup: false })
            .sort({ price: 1 })
            .toArray();
    });
}
export async function markAuctionResultsSent(config, urls) {
    if (!config.enabled || urls.length === 0) {
        return;
    }
    await withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_RESULTS_COLLECTION);
        await col.updateMany({ url: { $in: urls } }, { $set: { sentToGroup: true } });
    });
}
function normalizeOptionalMoney(value) {
    if (value == null || value === "")
        return null;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return null;
    return Math.round(n);
}
function normalizeOptionalText(value) {
    if (typeof value !== "string")
        return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}
function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
export async function upsertAuctionVehicleOverride(config, input) {
    const url = input.url.trim();
    if (!url)
        return null;
    const manualFipe = normalizeOptionalMoney(input.manualFipe);
    const manualCostsTotal = normalizeOptionalMoney(input.manualCostsTotal);
    const notes = normalizeOptionalText(input.notes);
    const now = new Date();
    if (!config.enabled) {
        return {
            url,
            manualFipe,
            manualCostsTotal,
            notes,
            updatedAt: now,
            createdAt: now
        };
    }
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_VEHICLE_OVERRIDES_COLLECTION);
        await col.updateOne({ url }, {
            $set: {
                url,
                manualFipe,
                manualCostsTotal,
                notes,
                updatedAt: now
            },
            $setOnInsert: { createdAt: now }
        }, { upsert: true });
        const doc = await col.findOne({ url });
        if (!doc)
            return null;
        return {
            url: doc.url,
            manualFipe: doc.manualFipe ?? null,
            manualCostsTotal: doc.manualCostsTotal ?? null,
            notes: doc.notes ?? null,
            updatedAt: doc.updatedAt,
            createdAt: doc.createdAt
        };
    });
}
export async function getAuctionVehicleOverridesByUrls(config, urls) {
    const normalized = Array.from(new Set(urls.map((url) => url.trim()).filter(Boolean)));
    if (!config.enabled || normalized.length === 0) {
        return new Map();
    }
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(AUCTION_VEHICLE_OVERRIDES_COLLECTION);
        const docs = await col.find({ url: { $in: normalized } }).toArray();
        return new Map(docs.map((doc) => [
            doc.url,
            {
                url: doc.url,
                manualFipe: doc.manualFipe ?? null,
                manualCostsTotal: doc.manualCostsTotal ?? null,
                notes: doc.notes ?? null,
                updatedAt: doc.updatedAt,
                createdAt: doc.createdAt
            }
        ]));
    });
}
export async function hideAuctionVehicle(config, input) {
    await hideAuctionVehicles(config, [input]);
}
export async function hideAuctionVehicles(config, inputs) {
    if (!config.enabled || inputs.length === 0)
        return;
    const byUrl = new Map();
    for (const input of inputs) {
        const url = input.url.trim();
        if (!url)
            continue;
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
    if (byUrl.size === 0)
        return;
    const now = new Date();
    await withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(HIDDEN_AUCTION_VEHICLES_COLLECTION);
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
export async function getHiddenAuctionVehicleUrlSet(config, urls) {
    if (!config.enabled)
        return new Set();
    const normalized = urls?.map((url) => url.trim()).filter(Boolean) ?? [];
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(HIDDEN_AUCTION_VEHICLES_COLLECTION);
        const query = normalized.length > 0 ? { url: { $in: normalized } } : {};
        const docs = await col.find(query, { projection: { url: 1 } }).toArray();
        return new Set(docs.map((doc) => doc.url));
    });
}
export async function listHiddenAuctionVehicles(config, options) {
    if (!config.enabled)
        return [];
    const rawQ = normalizeOptionalText(options?.q) ?? "";
    const includeLargeDamage = options?.includeLargeDamage !== false;
    const limit = Number.isFinite(options?.limit)
        ? Math.max(1, Math.min(500, Math.floor(options?.limit)))
        : 200;
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(HIDDEN_AUCTION_VEHICLES_COLLECTION);
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
            const missingDamageUrls = Array.from(new Set(docsWithDamage
                .filter((doc) => !normalizeOptionalText(doc.damage))
                .map((doc) => doc.url)
                .filter(Boolean)));
            if (missingDamageUrls.length > 0) {
                const resultsCol = models.SearchRun.db.collection(AUCTION_RESULTS_COLLECTION);
                const knownDamageResults = await resultsCol
                    .find({
                    url: { $in: missingDamageUrls },
                    damage: { $ne: null }
                }, { projection: { url: 1, damage: 1, scrapedAt: 1 } })
                    .sort({ scrapedAt: -1 })
                    .toArray();
                const backfilledDamageByUrl = new Map();
                for (const result of knownDamageResults) {
                    const url = result.url?.trim();
                    const damage = normalizeOptionalText(result.damage);
                    if (!url || !damage || backfilledDamageByUrl.has(url))
                        continue;
                    backfilledDamageByUrl.set(url, damage);
                }
                for (const doc of docsWithDamage) {
                    if (normalizeOptionalText(doc.damage))
                        continue;
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
export async function unhideAuctionVehicle(config, urlInput) {
    const url = urlInput.trim();
    if (!url)
        return false;
    if (!config.enabled)
        return true;
    return withMongo(config, async (models) => {
        const col = models.SearchRun.db.collection(HIDDEN_AUCTION_VEHICLES_COLLECTION);
        const result = await col.deleteOne({ url });
        return result.deletedCount > 0;
    });
}
export async function isAnyMarketplaceWorkerOnline(config, maxSilenceSeconds = 45) {
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
