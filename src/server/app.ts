import dotenv from "dotenv";
import express from "express";
import { exec } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import { formatAuctionCardCaption } from "../formatters/auction-card.js";
import {
  getAuctionFilters,
  upsertAuctionFilters,
  migrateLegacyAuctionFiltersToCombos,
  getMongoDataConfigFromEnv,
  getAuctionVehicleOverridesByUrls,
  upsertAuctionVehicleOverride,
  hideAuctionVehicle,
  hideAuctionVehicles,
  getHiddenAuctionVehicleUrlSet,
  listHiddenAuctionVehicles,
  unhideAuctionVehicle,
  upsertAuctionSentVehicles,
  listAuctionSentVehicles,
  getAuctionSentVehicleByUrl,
  markAuctionSentVehicleSold,
  upsertAuctionSentVehicleFipe,
  type AuctionSentVehicle,
  type AuctionVehicleOverride,
  type AuctionComboRule,
  type AuctionFilters
} from "../integrations/mongo.js";
import { filterAuctionVehiclesByGeo } from "../location-filter.js";
import { getZApiConfigFromEnv, sendTextMessageToZApi } from "../integrations/zapi.js";
import { getFipeApiConfigFromEnv, lookupFipeByBrandModelYear } from "../integrations/fipe-api.js";
import { executeSearchRun } from "../search-runner.js";
import { scrapeCopart } from "../scrapers/copart.js";
import { scrapeFavareto } from "../scrapers/favareto.js";
import { scrapeLeiloesJudiciais } from "../scrapers/leiloesjudiciais.js";
import { scrapeMegaleiloes } from "../scrapers/megaleiloes.js";
import { lookupFipe, formatFipeResult } from "../scrapers/placafipe.js";
import { fetchSodreVehicleByUrl, parseSodreLotUrl, scrapeSodre } from "../scrapers/sodre.js";
import { scrapeSuperbid } from "../scrapers/superbid.js";
import { scrapeVsVeiculos } from "../scrapers/vs-veiculos.js";
import { scrapeClaudioKuss } from "../scrapers/claudio-kuss.js";
import { scrapeVipLeiloes } from "../scrapers/vipleiloes.js";
import { parseBoolean } from "../utils.js";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEV_PORT = parseDevPort(process.env.DEV_PORT, 4000);
const DEV_HOST = (process.env.DEV_HOST ?? "127.0.0.1").trim() || "127.0.0.1";
const dataMongoConfig = getMongoDataConfigFromEnv();
const headless = parseBoolean(process.env.HEADLESS, true);
const WHATS_DELAY_DEFAULT_MS = 5_000;
const WHATS_DELAY_MIN_MS = 1_000;
const WHATS_DELAY_MAX_MS = 15_000;
const WHATS_BATCH_LIMIT = 200;
const MANUAL_TRACKING_TARGET = "__manual__";
const sessionHiddenAuctionUrls = new Set<string>();
const MONGO_TRANSIENT_ERROR_RE =
  /ETIMEDOUT|ECONNRESET|ECONNREFUSED|Mongo(Network|ServerSelection)|server selection|socket hang up|connection .* closed/i;
const MONGO_RETRY_DELAYS_MS = [400, 1_000];

let lastKnownAuctionFilters: Awaited<ReturnType<typeof getAuctionFilters>> | null = null;

const SCRAPERS: Record<
  string,
  (filters: Awaited<ReturnType<typeof getAuctionFilters>>, opts: { headless: boolean; log: (m: string) => void }) => Promise<AuctionVehicle[]>
> = {
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

const SOURCE_LABELS: Record<string, string> = {
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTransientMongoError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return MONGO_TRANSIENT_ERROR_RE.test(message);
}

async function retryTransientMongo<T>(
  label: string,
  run: () => Promise<T>,
  log?: (message: string) => void
): Promise<T> {
  for (let attempt = 0; attempt <= MONGO_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (!isTransientMongoError(error) || attempt >= MONGO_RETRY_DELAYS_MS.length) {
        throw error;
      }

      const waitMs = MONGO_RETRY_DELAYS_MS[attempt] ?? 1_000;
      const msg = `[mongo] ${label}: falha transitória (${getErrorMessage(
        error
      )}). Novo retry em ${Math.round(waitMs / 100) / 10}s.`;
      if (log) log(msg);
      else console.warn(msg);

      await sleep(waitMs);
    }
  }

  throw new Error(`[mongo] ${label}: retries esgotados.`);
}

function buildFallbackAuctionFilters(): Awaited<ReturnType<typeof getAuctionFilters>> {
  return {
    locations: [],
    states: ["PR"],
    cities: [],
    comboRules: [],
    updatedAt: new Date()
  };
}

async function loadAuctionFiltersSafe(
  log?: (message: string) => void
): Promise<{
  filters: Awaited<ReturnType<typeof getAuctionFilters>>;
  warning: string | null;
}> {
  try {
    const filters = await retryTransientMongo(
      "getAuctionFilters",
      () => getAuctionFilters(dataMongoConfig),
      log
    );
    lastKnownAuctionFilters = filters;
    return { filters, warning: null };
  } catch (error) {
    if (!isTransientMongoError(error)) {
      throw error;
    }

    const message = getErrorMessage(error);
    if (lastKnownAuctionFilters) {
      const warning = `[mongo] filtros indisponíveis temporariamente (${message}). Usando cache em memória.`;
      if (log) log(warning);
      else console.warn(warning);
      return { filters: lastKnownAuctionFilters, warning };
    }

    const warning = `[mongo] filtros indisponíveis temporariamente (${message}). Usando filtros padrão.`;
    if (log) log(warning);
    else console.warn(warning);
    return { filters: buildFallbackAuctionFilters(), warning };
  }
}

function clampPositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function parseDevPort(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;

  const integer = Math.floor(parsed);
  if (integer === 0) return 0; // porta automática (escolhida pelo SO)
  if (integer < 1) return fallback;

  return Math.min(integer, 65_535);
}

function parseAuctionDateInput(raw: unknown): Date | null {
  if (raw == null || raw === "") return null;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const d = new Date(raw);
    return isNaN(d.getTime()) ? null : d;
  }

  const value = String(raw).trim();
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function parseOptionalPositiveMoney(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.round(raw);
  }
  if (typeof raw === "string") {
    const normalized = raw.replace(/[^\d,.-]/g, "").replace(/\./g, "").replace(",", ".");
    if (!normalized.trim()) return null;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return Math.round(parsed);
  }
  return null;
}

function normalizeOptionalText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function applyAuctionVehicleOverride(
  vehicle: AuctionVehicle,
  override: AuctionVehicleOverride | undefined
): AuctionVehicle {
  if (!override) return vehicle;

  const merged: AuctionVehicle = { ...vehicle };
  if (override.manualFipe != null) {
    merged.fipe = override.manualFipe;
    merged.fipeRaw = override.fipePriceRaw ?? null;
  }
  if (override.fipeCode) {
    merged.fipeCode = override.fipeCode;
  }
  if (override.fipeReferenceMonth) {
    merged.fipeReferenceMonth = override.fipeReferenceMonth;
  }
  if (override.fipeModelYear != null) {
    merged.fipeModelYear = override.fipeModelYear;
  }
  if (override.fipeFuel) {
    merged.fipeFuel = override.fipeFuel;
  }
  if (override.fipeBrandMatched) {
    merged.fipeBrandMatched = override.fipeBrandMatched;
  }
  if (override.fipeModelMatched) {
    merged.fipeModelMatched = override.fipeModelMatched;
  }
  if (override.fipeCheckedAt) {
    merged.fipeCheckedAt = override.fipeCheckedAt;
  }
  if (override.manualCostsTotal != null) {
    merged.manualCostsTotal = override.manualCostsTotal;
  }
  if (override.notes) {
    merged.costNotes = override.notes;
  }
  return merged;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getDevUiBrowserHost(host: string): string {
  if (host === "0.0.0.0" || host === "::") {
    return "localhost";
  }
  return host;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsToken(
  haystack: string,
  token: string | null | undefined,
  options?: { allowCompactFallback?: boolean }
): boolean {
  const needle = normalizeSearchText(token ?? "");
  if (!needle) return true;

  const normalizedHaystack = normalizeSearchText(haystack);
  const boundaryPattern = needle
    .split(" ")
    .filter(Boolean)
    .map(escapeRegExp)
    .join(" ");
  if (!boundaryPattern) return true;

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
  if (!compactNeedle) return true;
  const hasLetter = /[A-Z]/.test(compactNeedle);
  const hasDigit = /\d/.test(compactNeedle);
  const hasWhitespace = needle.includes(" ");
  if (!hasLetter) return false;
  if (!hasDigit && !hasWhitespace) return false;

  const compactHaystack = normalizedHaystack.replace(/\s+/g, "");
  return compactHaystack.includes(compactNeedle);
}

function matchesComboRule(vehicle: AuctionVehicle, rule: AuctionComboRule): boolean {
  if (!rule.enabled) return false;
  const hasRule =
    Boolean(rule.brand && rule.brand.trim()) ||
    Boolean(rule.model && rule.model.trim()) ||
    Boolean(rule.text && rule.text.trim()) ||
    rule.minYear != null;
  if (!hasRule) return false;

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

function hasComboRuleFields(rule: AuctionComboRule | null | undefined): boolean {
  if (!rule) return false;
  return Boolean(
    String(rule.brand ?? "").trim() ||
    String(rule.model ?? "").trim() ||
    String(rule.text ?? "").trim() ||
    rule.minYear != null
  );
}

function applyComboRules(
  vehicles: AuctionVehicle[],
  rules: AuctionComboRule[],
  log?: (message: string) => void
): AuctionVehicle[] {
  const activeRules = (rules ?? []).filter(
    (rule) => rule && rule.enabled && hasComboRuleFields(rule)
  );
  if (activeRules.length === 0) {
    return vehicles;
  }

  const includeRules = activeRules.filter((rule) => (rule.mode ?? "include") !== "exclude");
  const excludeRules = activeRules.filter((rule) => (rule.mode ?? "include") === "exclude");
  let filtered = includeRules.length > 0
    ? vehicles.filter((vehicle) => includeRules.some((rule) => matchesComboRule(vehicle, rule)))
    : [...vehicles];

  if (excludeRules.length > 0) {
    filtered = filtered.filter((vehicle) =>
      !excludeRules.some((rule) => matchesComboRule(vehicle, rule))
    );
  }

  if (log) {
    log(
      `[combo] ${filtered.length}/${vehicles.length} veículo(s) após ${activeRules.length} regra(s): ` +
      `${includeRules.length} inclusão + ${excludeRules.length} exclusão.`
    );
  }
  return filtered;
}

function applyLocationFilters(
  vehicles: AuctionVehicle[],
  filters: AuctionFilters,
  log?: (message: string) => void
): AuctionVehicle[] {
  const geo = filterAuctionVehiclesByGeo(vehicles, {
    states: filters.states,
    cities: filters.cities
  });

  if (log && (geo.activeStates.length > 0 || geo.activeCities.length > 0)) {
    log(
      `[geo] ${geo.vehicles.length}/${vehicles.length} veículo(s) após localização` +
      ` (estados=${geo.activeStates.join(", ") || "-"}; cidades=${geo.activeCities.join(", ") || "-"})`
    );
  }

  return geo.vehicles;
}

function normalizeVehicleInput(raw: unknown): AuctionVehicle | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const url = typeof v.url === "string" ? v.url.trim() : "";
  if (!url) return null;

  const imageUrls = Array.isArray(v.imageUrls)
    ? v.imageUrls.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    : [];
  const source = typeof v.source === "string" ? v.source : "copart";

  const year = typeof v.year === "number" ? v.year : null;
  const price = typeof v.price === "number" ? v.price : null;
  const appraisal = typeof v.appraisal === "number" ? v.appraisal : null;
  const fipe = typeof v.fipe === "number" ? v.fipe : null;
  const fipeModelYear = typeof v.fipeModelYear === "number" ? v.fipeModelYear : null;
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
      : "copart") as AuctionVehicle["source"],
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
    fipeCode: normalizeOptionalText(v.fipeCode),
    fipeReferenceMonth: normalizeOptionalText(v.fipeReferenceMonth),
    fipeModelYear: Number.isFinite(fipeModelYear) ? fipeModelYear : null,
    fipeFuel: normalizeOptionalText(v.fipeFuel),
    fipeBrandMatched: normalizeOptionalText(v.fipeBrandMatched),
    fipeModelMatched: normalizeOptionalText(v.fipeModelMatched),
    fipeCheckedAt: typeof v.fipeCheckedAt === "string" ? v.fipeCheckedAt : null,
    fipeLookupError: normalizeOptionalText(v.fipeLookupError),
    manualCostsTotal,
    costNotes
  };
}

