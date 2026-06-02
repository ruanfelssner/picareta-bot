import dotenv from "dotenv";
import express from "express";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatAuctionCardCaption } from "../formatters/auction-card.js";
import { getAuctionFilters, upsertAuctionFilters, migrateLegacyAuctionFiltersToCombos, getMongoDataConfigFromEnv, getAuctionVehicleOverridesByUrls, upsertAuctionVehicleOverride, hideAuctionVehicle, hideAuctionVehicles, getHiddenAuctionVehicleUrlSet, listHiddenAuctionVehicles, unhideAuctionVehicle } from "../integrations/mongo.js";
import { filterAuctionVehiclesByGeo } from "../location-filter.js";
import { getZApiConfigFromEnv, sendTextMessageToZApi } from "../integrations/zapi.js";
import { executeSearchRun } from "../search-runner.js";
import { scrapeCopart } from "../scrapers/copart.js";
import { scrapeFavareto } from "../scrapers/favareto.js";
import { scrapeLeiloesJudiciais } from "../scrapers/leiloesjudiciais.js";
import { scrapeMegaleiloes } from "../scrapers/megaleiloes.js";
import { lookupFipe, formatFipeResult } from "../scrapers/placafipe.js";
import { scrapeSodre } from "../scrapers/sodre.js";
import { scrapeSuperbid } from "../scrapers/superbid.js";
import { scrapeVsVeiculos } from "../scrapers/vs-veiculos.js";
import { scrapeClaudioKuss } from "../scrapers/claudio-kuss.js";
import { scrapeVipLeiloes } from "../scrapers/vipleiloes.js";
import { parseBoolean } from "../utils.js";
dotenv.config();
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.DEV_PORT ?? "4000", 10);
const dataMongoConfig = getMongoDataConfigFromEnv();
const headless = parseBoolean(process.env.HEADLESS, true);
const WHATS_DELAY_DEFAULT_MS = 5_000;
const WHATS_DELAY_MIN_MS = 1_000;
const WHATS_DELAY_MAX_MS = 15_000;
const WHATS_BATCH_LIMIT = 200;
const sessionHiddenAuctionUrls = new Set();
const MONGO_TRANSIENT_ERROR_RE = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|Mongo(Network|ServerSelection)|server selection|socket hang up|connection .* closed/i;
const MONGO_RETRY_DELAYS_MS = [400, 1_000];
let lastKnownAuctionFilters = null;
const SCRAPERS = {
    "vs-veiculos": scrapeVsVeiculos,
    sodre: scrapeSodre,
    copart: scrapeCopart,
    favareto: scrapeFavareto,
    "claudio-kuss": scrapeClaudioKuss,
    megaleiloes: scrapeMegaleiloes,
    superbid: scrapeSuperbid,
    leiloesjudiciais: scrapeLeiloesJudiciais,
    vipleiloes: scrapeVipLeiloes
};
const SOURCE_LABELS = {
    "vs-veiculos": "VS Veículos",
    sodre: "Sodré Santoro",
    copart: "Copart",
    favareto: "Favareto",
    "claudio-kuss": "Claudio Kuss",
    megaleiloes: "Mega Leilões",
    superbid: "Superbid",
    leiloesjudiciais: "Leilões Judiciais",
    vipleiloes: "VIP Leilões"
};
const app = express();
app.use(express.json());
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function isTransientMongoError(error) {
    const message = getErrorMessage(error);
    return MONGO_TRANSIENT_ERROR_RE.test(message);
}
async function retryTransientMongo(label, run, log) {
    for (let attempt = 0; attempt <= MONGO_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await run();
        }
        catch (error) {
            if (!isTransientMongoError(error) || attempt >= MONGO_RETRY_DELAYS_MS.length) {
                throw error;
            }
            const waitMs = MONGO_RETRY_DELAYS_MS[attempt] ?? 1_000;
            const msg = `[mongo] ${label}: falha transitória (${getErrorMessage(error)}). Novo retry em ${Math.round(waitMs / 100) / 10}s.`;
            if (log)
                log(msg);
            else
                console.warn(msg);
            await sleep(waitMs);
        }
    }
    throw new Error(`[mongo] ${label}: retries esgotados.`);
}
function buildFallbackAuctionFilters() {
    return {
        locations: [],
        states: ["PR"],
        cities: [],
        comboRules: [],
        updatedAt: new Date()
    };
}
async function loadAuctionFiltersSafe(log) {
    try {
        const filters = await retryTransientMongo("getAuctionFilters", () => getAuctionFilters(dataMongoConfig), log);
        lastKnownAuctionFilters = filters;
        return { filters, warning: null };
    }
    catch (error) {
        if (!isTransientMongoError(error)) {
            throw error;
        }
        const message = getErrorMessage(error);
        if (lastKnownAuctionFilters) {
            const warning = `[mongo] filtros indisponíveis temporariamente (${message}). Usando cache em memória.`;
            if (log)
                log(warning);
            else
                console.warn(warning);
            return { filters: lastKnownAuctionFilters, warning };
        }
        const warning = `[mongo] filtros indisponíveis temporariamente (${message}). Usando filtros padrão.`;
        if (log)
            log(warning);
        else
            console.warn(warning);
        return { filters: buildFallbackAuctionFilters(), warning };
    }
}
function clampPositiveInt(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}
function parseAuctionDateInput(raw) {
    if (raw == null || raw === "")
        return null;
    if (typeof raw === "number" && Number.isFinite(raw)) {
        const d = new Date(raw);
        return isNaN(d.getTime()) ? null : d;
    }
    const value = String(raw).trim();
    if (!value)
        return null;
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
}
function parseOptionalPositiveMoney(raw) {
    if (raw == null || raw === "")
        return null;
    if (typeof raw === "number") {
        if (!Number.isFinite(raw) || raw <= 0)
            return null;
        return Math.round(raw);
    }
    if (typeof raw === "string") {
        const normalized = raw.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
        if (!normalized.trim())
            return null;
        const parsed = Number(normalized);
        if (!Number.isFinite(parsed) || parsed <= 0)
            return null;
        return Math.round(parsed);
    }
    return null;
}
function normalizeOptionalText(raw) {
    if (typeof raw !== "string")
        return null;
    const trimmed = raw.trim();
    return trimmed ? trimmed : null;
}
function applyAuctionVehicleOverride(vehicle, override) {
    if (!override)
        return vehicle;
    const merged = { ...vehicle };
    if (override.manualFipe != null) {
        merged.fipe = override.manualFipe;
        merged.fipeRaw = null;
    }
    if (override.manualCostsTotal != null) {
        merged.manualCostsTotal = override.manualCostsTotal;
    }
    if (override.notes) {
        merged.costNotes = override.notes;
    }
    return merged;
}
function normalizeSearchText(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function containsToken(haystack, token, options) {
    const needle = normalizeSearchText(token ?? "");
    if (!needle)
        return true;
    const normalizedHaystack = normalizeSearchText(haystack);
    const boundaryPattern = needle
        .split(" ")
        .filter(Boolean)
        .map(escapeRegExp)
        .join(" ");
    if (!boundaryPattern)
        return true;
    const boundaryRegex = new RegExp(`(?:^| )${boundaryPattern}(?= |$)`);
    if (boundaryRegex.test(normalizedHaystack)) {
        return true;
    }
    if (!options?.allowCompactFallback) {
        return false;
    }
    // Regra numérica (ex.: "320") deve casar com variação de sufixo alfabético ("320I").
    if (/^\d+$/.test(needle)) {
        const prefixedModelRegex = new RegExp(`(?:^| )${escapeRegExp(needle)}[A-Z][A-Z0-9]*(?= |$)`);
        if (prefixedModelRegex.test(normalizedHaystack)) {
            return true;
        }
    }
    // Fallback sem espaços para variações como "T CROSS" vs "TCROSS" e C180/A3.
    const compactNeedle = needle.replace(/\s+/g, "");
    if (!compactNeedle)
        return true;
    const hasLetter = /[A-Z]/.test(compactNeedle);
    const hasDigit = /\d/.test(compactNeedle);
    const hasWhitespace = needle.includes(" ");
    if (!hasLetter)
        return false;
    if (!hasDigit && !hasWhitespace)
        return false;
    const compactHaystack = normalizedHaystack.replace(/\s+/g, "");
    return compactHaystack.includes(compactNeedle);
}
function matchesComboRule(vehicle, rule) {
    if (!rule.enabled)
        return false;
    const hasRule = Boolean(rule.brand && rule.brand.trim()) ||
        Boolean(rule.model && rule.model.trim()) ||
        Boolean(rule.text && rule.text.trim()) ||
        rule.minYear != null;
    if (!hasRule)
        return false;
    const searchable = [vehicle.brand, vehicle.model, vehicle.description].filter(Boolean).join(" ");
    if (!containsToken(searchable, rule.brand, { allowCompactFallback: true })) {
        return false;
    }
    if (!containsToken(searchable, rule.model, { allowCompactFallback: true })) {
        return false;
    }
    if (!containsToken(searchable, rule.text, { allowCompactFallback: true })) {
        return false;
    }
    if (rule.minYear != null) {
        if (vehicle.year == null || vehicle.year < rule.minYear) {
            return false;
        }
    }
    return true;
}
function hasComboRuleFields(rule) {
    if (!rule)
        return false;
    return Boolean(String(rule.brand ?? "").trim() ||
        String(rule.model ?? "").trim() ||
        String(rule.text ?? "").trim() ||
        rule.minYear != null);
}
function applyComboRules(vehicles, rules, log) {
    const activeRules = (rules ?? []).filter((rule) => rule && rule.enabled && hasComboRuleFields(rule));
    if (activeRules.length === 0) {
        return vehicles;
    }
    const includeRules = activeRules.filter((rule) => (rule.mode ?? "include") !== "exclude");
    const excludeRules = activeRules.filter((rule) => (rule.mode ?? "include") === "exclude");
    let filtered = includeRules.length > 0
        ? vehicles.filter((vehicle) => includeRules.some((rule) => matchesComboRule(vehicle, rule)))
        : [...vehicles];
    if (excludeRules.length > 0) {
        filtered = filtered.filter((vehicle) => !excludeRules.some((rule) => matchesComboRule(vehicle, rule)));
    }
    if (log) {
        log(`[combo] ${filtered.length}/${vehicles.length} veículo(s) após ${activeRules.length} regra(s): ` +
            `${includeRules.length} inclusão + ${excludeRules.length} exclusão.`);
    }
    return filtered;
}
function applyLocationFilters(vehicles, filters, log) {
    const geo = filterAuctionVehiclesByGeo(vehicles, {
        states: filters.states,
        cities: filters.cities
    });
    if (log && (geo.activeStates.length > 0 || geo.activeCities.length > 0)) {
        log(`[geo] ${geo.vehicles.length}/${vehicles.length} veículo(s) após localização` +
            ` (estados=${geo.activeStates.join(", ") || "-"}; cidades=${geo.activeCities.join(", ") || "-"})`);
    }
    return geo.vehicles;
}
function normalizeVehicleInput(raw) {
    if (!raw || typeof raw !== "object")
        return null;
    const v = raw;
    const url = typeof v.url === "string" ? v.url.trim() : "";
    if (!url)
        return null;
    const imageUrls = Array.isArray(v.imageUrls)
        ? v.imageUrls.filter((x) => typeof x === "string" && x.trim().length > 0)
        : [];
    const source = typeof v.source === "string" ? v.source : "copart";
    const year = typeof v.year === "number" ? v.year : null;
    const price = typeof v.price === "number" ? v.price : null;
    const appraisal = typeof v.appraisal === "number" ? v.appraisal : null;
    const fipe = typeof v.fipe === "number" ? v.fipe : null;
    const manualCostsTotal = parseOptionalPositiveMoney(v.manualCostsTotal);
    const costNotes = normalizeOptionalText(v.costNotes);
    return {
        source: ([
            "vs-veiculos",
            "sodre",
            "copart",
            "favareto",
            "claudio-kuss",
            "mgl",
            "megaleiloes",
            "superbid",
            "leiloesjudiciais",
            "vipleiloes"
        ].includes(source)
            ? source
            : "copart"),
        brand: typeof v.brand === "string" ? v.brand : "",
        model: typeof v.model === "string" ? v.model : "",
        year: Number.isFinite(year) ? year : null,
        damage: typeof v.damage === "string" ? v.damage : null,
        price: Number.isFinite(price) ? price : null,
        priceRaw: typeof v.priceRaw === "string" ? v.priceRaw : null,
        priceLabel: typeof v.priceLabel === "string" ? v.priceLabel : null,
        imageUrls,
        description: typeof v.description === "string" ? v.description : "",
        url,
        auctionDate: parseAuctionDateInput(v.auctionDate),
        lot: typeof v.lot === "string" ? v.lot : undefined,
        km: typeof v.km === "string" ? v.km : null,
        color: typeof v.color === "string" ? v.color : null,
        yard: typeof v.yard === "string" ? v.yard : null,
        appraisal: Number.isFinite(appraisal) ? appraisal : null,
        appraisalRaw: typeof v.appraisalRaw === "string" ? v.appraisalRaw : null,
        fipe: Number.isFinite(fipe) ? fipe : null,
        fipeRaw: typeof v.fipeRaw === "string" ? v.fipeRaw : null,
        manualCostsTotal,
        costNotes
    };
}
function dedupeVehiclesByUrl(vehicles) {
    const seen = new Set();
    const deduped = [];
    for (const vehicle of vehicles) {
        if (seen.has(vehicle.url))
            continue;
        seen.add(vehicle.url);
        deduped.push(vehicle);
    }
    return deduped;
}
async function sendAuctionVehicleToWhats(vehicle, targetPhone, delayMs) {
    const zapi = getZApiConfigFromEnv();
    if (!zapi.enabled)
        return { ok: false, sentWithImage: false, reason: "Z-API desabilitada" };
    const caption = formatAuctionCardCaption(vehicle);
    const image = vehicle.imageUrls.find((url) => typeof url === "string" && url.trim().length > 0);
    if (image) {
        const endpoint = `${zapi.baseUrl}/instances/${encodeURIComponent(zapi.instanceId)}/token/${encodeURIComponent(zapi.token)}/send-image`;
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Client-Token": zapi.clientToken,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    phone: targetPhone,
                    image,
                    caption,
                    delayMessage: 1,
                    viewOnce: false
                })
            });
            const responseText = await response.text();
            const parsed = responseText.trim()
                ? (() => {
                    try {
                        return JSON.parse(responseText);
                    }
                    catch {
                        return responseText;
                    }
                })()
                : null;
            if (response.ok) {
                return { ok: true, sentWithImage: true, response: parsed };
            }
            return { ok: false, sentWithImage: false, reason: `HTTP ${response.status}`, response: parsed };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // fallback para texto puro se imagem falhar
            const textFallback = await sendTextMessageToZApi(zapi, { phone: targetPhone, message: caption });
            if (textFallback.ok) {
                return { ok: true, sentWithImage: false, reason: `imagem falhou: ${message}` };
            }
            return { ok: false, sentWithImage: false, reason: `imagem/texto falharam: ${textFallback.reason ?? message}` };
        }
        finally {
            await sleep(delayMs);
        }
    }
    const textResult = await sendTextMessageToZApi(zapi, { phone: targetPhone, message: caption });
    await sleep(delayMs);
    if (!textResult.ok) {
        return { ok: false, sentWithImage: false, reason: textResult.reason ?? "falha ao enviar texto", response: textResult.response };
    }
    return { ok: true, sentWithImage: false, response: textResult.response };
}
// ── HTML UI ──────────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
    res.sendFile(join(__dirname, "index.html"));
});
// ── Filtros ───────────────────────────────────────────────────────────────────
app.get("/api/filters", async (_req, res) => {
    try {
        const { filters, warning } = await loadAuctionFiltersSafe();
        const defaults = buildFallbackAuctionFilters();
        res.json({
            ...filters,
            defaults,
            degraded: Boolean(warning),
            warning
        });
    }
    catch (error) {
        const message = getErrorMessage(error);
        res.status(500).json({ error: message });
    }
});
app.patch("/api/filters", async (req, res) => {
    try {
        const updated = await upsertAuctionFilters(dataMongoConfig, req.body);
        const defaults = buildFallbackAuctionFilters();
        res.json({
            ...updated,
            defaults
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
    }
});
app.post("/api/filters/migrate-legacy", async (req, res) => {
    try {
        const force = Boolean(req.body?.force);
        const result = await migrateLegacyAuctionFiltersToCombos(dataMongoConfig, { force });
        res.json(result);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
    }
});
// ── Ajustes manuais de veículos de leilão ────────────────────────────────────
app.post("/api/auction/vehicle-override", async (req, res) => {
    try {
        const vehicle = normalizeVehicleInput(req.body?.vehicle);
        if (!vehicle) {
            res.status(400).json({ ok: false, error: "Veículo inválido." });
            return;
        }
        const manualFipe = parseOptionalPositiveMoney(req.body?.manualFipe);
        const manualCostsTotal = parseOptionalPositiveMoney(req.body?.manualCostsTotal);
        const notes = normalizeOptionalText(req.body?.notes);
        const savedOverride = await upsertAuctionVehicleOverride(dataMongoConfig, {
            url: vehicle.url,
            manualFipe,
            manualCostsTotal,
            notes
        });
        const mergedVehicle = applyAuctionVehicleOverride(vehicle, savedOverride ?? undefined);
        res.json({
            ok: true,
            vehicle: mergedVehicle,
            caption: formatAuctionCardCaption(mergedVehicle),
            override: savedOverride
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ ok: false, error: message });
    }
});
app.post("/api/auction/hide-vehicle", async (req, res) => {
    try {
        const vehicle = normalizeVehicleInput(req.body?.vehicle);
        if (!vehicle) {
            res.status(400).json({ ok: false, error: "Veículo inválido." });
            return;
        }
        const reason = normalizeOptionalText(req.body?.reason) ?? "manual_archive";
        sessionHiddenAuctionUrls.add(vehicle.url);
        await hideAuctionVehicle(dataMongoConfig, {
            url: vehicle.url,
            source: vehicle.source,
            brand: vehicle.brand,
            model: vehicle.model,
            year: vehicle.year ?? null,
            damage: vehicle.damage ?? null,
            reason
        });
        res.json({ ok: true, url: vehicle.url });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ ok: false, error: message });
    }
});
app.get("/api/auction/hidden", async (req, res) => {
    try {
        const q = typeof req.query.q === "string" ? req.query.q : "";
        const limit = clampPositiveInt(req.query.limit, 200, 1, 500);
        let hiddenWarning = null;
        let hiddenFromDb = [];
        try {
            hiddenFromDb = await retryTransientMongo("listHiddenAuctionVehicles", () => listHiddenAuctionVehicles(dataMongoConfig, { q, limit, includeLargeDamage: false }));
        }
        catch (error) {
            if (!isTransientMongoError(error))
                throw error;
            hiddenWarning =
                `Mongo indisponível temporariamente (${getErrorMessage(error)}). ` +
                    "Exibindo apenas arquivados da sessão atual.";
            console.warn(`[hidden] ${hiddenWarning}`);
        }
        const byUrl = new Map();
        for (const item of hiddenFromDb) {
            byUrl.set(item.url, item);
        }
        for (const url of sessionHiddenAuctionUrls) {
            if (!byUrl.has(url)) {
                byUrl.set(url, {
                    url,
                    source: "",
                    brand: "",
                    model: "",
                    year: null,
                    damage: null,
                    reason: "manual_archive",
                    hiddenAt: new Date(0),
                    updatedAt: new Date(0),
                    createdAt: new Date(0)
                });
            }
        }
        const items = Array.from(byUrl.values()).sort((a, b) => new Date(b.hiddenAt).getTime() - new Date(a.hiddenAt).getTime());
        res.json({
            ok: true,
            items,
            degraded: Boolean(hiddenWarning),
            warning: hiddenWarning
        });
    }
    catch (error) {
        const message = getErrorMessage(error);
        res.status(500).json({ ok: false, error: message });
    }
});
app.post("/api/auction/unhide-vehicle", async (req, res) => {
    try {
        const bodyUrl = typeof req.body?.url === "string" ? req.body.url.trim() : "";
        const vehicle = normalizeVehicleInput(req.body?.vehicle);
        const url = bodyUrl || vehicle?.url || "";
        if (!url) {
            res.status(400).json({ ok: false, error: "URL inválida." });
            return;
        }
        sessionHiddenAuctionUrls.delete(url);
        const removed = await unhideAuctionVehicle(dataMongoConfig, url);
        res.json({ ok: true, url, removed });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ ok: false, error: message });
    }
});
// ── Envio WhatsApp (UI) ─────────────────────────────────────────────────────
app.post("/api/whatsapp/send-auctions", async (req, res) => {
    try {
        const zapi = getZApiConfigFromEnv();
        if (!zapi.enabled) {
            res.status(400).json({ error: "Z-API desabilitada. Configure ZAPI_ENABLED=true e credenciais." });
            return;
        }
        const rawVehicles = Array.isArray(req.body?.vehicles) ? req.body.vehicles : [];
        if (rawVehicles.length === 0) {
            res.status(400).json({ error: "Nenhum veículo para envio." });
            return;
        }
        const normalized = rawVehicles
            .map(normalizeVehicleInput)
            .filter((v) => v !== null);
        const vehicles = dedupeVehiclesByUrl(normalized).slice(0, WHATS_BATCH_LIMIT);
        if (vehicles.length === 0) {
            res.status(400).json({ error: "Payload sem veículos válidos." });
            return;
        }
        const requestedPhone = typeof req.body?.groupPhone === "string" ? req.body.groupPhone.trim() : "";
        const targetPhone = requestedPhone || (process.env.AUCTION_GROUP_PHONE ?? "").trim() || zapi.phone.trim();
        if (!targetPhone) {
            res.status(400).json({ error: "Destino do WhatsApp não configurado (groupPhone/AUCTION_GROUP_PHONE/ZAPI_PHONE)." });
            return;
        }
        const requestedDelay = Number(req.body?.delayMs);
        const delayMs = Number.isFinite(requestedDelay)
            ? Math.max(WHATS_DELAY_MIN_MS, Math.min(WHATS_DELAY_MAX_MS, Math.floor(requestedDelay)))
            : WHATS_DELAY_DEFAULT_MS;
        const logs = [];
        const urls = vehicles.map((vehicle) => vehicle.url);
        let hiddenByMongo = new Set();
        try {
            hiddenByMongo = await retryTransientMongo("getHiddenAuctionVehicleUrlSet(/api/whatsapp/send-auctions)", () => getHiddenAuctionVehicleUrlSet(dataMongoConfig, urls));
        }
        catch (error) {
            if (!isTransientMongoError(error))
                throw error;
            console.warn(`[whatsapp] Mongo indisponível ao carregar bloqueados: ${getErrorMessage(error)}. ` +
                "Usando apenas bloqueios da sessão atual.");
        }
        const blockedUrlSet = new Set([
            ...hiddenByMongo,
            ...sessionHiddenAuctionUrls
        ]);
        const vehiclesToSend = [];
        for (const vehicle of vehicles) {
            if (blockedUrlSet.has(vehicle.url)) {
                logs.push({
                    url: vehicle.url,
                    status: "skipped",
                    mode: "none",
                    reason: "already_sent_or_archived"
                });
                continue;
            }
            vehiclesToSend.push(vehicle);
        }
        const sentVehicles = [];
        let sent = 0;
        let failed = 0;
        for (const vehicle of vehiclesToSend) {
            const result = await sendAuctionVehicleToWhats(vehicle, targetPhone, delayMs);
            if (result.ok) {
                sent += 1;
                sentVehicles.push(vehicle);
                logs.push({
                    url: vehicle.url,
                    status: "sent",
                    mode: result.sentWithImage ? "image+caption" : "text",
                    reason: result.reason,
                    response: result.response
                });
            }
            else {
                failed += 1;
                logs.push({
                    url: vehicle.url,
                    status: "error",
                    mode: "text",
                    reason: result.reason,
                    response: result.response
                });
            }
        }
        let warning = null;
        if (sentVehicles.length > 0) {
            for (const vehicle of sentVehicles) {
                sessionHiddenAuctionUrls.add(vehicle.url);
            }
            try {
                await retryTransientMongo("hideAuctionVehicles(/api/whatsapp/send-auctions)", () => hideAuctionVehicles(dataMongoConfig, sentVehicles.map((vehicle) => ({
                    url: vehicle.url,
                    source: vehicle.source,
                    brand: vehicle.brand,
                    model: vehicle.model,
                    year: vehicle.year ?? null,
                    damage: vehicle.damage ?? null,
                    reason: "sent_whatsapp"
                }))));
            }
            catch (error) {
                if (!isTransientMongoError(error))
                    throw error;
                warning =
                    `Mongo indisponível ao persistir bloqueio de enviados (${getErrorMessage(error)}). ` +
                        "Os enviados desta sessão continuarão bloqueados em memória.";
                console.warn(`[whatsapp] ${warning}`);
            }
        }
        res.json({
            ok: true,
            targetPhone,
            delayMs,
            total: vehicles.length,
            attempted: vehiclesToSend.length,
            blocked: vehicles.length - vehiclesToSend.length,
            sent,
            failed,
            logs,
            degraded: Boolean(warning),
            warning
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(500).json({ error: message });
    }
});
// ── Marketplace via SSE ─────────────────────────────────────────────────────
app.get("/api/marketplace/search", async (req, res) => {
    const term = (req.query.term ?? "").trim();
    const maxScrolls = clampPositiveInt(req.query.maxScrolls, clampPositiveInt(process.env.MAX_SCROLLS, 4, 1, 20), 1, 20);
    const profilePath = process.env.PROFILE_PATH?.trim() || "./data/facebook-profile";
    const outputPath = process.env.OUTPUT_PATH?.trim() || "./output/results.json";
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();
    const send = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };
    if (!term) {
        send("error", { message: "Termo de busca obrigatório." });
        res.end();
        return;
    }
    let clientDisconnected = false;
    req.on("close", () => {
        clientDisconnected = true;
    });
    try {
        send("status", {
            message: `Iniciando marketplace: "${term}"`,
            term,
            maxScrolls
        });
        const run = await executeSearchRun({
            searchTerm: term,
            maxScrolls,
            headless,
            profilePath,
            outputPath,
            mongoConfig: dataMongoConfig,
            zApiConfig: { ...getZApiConfigFromEnv(), enabled: false },
            shouldCancel: () => clientDisconnected,
            log: (message) => send("log", { message })
        });
        if (clientDisconnected) {
            return;
        }
        let total = 0;
        for (const item of run.results) {
            send("result", { item });
            total += 1;
        }
        send("done", {
            total,
            effectiveSearchTerm: run.effectiveSearchTerm,
            conditionMode: run.conditionMode,
            semanticRuleName: run.semanticRuleName,
            collectedCandidates: run.collectedCandidates.length
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        send("error", { message });
    }
    res.end();
});
// ── Scraping via SSE ──────────────────────────────────────────────────────────
app.get("/api/scrape", async (req, res) => {
    const source = (req.query.source ?? "all").toLowerCase().trim();
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders();
    const send = (type, data) => {
        res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
    };
    try {
        const { filters, warning } = await loadAuctionFiltersSafe((message) => {
            send("log", { message });
        });
        if (warning) {
            send("status", { message: "⚠️ Mongo instável: usando fallback temporário de filtros." });
        }
        send("filters", filters);
        const toRun = source === "all"
            ? Object.entries(SCRAPERS)
            : Object.entries(SCRAPERS).filter(([name]) => name === source);
        if (toRun.length === 0) {
            send("error", { message: `Fonte desconhecida: "${source}". Use: ${Object.keys(SCRAPERS).join(", ")} ou all` });
            res.end();
            return;
        }
        const sourceNames = toRun.map(([n]) => SOURCE_LABELS[n] ?? n).join(", ");
        send("status", { message: `Iniciando: ${sourceNames}` });
        send("status", {
            message: "Modo preview: bruto coletado com marcação de filtros no front."
        });
        let total = 0;
        let totalRaw = 0;
        let totalFiltered = 0;
        let totalHidden = 0;
        let totalPassingFilters = 0;
        for (const [name, scraper] of toRun) {
            send("scraper-start", { source: name, label: SOURCE_LABELS[name] ?? name });
            try {
                const log = (msg) => send("log", { source: name, message: msg });
                const results = await scraper(filters, { headless, log });
                log(`[${name}] ${results.length} veículo(s) coletado(s) bruto.`);
                totalRaw += results.length;
                const locationFiltered = applyLocationFilters(results, filters, log);
                const comboFiltered = applyComboRules(locationFiltered, filters.comboRules ?? [], log);
                log(`[${name}] ${comboFiltered.length}/${locationFiltered.length} veículo(s) após combos.`);
                totalFiltered += comboFiltered.length;
                const filteredUrlSet = new Set(comboFiltered
                    .map((vehicle) => vehicle.url)
                    .filter((url) => Boolean(url && url.trim())));
                const previewCandidates = dedupeVehiclesByUrl(results);
                if (previewCandidates.length < results.length) {
                    log(`[${name}] ${previewCandidates.length}/${results.length} veículo(s) após deduplicação bruta para preview.`);
                }
                const urls = previewCandidates
                    .map((v) => v.url)
                    .filter((url) => Boolean(url && url.trim()));
                const [hiddenByMongo, overridesByUrl] = await Promise.all([
                    getHiddenAuctionVehicleUrlSet(dataMongoConfig, urls),
                    getAuctionVehicleOverridesByUrls(dataMongoConfig, urls)
                ]);
                const hiddenUrlSet = new Set([
                    ...hiddenByMongo,
                    ...sessionHiddenAuctionUrls
                ]);
                let hiddenCount = 0;
                let passingFiltersCount = 0;
                let streamedPreviewCount = 0;
                for (const vehicle of previewCandidates) {
                    if (hiddenUrlSet.has(vehicle.url)) {
                        hiddenCount += 1;
                        continue;
                    }
                    const passesFilters = filteredUrlSet.has(vehicle.url);
                    if (passesFilters) {
                        passingFiltersCount += 1;
                    }
                    const mergedVehicle = applyAuctionVehicleOverride(vehicle, overridesByUrl.get(vehicle.url));
                    send("vehicle", {
                        vehicle: mergedVehicle,
                        caption: formatAuctionCardCaption(mergedVehicle),
                        passesFilters
                    });
                    streamedPreviewCount += 1;
                    if (streamedPreviewCount % 8 === 0) {
                        await sleep(0);
                    }
                    total++;
                }
                if (hiddenCount > 0) {
                    log(`[${name}] ${hiddenCount} veículo(s) ocultado(s) por arquivo manual.`);
                }
                totalHidden += hiddenCount;
                totalPassingFilters += passingFiltersCount;
                send("scraper-done", {
                    source: name,
                    rawCount: results.length,
                    filteredCount: comboFiltered.length,
                    previewCount: previewCandidates.length,
                    passingFiltersCount,
                    hiddenCount,
                    count: previewCandidates.length - hiddenCount
                });
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                send("scraper-error", { source: name, message });
            }
        }
        send("done", { total, totalRaw, totalFiltered, totalHidden, totalPassingFilters });
    }
    catch (err) {
        const message = getErrorMessage(err);
        send("error", { message });
    }
    res.end();
});
// ── Image proxy (para imagens que exigem Referer) ─────────────────────────────
const ALLOWED_IMAGE_HOSTS = [
    "srv1.favaretoleiloes.com.br",
    "srv2.favaretoleiloes.com.br",
    "www.claudiokussleiloes.com.br",
    "claudiokussleiloes.com.br"
];
app.get("/api/proxy-image", async (req, res) => {
    const url = req.query.url;
    if (!url) {
        res.status(400).send("Missing url");
        return;
    }
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        res.status(400).send("Invalid url");
        return;
    }
    if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) {
        res.status(403).send("Host not allowed");
        return;
    }
    try {
        const referer = parsed.hostname === "srv1.favaretoleiloes.com.br" ||
            parsed.hostname === "srv2.favaretoleiloes.com.br"
            ? "https://www.favaretoleiloes.com.br/"
            : parsed.hostname === "www.claudiokussleiloes.com.br" ||
                parsed.hostname === "claudiokussleiloes.com.br"
                ? "https://www.claudiokussleiloes.com.br/"
                : `${parsed.protocol}//${parsed.hostname}/`;
        const upstream = await fetch(url, {
            headers: {
                "Referer": referer,
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            }
        });
        if (!upstream.ok) {
            res.status(upstream.status).send("Upstream error");
            return;
        }
        const ct = upstream.headers.get("content-type") ?? "image/jpeg";
        res.setHeader("Content-Type", ct);
        res.setHeader("Cache-Control", "public, max-age=86400");
        const buf = await upstream.arrayBuffer();
        res.send(Buffer.from(buf));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).send(message);
    }
});
// ── FIPE lookup ───────────────────────────────────────────────────────────────
app.get("/api/fipe/:plate", async (req, res) => {
    const plate = (req.params.plate ?? "").toUpperCase();
    try {
        const result = await lookupFipe(plate, { headless });
        if (result.ok) {
            res.json({ ok: true, caption: formatFipeResult(result.data), data: result.data });
        }
        else {
            res.json({ ok: false, reason: result.reason });
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ ok: false, reason: message });
    }
});
// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`\n🤖  Bot Anúncios — Dev UI`);
    console.log(`    ${url}\n`);
    const cmd = process.platform === "win32"
        ? `start ${url}`
        : process.platform === "darwin"
            ? `open ${url}`
            : `xdg-open ${url}`;
    exec(cmd);
});