function dedupeVehiclesByUrl(vehicles: AuctionVehicle[]): AuctionVehicle[] {
  const seen = new Set<string>();
  const deduped: AuctionVehicle[] = [];
  for (const vehicle of vehicles) {
    if (seen.has(vehicle.url)) continue;
    seen.add(vehicle.url);
    deduped.push(vehicle);
  }
  return deduped;
}

type AuctionVehicleSummary = {
  brand?: string | null;
  model?: string | null;
  year?: number | null;
  source?: string | null;
  url?: string | null;
};

function formatMoneyBrl(value: number | null): string | null {
  if (value == null || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value.toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0
  });
}

function formatAuctionPrice(price: number | null, priceRaw: string | null): string {
  return priceRaw?.trim() || formatMoneyBrl(price) || "Sem lance";
}

function buildAuctionVehicleTitle(vehicle: AuctionVehicleSummary): string {
  const pieces = [vehicle.brand, vehicle.model].filter(Boolean).map((item) => String(item).trim());
  const year = Number.isFinite(vehicle.year) ? String(vehicle.year) : "";
  const title = [...pieces, year].filter(Boolean).join(" ").trim();
  if (title) return title;
  return normalizeOptionalText(vehicle.url) ?? "Veículo sem título";
}

function normalizeComparableAuctionUrl(raw: string): string {
  const input = raw.trim();
  if (!input) return "";

  try {
    const parsed = new URL(input);
    parsed.hash = "";
    parsed.search = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().toLowerCase();
  } catch {
    return input.replace(/\/+$/, "").toLowerCase();
  }
}

function findAuctionVehicleByUrl(vehicles: AuctionVehicle[], urlInput: string): AuctionVehicle | null {
  const target = normalizeComparableAuctionUrl(urlInput);
  if (!target) return null;

  const direct = vehicles.find((vehicle) => normalizeComparableAuctionUrl(vehicle.url) === target);
  if (direct) {
    return direct;
  }

  return (
    vehicles.find((vehicle) => {
      const normalized = normalizeComparableAuctionUrl(vehicle.url);
      if (!normalized) return false;
      return normalized.includes(target) || target.includes(normalized);
    }) ?? null
  );
}

function isManualTrackedTarget(value: string | null | undefined): boolean {
  return String(value ?? "").trim() === MANUAL_TRACKING_TARGET;
}

function isClosedAuctionUrl(rawUrl: string): boolean {
  return /\/lotes-encerrados\//i.test(rawUrl);
}

async function resolveAuctionVehicleFromUrl(url: string): Promise<AuctionVehicle | null> {
  if (parseSodreLotUrl(url)) {
    return fetchSodreVehicleByUrl(url, {
      headless,
      log: () => undefined
    });
  }

  return null;
}

async function saveAuctionVehicleAsTracked(vehicle: AuctionVehicle, options?: { sold?: boolean }): Promise<AuctionSentVehicle | null> {
  await retryTransientMongo(
    "upsertAuctionSentVehicles(saveAuctionVehicleAsTracked)",
    () =>
      upsertAuctionSentVehicles(dataMongoConfig, {
        targetPhone: MANUAL_TRACKING_TARGET,
        vehicles: [
          {
            url: vehicle.url,
            source: vehicle.source,
            brand: vehicle.brand,
            model: vehicle.model,
            year: vehicle.year ?? null,
            damage: vehicle.damage ?? null,
            price: vehicle.price ?? null,
            priceRaw: vehicle.priceRaw ?? null,
            priceLabel: vehicle.priceLabel ?? null,
            imageUrls: vehicle.imageUrls,
            fipe: vehicle.fipe ?? null,
            fipeRaw: vehicle.fipeRaw ?? null,
            fipeCode: vehicle.fipeCode ?? null,
            fipeReferenceMonth: vehicle.fipeReferenceMonth ?? null,
            fipeModelYear: vehicle.fipeModelYear ?? null,
            fipeFuel: vehicle.fipeFuel ?? null,
            fipeBrandMatched: vehicle.fipeBrandMatched ?? null,
            fipeModelMatched: vehicle.fipeModelMatched ?? null,
            fipeCheckedAt: vehicle.fipeCheckedAt ?? null
          }
        ]
      })
  );

  if (options?.sold === true) {
    const soldPrice = parseOptionalPositiveMoney(vehicle.price);
    const soldPriceRaw = normalizeOptionalText(vehicle.priceRaw);
    const soldPriceLabel = normalizeOptionalText(vehicle.priceLabel);
    return retryTransientMongo(
      "markAuctionSentVehicleSold(saveAuctionVehicleAsTracked)",
      () =>
        markAuctionSentVehicleSold(dataMongoConfig, {
          url: vehicle.url,
          targetPhone: MANUAL_TRACKING_TARGET,
          source: vehicle.source,
          brand: vehicle.brand,
          model: vehicle.model,
          year: vehicle.year ?? null,
          damage: vehicle.damage ?? null,
          imageUrl: vehicle.imageUrls[0] ?? null,
          latestPrice: soldPrice,
          latestPriceRaw: soldPriceRaw,
          latestPriceLabel: soldPriceLabel,
          soldAt: new Date(),
          notifiedAt: null,
          notifyError: null
        })
    );
  }

  return retryTransientMongo(
    "getAuctionSentVehicleByUrl(saveAuctionVehicleAsTracked)",
    () => getAuctionSentVehicleByUrl(dataMongoConfig, vehicle.url)
  );
}

function buildSoldAuctionMessage(vehicle: AuctionVehicle, soldPriceText: string): string {
  const source = SOURCE_LABELS[vehicle.source] ?? vehicle.source;
  const title = buildAuctionVehicleTitle(vehicle);
  return [
    "✅ Carro vendido",
    `🚗 ${title}`,
    `🏷️ Fonte: ${source}`,
    `💰 Lance vendido: ${soldPriceText}`,
    `🔗 ${vehicle.url}`
  ].join("\n");
}

async function sendAuctionVehicleToWhats(
  vehicle: AuctionVehicle,
  targetPhone: string,
  delayMs: number
): Promise<{ ok: boolean; sentWithImage: boolean; reason?: string; response?: unknown }> {
  const zapi = getZApiConfigFromEnv();
  if (!zapi.enabled) return { ok: false, sentWithImage: false, reason: "Z-API desabilitada" };
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
            try { return JSON.parse(responseText); } catch { return responseText; }
          })()
        : null;

      if (response.ok) {
        return { ok: true, sentWithImage: true, response: parsed };
      }
      return { ok: false, sentWithImage: false, reason: `HTTP ${response.status}`, response: parsed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // fallback para texto puro se imagem falhar
      const textFallback = await sendTextMessageToZApi(zapi, { phone: targetPhone, message: caption });
      if (textFallback.ok) {
        return { ok: true, sentWithImage: false, reason: `imagem falhou: ${message}` };
      }
      return { ok: false, sentWithImage: false, reason: `imagem/texto falharam: ${textFallback.reason ?? message}` };
    } finally {
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
  } catch (error) {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.post("/api/filters/migrate-legacy", async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await migrateLegacyAuctionFiltersToCombos(dataMongoConfig, { force });
    res.json(result);
  } catch (error) {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/auction/vehicle-fipe", async (req, res) => {
  try {
    const vehicle = normalizeVehicleInput(req.body?.vehicle);
    if (!vehicle) {
      res.status(400).json({ ok: false, error: "Veículo inválido." });
      return;
    }

    const year = Number.isFinite(vehicle.year) ? Number(vehicle.year) : null;
    if (!vehicle.brand || !vehicle.model || year == null) {
      res.status(400).json({
        ok: false,
        error: "Dados insuficientes para FIPE (marca/modelo/ano ausentes no veículo)."
      });
      return;
    }

    const fipeConfig = getFipeApiConfigFromEnv();
    const fipe = await lookupFipeByBrandModelYear(fipeConfig, {
      brand: vehicle.brand,
      model: vehicle.model,
      year
    });

    if (!fipe.ok) {
      res.status(400).json({
        ok: false,
        error: fipe.reason,
        suggestions: fipe.suggestions ?? null,
        vehicle
      });
      return;
    }

    const fipeCheckedAt = new Date();
    const savedOverride = await upsertAuctionVehicleOverride(dataMongoConfig, {
      url: vehicle.url,
      manualFipe: fipe.data.price,
      fipePriceRaw: fipe.data.priceRaw,
      fipeCode: fipe.data.codeFipe,
      fipeReferenceMonth: fipe.data.referenceMonth,
      fipeModelYear: fipe.data.modelYear,
      fipeFuel: fipe.data.fuel,
      fipeBrandMatched: fipe.data.brandMatched,
      fipeModelMatched: fipe.data.modelMatched,
      fipeCheckedAt
    });

    const updatedVehicle = applyAuctionVehicleOverride({
      ...vehicle,
      fipe: fipe.data.price,
      fipeRaw: fipe.data.priceRaw,
      fipeCode: fipe.data.codeFipe,
      fipeReferenceMonth: fipe.data.referenceMonth,
      fipeModelYear: fipe.data.modelYear,
      fipeFuel: fipe.data.fuel,
      fipeBrandMatched: fipe.data.brandMatched,
      fipeModelMatched: fipe.data.modelMatched,
      fipeCheckedAt: fipeCheckedAt.toISOString(),
      fipeLookupError: null
    }, savedOverride ?? undefined);

    res.json({
      ok: true,
      vehicle: updatedVehicle,
      caption: formatAuctionCardCaption(updatedVehicle),
      fipe: fipe.data,
      persisted: savedOverride != null
    });
  } catch (error) {
    const message = getErrorMessage(error);
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

app.get("/api/auction/hidden", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = clampPositiveInt(req.query.limit, 200, 1, 500);
    let hiddenWarning: string | null = null;
    let hiddenFromDb: Awaited<ReturnType<typeof listHiddenAuctionVehicles>> = [];

    try {
      hiddenFromDb = await retryTransientMongo(
        "listHiddenAuctionVehicles",
        () => listHiddenAuctionVehicles(dataMongoConfig, { q, limit, includeLargeDamage: false })
      );
    } catch (error) {
      if (!isTransientMongoError(error)) throw error;
      hiddenWarning =
        `Mongo indisponível temporariamente (${getErrorMessage(error)}). ` +
        "Exibindo apenas arquivados da sessão atual.";
      console.warn(`[hidden] ${hiddenWarning}`);
    }

    const byUrl = new Map<string, (typeof hiddenFromDb)[number]>();
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

    const items = Array.from(byUrl.values()).sort(
      (a, b) => new Date(b.hiddenAt).getTime() - new Date(a.hiddenAt).getTime()
    );
    res.json({
      ok: true,
      items,
      degraded: Boolean(hiddenWarning),
      warning: hiddenWarning
    });
  } catch (error) {
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
  } catch (error) {
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

    const rawVehicles: unknown[] = Array.isArray(req.body?.vehicles) ? req.body.vehicles : [];
    if (rawVehicles.length === 0) {
      res.status(400).json({ error: "Nenhum veículo para envio." });
      return;
    }

    const normalized = rawVehicles
      .map(normalizeVehicleInput)
      .filter((v): v is AuctionVehicle => v !== null);
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

    const logs: Array<{
      url: string;
      status: "sent" | "error" | "skipped";
      mode: "image+caption" | "text" | "none";
      reason?: string;
      response?: unknown;
    }> = [];
    const urls = vehicles.map((vehicle) => vehicle.url);
    let hiddenByMongo = new Set<string>();
    try {
      hiddenByMongo = await retryTransientMongo(
        "getHiddenAuctionVehicleUrlSet(/api/whatsapp/send-auctions)",
        () => getHiddenAuctionVehicleUrlSet(dataMongoConfig, urls)
      );
    } catch (error) {
      if (!isTransientMongoError(error)) throw error;
      console.warn(
        `[whatsapp] Mongo indisponível ao carregar bloqueados: ${getErrorMessage(error)}. ` +
        "Usando apenas bloqueios da sessão atual."
      );
    }
    const blockedUrlSet = new Set<string>([
      ...hiddenByMongo,
      ...sessionHiddenAuctionUrls
    ]);
    const vehiclesToSend: AuctionVehicle[] = [];
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

    const sentVehicles: AuctionVehicle[] = [];
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
      } else {
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

    const warnings: string[] = [];
    if (sentVehicles.length > 0) {
      for (const vehicle of sentVehicles) {
        sessionHiddenAuctionUrls.add(vehicle.url);
      }

      try {
        await retryTransientMongo(
          "upsertAuctionSentVehicles(/api/whatsapp/send-auctions)",
          () =>
            upsertAuctionSentVehicles(dataMongoConfig, {
              targetPhone,
              vehicles: sentVehicles.map((vehicle) => ({
                url: vehicle.url,
                source: vehicle.source,
                brand: vehicle.brand,
                model: vehicle.model,
                year: vehicle.year ?? null,
                damage: vehicle.damage ?? null,
                price: vehicle.price ?? null,
                priceRaw: vehicle.priceRaw ?? null,
                priceLabel: vehicle.priceLabel ?? null,
                imageUrls: vehicle.imageUrls,
                fipe: vehicle.fipe ?? null,
                fipeRaw: vehicle.fipeRaw ?? null,
                fipeCode: vehicle.fipeCode ?? null,
                fipeReferenceMonth: vehicle.fipeReferenceMonth ?? null,
                fipeModelYear: vehicle.fipeModelYear ?? null,
                fipeFuel: vehicle.fipeFuel ?? null,
                fipeBrandMatched: vehicle.fipeBrandMatched ?? null,
                fipeModelMatched: vehicle.fipeModelMatched ?? null,
                fipeCheckedAt: vehicle.fipeCheckedAt ?? null
              }))
            })
        );
      } catch (error) {
        if (!isTransientMongoError(error)) throw error;
        const warning =
          `Mongo indisponível ao salvar histórico de disparos (${getErrorMessage(error)}). ` +
          "Os itens enviados nesta sessão podem não aparecer no painel de disparos.";
        warnings.push(warning);
        console.warn(`[whatsapp] ${warning}`);
      }

      try {
        await retryTransientMongo(
          "hideAuctionVehicles(/api/whatsapp/send-auctions)",
          () =>
            hideAuctionVehicles(
              dataMongoConfig,
              sentVehicles.map((vehicle) => ({
                url: vehicle.url,
                source: vehicle.source,
                brand: vehicle.brand,
                model: vehicle.model,
                year: vehicle.year ?? null,
                damage: vehicle.damage ?? null,
                reason: "sent_whatsapp"
              }))
            )
        );
      } catch (error) {
        if (!isTransientMongoError(error)) throw error;
        const warning =
          `Mongo indisponível ao persistir bloqueio de enviados (${getErrorMessage(error)}). ` +
          "Os enviados desta sessão continuarão bloqueados em memória.";
        warnings.push(warning);
        console.warn(`[whatsapp] ${warning}`);
      }
    }

    const warning = warnings.length > 0 ? warnings.join(" ") : null;

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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

// ── Disparos / acompanhamento ─────────────────────────────────────────────────

app.get("/api/auction/sent", async (req, res) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q : "";
    const limit = clampPositiveInt(req.query.limit, 200, 1, 500);
    const soldQuery = typeof req.query.sold === "string" ? req.query.sold.trim().toLowerCase() : "";
    const sold =
      soldQuery === "1" || soldQuery === "true" || soldQuery === "vendido"
        ? true
        : soldQuery === "0" || soldQuery === "false" || soldQuery === "pendente"
          ? false
          : null;

    let warning: string | null = null;
    let items: AuctionSentVehicle[] = [];

    try {
      items = await retryTransientMongo(
        "listAuctionSentVehicles",
        () => listAuctionSentVehicles(dataMongoConfig, { q, sold, limit })
      );
    } catch (error) {
      if (!isTransientMongoError(error)) throw error;
      warning =
        `Mongo indisponível temporariamente (${getErrorMessage(error)}). ` +
        "Não foi possível carregar a lista de disparos enviados.";
      console.warn(`[sent] ${warning}`);
    }

    res.json({
      ok: true,
      items,
      degraded: Boolean(warning),
      warning
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/auction/sent/import-url", async (req, res) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ ok: false, error: "URL inválida." });
      return;
    }

    const vehicle = await resolveAuctionVehicleFromUrl(url);
    if (!vehicle) {
      res.status(404).json({
        ok: false,
        error: "Não foi possível buscar informações desse link. Hoje a importação direta suporta links da Sodré."
      });
      return;
    }

    const overridesByUrl = await getAuctionVehicleOverridesByUrls(dataMongoConfig, [vehicle.url]);
    let mergedVehicle = applyAuctionVehicleOverride(vehicle, overridesByUrl.get(vehicle.url));
    let fipeError: string | null = null;

    const hasFipe = Number.isFinite(Number(mergedVehicle.fipe)) && Number(mergedVehicle.fipe) > 0;
    const year = Number.isFinite(mergedVehicle.year) ? Number(mergedVehicle.year) : null;
    if (!hasFipe && mergedVehicle.brand && mergedVehicle.model && year != null) {
      const fipe = await lookupFipeByBrandModelYear(getFipeApiConfigFromEnv(), {
        brand: mergedVehicle.brand,
        model: mergedVehicle.model,
        year
      });

      if (fipe.ok) {
        const fipeCheckedAt = new Date();
        const savedOverride = await upsertAuctionVehicleOverride(dataMongoConfig, {
          url: mergedVehicle.url,
          manualFipe: fipe.data.price,
          fipePriceRaw: fipe.data.priceRaw,
          fipeCode: fipe.data.codeFipe,
          fipeReferenceMonth: fipe.data.referenceMonth,
          fipeModelYear: fipe.data.modelYear,
          fipeFuel: fipe.data.fuel,
          fipeBrandMatched: fipe.data.brandMatched,
          fipeModelMatched: fipe.data.modelMatched,
          fipeCheckedAt
        });
        mergedVehicle = applyAuctionVehicleOverride({
          ...mergedVehicle,
          fipe: fipe.data.price,
          fipeRaw: fipe.data.priceRaw,
          fipeCode: fipe.data.codeFipe,
          fipeReferenceMonth: fipe.data.referenceMonth,
          fipeModelYear: fipe.data.modelYear,
          fipeFuel: fipe.data.fuel,
          fipeBrandMatched: fipe.data.brandMatched,
          fipeModelMatched: fipe.data.modelMatched,
          fipeCheckedAt: fipeCheckedAt.toISOString()
        }, savedOverride ?? undefined);
      } else {
        fipeError = fipe.reason;
      }
    }

    const dispatch = await saveAuctionVehicleAsTracked(mergedVehicle, {
      sold: isClosedAuctionUrl(url)
    });

    if (!dispatch) {
      res.status(500).json({ ok: false, error: "Falha ao salvar veículo nos disparos." });
      return;
    }

    res.json({
      ok: true,
      dispatch,
      vehicle: mergedVehicle,
      sold: dispatch.sold,
      fipeError
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/auction/sent/check-sold", async (req, res) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ ok: false, error: "URL inválida." });
      return;
    }

    const dispatch = await retryTransientMongo(
      "getAuctionSentVehicleByUrl",
      () => getAuctionSentVehicleByUrl(dataMongoConfig, url)
    );
    if (!dispatch) {
      res.status(404).json({ ok: false, error: "Disparo não encontrado no histórico." });
      return;
    }

    const scraper = SCRAPERS[dispatch.source];
    if (!scraper) {
      res.status(400).json({
        ok: false,
        error: `Fonte sem suporte para reconsulta automática: ${dispatch.source || "desconhecida"}.`
      });
      return;
    }

    const { filters, warning: filterWarning } = await loadAuctionFiltersSafe();
    let freshVehicle = dispatch.source === "sodre"
      ? await fetchSodreVehicleByUrl(dispatch.url, {
          headless,
          log: () => undefined
        })
      : null;

    if (!freshVehicle) {
      let freshVehicles = await scraper(filters, {
        headless,
        log: () => undefined
      });
      freshVehicle = findAuctionVehicleByUrl(freshVehicles, dispatch.url);
      if (!freshVehicle) {
        const broadFilters: AuctionFilters = {
          ...filters,
          locations: [],
          states: [],
          cities: [],
          comboRules: [],
          updatedAt: new Date()
        };
        freshVehicles = await scraper(broadFilters, {
          headless,
          log: () => undefined
        });
        freshVehicle = findAuctionVehicleByUrl(freshVehicles, dispatch.url);
      }
    }
    if (!freshVehicle) {
      res.status(404).json({
        ok: false,
        error: "Não foi possível localizar esse lote no site para atualizar o lance."
      });
      return;
    }

    const soldPrice = parseOptionalPositiveMoney(freshVehicle.price);
    const soldPriceRaw = normalizeOptionalText(freshVehicle.priceRaw);
    const soldPriceLabel = normalizeOptionalText(freshVehicle.priceLabel);
    const soldPriceText = formatAuctionPrice(soldPrice, soldPriceRaw);

    const zapi = getZApiConfigFromEnv();
    const requestedPhone = normalizeOptionalText(req.body?.groupPhone);
    const dispatchPhone = isManualTrackedTarget(dispatch.targetPhone)
      ? null
      : normalizeOptionalText(dispatch.targetPhone);
    const fallbackPhone = normalizeOptionalText(process.env.AUCTION_GROUP_PHONE ?? "");
    const defaultPhone = normalizeOptionalText(zapi.phone);
    const targetPhone = requestedPhone ?? dispatchPhone ?? fallbackPhone ?? defaultPhone ?? "";

    const soldMessage = buildSoldAuctionMessage(freshVehicle, soldPriceText);
    let notifyError: string | null = null;
    let notifiedAt: Date | null = null;

    if (!targetPhone) {
      notifyError = "Destino do WhatsApp não configurado para aviso de vendido.";
    } else {
      const notifyResult = await sendTextMessageToZApi(zapi, {
        phone: targetPhone,
        message: soldMessage
      });
      if (notifyResult.ok) {
        notifiedAt = new Date();
      } else {
        notifyError = notifyResult.reason ?? "Falha ao enviar aviso de vendido.";
      }
    }

    const updatedDispatch = await retryTransientMongo(
      "markAuctionSentVehicleSold",
      () =>
        markAuctionSentVehicleSold(dataMongoConfig, {
          url: dispatch.url,
          targetPhone,
          source: freshVehicle.source,
          brand: freshVehicle.brand,
          model: freshVehicle.model,
          year: freshVehicle.year ?? null,
          damage: freshVehicle.damage ?? null,
          imageUrl: freshVehicle.imageUrls[0] ?? null,
          latestPrice: soldPrice,
          latestPriceRaw: soldPriceRaw,
          latestPriceLabel: soldPriceLabel,
          soldAt: dispatch.soldAt ?? new Date(),
          notifiedAt,
          notifyError
        })
    );

    if (!updatedDispatch) {
      res.status(500).json({ ok: false, error: "Falha ao atualizar status de vendido no histórico." });
      return;
    }

    res.json({
      ok: true,
      dispatch: updatedDispatch,
      notified: notifiedAt != null,
      notifyError,
      targetPhone,
      soldMessage,
      degraded: Boolean(filterWarning),
      warning: filterWarning
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ ok: false, error: message });
  }
});

app.post("/api/auction/sent/check-fipe", async (req, res) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) {
      res.status(400).json({ ok: false, error: "URL inválida." });
      return;
    }

    const dispatch = await retryTransientMongo(
      "getAuctionSentVehicleByUrl(check-fipe)",
      () => getAuctionSentVehicleByUrl(dataMongoConfig, url)
    );
    if (!dispatch) {
      res.status(404).json({ ok: false, error: "Disparo não encontrado no histórico." });
      return;
    }

    const year = Number.isFinite(dispatch.year) ? Number(dispatch.year) : null;
    if (!dispatch.brand || !dispatch.model || year == null) {
      const message = "Dados insuficientes para FIPE (marca/modelo/ano ausentes no registro).";
      await retryTransientMongo("upsertAuctionSentVehicleFipe(error-missing-data)", () =>
        upsertAuctionSentVehicleFipe(dataMongoConfig, {
          url: dispatch.url,
          fipeLookupError: message
        })
      );
      res.status(400).json({ ok: false, error: message });
      return;
    }

    const fipeConfig = getFipeApiConfigFromEnv();
    const fipe = await lookupFipeByBrandModelYear(fipeConfig, {
      brand: dispatch.brand,
      model: dispatch.model,
      year
    });

    if (!fipe.ok) {
      const updatedDispatch = await retryTransientMongo("upsertAuctionSentVehicleFipe(error)", () =>
        upsertAuctionSentVehicleFipe(dataMongoConfig, {
          url: dispatch.url,
          fipeLookupError: fipe.reason
        })
      );

      res.status(400).json({
        ok: false,
        error: fipe.reason,
        dispatch: updatedDispatch
      });
      return;
    }

    await retryTransientMongo("upsertAuctionVehicleOverride(check-fipe)", () =>
      upsertAuctionVehicleOverride(dataMongoConfig, {
        url: dispatch.url,
        manualFipe: fipe.data.price,
        fipePriceRaw: fipe.data.priceRaw,
        fipeCode: fipe.data.codeFipe,
        fipeReferenceMonth: fipe.data.referenceMonth,
        fipeModelYear: fipe.data.modelYear,
        fipeFuel: fipe.data.fuel,
        fipeBrandMatched: fipe.data.brandMatched,
        fipeModelMatched: fipe.data.modelMatched,
        fipeCheckedAt: new Date()
      })
    );

    const updatedDispatch = await retryTransientMongo("upsertAuctionSentVehicleFipe(success)", () =>
      upsertAuctionSentVehicleFipe(dataMongoConfig, {
        url: dispatch.url,
        fipePrice: fipe.data.price,
        fipePriceRaw: fipe.data.priceRaw,
        fipeCode: fipe.data.codeFipe,
        fipeReferenceMonth: fipe.data.referenceMonth,
        fipeModelYear: fipe.data.modelYear,
        fipeFuel: fipe.data.fuel,
        fipeBrandMatched: fipe.data.brandMatched,
        fipeModelMatched: fipe.data.modelMatched,
        fipeLookupError: null
      })
    );

    if (!updatedDispatch) {
      res.status(500).json({ ok: false, error: "Falha ao salvar retorno da FIPE no histórico." });
      return;
    }

    res.json({
      ok: true,
      dispatch: updatedDispatch,
      fipe: fipe.data
    });
  } catch (error) {
    const message = getErrorMessage(error);
    res.status(500).json({ ok: false, error: message });
  }
});

// ── Marketplace via SSE ─────────────────────────────────────────────────────

app.get("/api/marketplace/search", async (req, res) => {
  const term = ((req.query.term as string) ?? "").trim();
  const maxScrolls = clampPositiveInt(
    req.query.maxScrolls,
    clampPositiveInt(process.env.MAX_SCROLLS, 4, 1, 20),
    1,
    20
  );
  const profilePath = process.env.PROFILE_PATH?.trim() || "./data/facebook-profile";
  const outputPath = process.env.OUTPUT_PATH?.trim() || "./output/results.json";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (type: string, data: unknown): void => {
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    send("error", { message });
  }

  res.end();
});

// ── Scraping via SSE ──────────────────────────────────────────────────────────

app.get("/api/scrape", async (req, res) => {
  const source = ((req.query.source as string) ?? "all").toLowerCase().trim();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (type: string, data: unknown): void => {
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

    const toRun =
      source === "all"
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
        const log = (msg: string) => send("log", { source: name, message: msg });
        const results = await scraper(filters, { headless, log });
        log(`[${name}] ${results.length} veículo(s) coletado(s) bruto.`);
        totalRaw += results.length;

        const locationFiltered = applyLocationFilters(
          results,
          filters,
          log
        );
        const comboFiltered = applyComboRules(
          locationFiltered,
          filters.comboRules ?? [],
          log
        );
        log(`[${name}] ${comboFiltered.length}/${locationFiltered.length} veículo(s) após combos.`);
        totalFiltered += comboFiltered.length;

        const filteredUrlSet = new Set(
          comboFiltered
            .map((vehicle) => vehicle.url)
            .filter((url): url is string => Boolean(url && url.trim()))
        );

        const previewCandidates = dedupeVehiclesByUrl(results);
        if (previewCandidates.length < results.length) {
          log(
            `[${name}] ${previewCandidates.length}/${results.length} veículo(s) após deduplicação bruta para preview.`
          );
        }

        const urls = previewCandidates
          .map((v) => v.url)
          .filter((url): url is string => Boolean(url && url.trim()));
        const [hiddenByMongo, overridesByUrl] = await Promise.all([
          getHiddenAuctionVehicleUrlSet(dataMongoConfig, urls),
          getAuctionVehicleOverridesByUrls(dataMongoConfig, urls)
        ]);
        const hiddenUrlSet = new Set<string>([
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
          const mergedVehicle = applyAuctionVehicleOverride(
            vehicle,
            overridesByUrl.get(vehicle.url)
          );
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
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send("scraper-error", { source: name, message });
      }
    }

    send("done", { total, totalRaw, totalFiltered, totalHidden, totalPassingFilters });
  } catch (err) {
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
  const url = req.query.url as string;
  if (!url) { res.status(400).send("Missing url"); return; }

  let parsed: URL;
  try { parsed = new URL(url); } catch { res.status(400).send("Invalid url"); return; }

  if (!ALLOWED_IMAGE_HOSTS.includes(parsed.hostname)) {
    res.status(403).send("Host not allowed");
    return;
  }

  try {
    const referer =
      parsed.hostname === "srv1.favaretoleiloes.com.br" ||
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
    if (!upstream.ok) { res.status(upstream.status).send("Upstream error"); return; }

    const ct = upstream.headers.get("content-type") ?? "image/jpeg";
    res.setHeader("Content-Type", ct);
    res.setHeader("Cache-Control", "public, max-age=86400");
    const buf = await upstream.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) {
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
    } else {
      res.json({ ok: false, reason: result.reason });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, reason: message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

let didRetryWithAutoPort = false;

function startDevServer(port: number): void {
  const server = app.listen(port, DEV_HOST, (error?: Error) => {
    if (error) {
      const listenError = error as NodeJS.ErrnoException;
      const canRetryWithAutoPort =
        !didRetryWithAutoPort &&
        port !== 0 &&
        (listenError.code === "EACCES" || listenError.code === "EADDRINUSE");

      if (canRetryWithAutoPort) {
        didRetryWithAutoPort = true;
        console.warn(
          `[dev-ui] Porta ${DEV_HOST}:${port} indisponível (${listenError.code}). Tentando porta automática...`
        );
        startDevServer(0);
        return;
      }

      const hint =
        listenError.code === "EACCES"
          ? " Verifique portas reservadas no Windows com: netsh interface ipv4 show excludedportrange protocol=tcp"
          : "";
      console.error(`\n[dev-ui] Falha ao iniciar em ${DEV_HOST}:${port}: ${error.message}.${hint}\n`);
      process.exitCode = 1;
      return;
    }

    const address = server.address();
    const activePort =
      typeof address === "object" && address && "port" in address ? address.port : port;
    const url = `http://${getDevUiBrowserHost(DEV_HOST)}:${activePort}`;
    console.log(`\n🤖  Bot Anúncios — Dev UI`);
    console.log(`    ${url}\n`);

    const cmd =
      process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
          ? `open "${url}"`
          : `xdg-open "${url}"`;

    exec(cmd, (openError) => {
      if (openError) {
        console.warn(`[dev-ui] Não foi possível abrir o navegador automaticamente: ${openError.message}`);
      }
    });
  });
}

startDevServer(DEV_PORT);
