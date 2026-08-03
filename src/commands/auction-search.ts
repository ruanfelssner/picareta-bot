import type { AuctionVehicle } from "../formatters/auction-card.js";
import { formatAuctionCardCaption, formatAuctionSummary } from "../formatters/auction-card.js";
import type { MongoConfig } from "../integrations/mongo.js";
import {
  getAuctionFilters,
  getHiddenAuctionVehicleUrlSet,
  hideAuctionVehicles,
  markAuctionResultsSent,
  saveAuctionResults
} from "../integrations/mongo.js";
import { filterAuctionVehiclesByGeo } from "../location-filter.js";
import type { ZApiConfig } from "../integrations/zapi.js";
import { sendTextMessageToZApi } from "../integrations/zapi.js";
import { scrapeFavareto } from "../scrapers/favareto.js";
import { scrapeLeiloesJudiciais } from "../scrapers/leiloesjudiciais.js";
import { scrapeMegaleiloes } from "../scrapers/megaleiloes.js";
import { scrapeSodre } from "../scrapers/sodre.js";
import { scrapeSuperbid } from "../scrapers/superbid.js";
import { scrapeVsVeiculos } from "../scrapers/vs-veiculos.js";
import { scrapeCopart } from "../scrapers/copart.js";
import { scrapeClaudioKuss } from "../scrapers/claudio-kuss.js";
import { scrapeVipLeiloes } from "../scrapers/vipleiloes.js";
import { scrapeLucinei } from "../scrapers/lucinei.js";
import { scrapeVardana } from "../scrapers/vardana.js";

const DELAY_BETWEEN_MESSAGES_MS = 2500;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const ERROR_MESSAGE_MAX = 220;

type ScraperSource = AuctionVehicle["source"];

type ScraperPolicy = {
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
};

type ScraperDefinition = {
  source: ScraperSource;
  label: string;
  execute: (
    filters: Awaited<ReturnType<typeof getAuctionFilters>>,
    options: { headless: boolean; log: (message: string) => void }
  ) => Promise<AuctionVehicle[]>;
  policy: ScraperPolicy;
};

type ScraperOutcome =
  | {
      ok: true;
      source: ScraperSource;
      label: string;
      attempts: number;
      durationMs: number;
      vehicles: AuctionVehicle[];
    }
  | {
      ok: false;
      source: ScraperSource;
      label: string;
      attempts: number;
      durationMs: number;
      error: string;
      vehicles: AuctionVehicle[];
    };

const SCRAPER_DEFINITIONS: ScraperDefinition[] = [
  {
    source: "vs-veiculos",
    label: "VS Veículos",
    execute: scrapeVsVeiculos,
    policy: {
      timeoutMs: 120_000,
      maxAttempts: 2,
      retryDelayMs: 2_000
    }
  },
  {
    source: "sodre",
    label: "Sodré Santoro",
    execute: scrapeSodre,
    policy: {
      timeoutMs: 120_000,
      maxAttempts: 3,
      retryDelayMs: 3_000
    }
  },
  {
    source: "copart",
    label: "Copart",
    execute: scrapeCopart,
    policy: {
      timeoutMs: 150_000,
      maxAttempts: 3,
      retryDelayMs: 4_000
    }
  },
  {
    source: "favareto",
    label: "Favareto",
    execute: scrapeFavareto,
    policy: {
      timeoutMs: 120_000,
      maxAttempts: 2,
      retryDelayMs: 2_000
    }
  },
  {
    source: "claudio-kuss",
    label: "Claudio Kuss",
    execute: scrapeClaudioKuss,
    policy: {
      timeoutMs: 120_000,
      maxAttempts: 2,
      retryDelayMs: 2_000
    }
  },
  {
    source: "lucinei",
    label: "Lucinei Automóveis",
    execute: scrapeLucinei,
    policy: {
      timeoutMs: 120_000,
      maxAttempts: 2,
      retryDelayMs: 2_000
    }
  },
  {
    source: "vardana",
    label: "Vardana Leilões",
    execute: scrapeVardana,
    policy: {
      timeoutMs: 120_000,
      maxAttempts: 2,
      retryDelayMs: 2_000
    }
  },
  {
    source: "megaleiloes",
    label: "Mega Leilões",
    execute: scrapeMegaleiloes,
    policy: {
      timeoutMs: 140_000,
      maxAttempts: 2,
      retryDelayMs: 2_000
    }
  },
  {
    source: "superbid",
    label: "Superbid",
    execute: scrapeSuperbid,
    policy: {
      timeoutMs: 180_000,
      maxAttempts: 2,
      retryDelayMs: 3_000
    }
  },
  {
    source: "leiloesjudiciais",
    label: "Leilões Judiciais",
    execute: scrapeLeiloesJudiciais,
    policy: {
      timeoutMs: 180_000,
      maxAttempts: 2,
      retryDelayMs: 3_000
    }
  },
  {
    source: "vipleiloes",
    label: "VIP Leilões",
    execute: scrapeVipLeiloes,
    policy: {
      timeoutMs: 180_000,
      maxAttempts: 2,
      retryDelayMs: 3_000
    }
  }
];

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseApiResponse(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function truncateText(value: string, max = 220): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max)}...`;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return truncateText(error.message, ERROR_MESSAGE_MAX);
  }
  return truncateText(String(error), ERROR_MESSAGE_MAX);
}

function withTimeout<T>(promise: Promise<T>, ms: number, source: ScraperSource): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`[${source}] timeout após ${Math.round(ms / 1000)}s`)), ms)
    )
  ]);
}

async function runScraperWithRetry(
  definition: ScraperDefinition,
  input: {
    filters: Awaited<ReturnType<typeof getAuctionFilters>>;
    headless: boolean;
    log: (message: string) => void;
  }
): Promise<ScraperOutcome> {
  const { source, label, execute, policy } = definition;
  const startedAt = Date.now();
  let lastError = "falha desconhecida";

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    input.log(`[auction][${source}] Tentativa ${attempt}/${policy.maxAttempts} iniciada.`);

    try {
      const vehicles = await withTimeout(
        execute(input.filters, { headless: input.headless, log: input.log }),
        policy.timeoutMs,
        source
      );

      input.log(
        `[auction][${source}] Sucesso na tentativa ${attempt}/${policy.maxAttempts} (${vehicles.length} veículo(s), ${Math.round(
          (Date.now() - attemptStartedAt) / 1000
        )}s).`
      );

      return {
        ok: true,
        source,
        label,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        vehicles
      };
    } catch (error) {
      lastError = normalizeErrorMessage(error);
      input.log(`[auction][${source}] Falha tentativa ${attempt}/${policy.maxAttempts}: ${lastError}`);

      if (attempt < policy.maxAttempts) {
        await sleep(policy.retryDelayMs);
      }
    }
  }

  return {
    ok: false,
    source,
    label,
    attempts: policy.maxAttempts,
    durationMs: Date.now() - startedAt,
    error: lastError,
    vehicles: []
  };
}

export type AuctionSourceProgressEvent = {
  source: ScraperSource;
  label: string;
  status: "running" | "success" | "error";
  found: number;
  error?: string;
};

async function fetchImageAsDataUrl(imageUrl: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const parsed = new URL(imageUrl);
    const response = await fetch(imageUrl, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Referer: `${parsed.origin}/`
      }
    });

    if (!response.ok) {
      return null;
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
      return null;
    }

    return `data:${contentType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function postImageToZApi(
  zApiConfig: ZApiConfig,
  groupPhone: string,
  image: string
): Promise<{ ok: boolean; status: number; response: unknown }> {
  const endpoint = `${zApiConfig.baseUrl}/instances/${encodeURIComponent(zApiConfig.instanceId)}/token/${encodeURIComponent(zApiConfig.token)}/send-image`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Client-Token": zApiConfig.clientToken,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      phone: groupPhone,
      image,
      caption: "",
      delayMessage: 1,
      viewOnce: false
    })
  });

  const raw = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    response: parseApiResponse(raw)
  };
}

function deduplicateByUrl(vehicles: AuctionVehicle[]): AuctionVehicle[] {
  const seen = new Set<string>();
  return vehicles.filter((v) => {
    if (seen.has(v.url)) return false;
    seen.add(v.url);
    return true;
  });
}

async function sendVehicleToGroup(
  vehicle: AuctionVehicle,
  groupPhone: string,
  zApiConfig: ZApiConfig,
  log: (msg: string) => void
): Promise<void> {
  const caption = formatAuctionCardCaption(vehicle);

  // Envia fotos primeiro (uma por vez)
  if (vehicle.imageUrls.length > 0) {
    for (const imageUrl of vehicle.imageUrls.slice(0, 3)) {
      if (!imageUrl) continue;

      try {
        const dataUrl = await fetchImageAsDataUrl(imageUrl);

        if (dataUrl) {
          const base64Attempt = await postImageToZApi(zApiConfig, groupPhone, dataUrl);
          if (base64Attempt.ok) {
            await sleep(1000);
            continue;
          }

          log(
            `[auction] Falha imagem/base64: HTTP ${base64Attempt.status} (${truncateText(String(base64Attempt.response ?? ""))}). Tentando URL direta...`
          );
        }

        const urlAttempt = await postImageToZApi(zApiConfig, groupPhone, imageUrl);
        if (!urlAttempt.ok) {
          log(
            `[auction] Falha imagem/url: HTTP ${urlAttempt.status} (${truncateText(String(urlAttempt.response ?? ""))})`
          );
        }

        await sleep(1000);
      } catch (error) {
        log(`[auction] Erro ao enviar imagem: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // Envia descrição
  await sendTextMessageToZApi(zApiConfig, { message: caption, phone: groupPhone });
  await sleep(DELAY_BETWEEN_MESSAGES_MS);
}

export async function runAuctionSearch(
  options: {
    groupPhone: string;
    dataMongoConfig: MongoConfig;
    zApiConfig: ZApiConfig;
    headless?: boolean;
    sources?: ScraperSource[];
    onSourceProgress?: (event: AuctionSourceProgressEvent) => void;
    log?: (msg: string) => void;
  }
): Promise<{
  total: number;
  bySource: Record<string, number>;
  sourceCounts: Record<string, number>;
  vehicles: AuctionVehicle[];
  sourceFailures: Array<{
    source: ScraperSource;
    label: string;
    attempts: number;
    reason: string;
  }>;
}> {
  const log = options.log ?? console.log;
  const { groupPhone, dataMongoConfig, zApiConfig } = options;
  const headless = options.headless ?? true;
  const selectedSources = new Set(options.sources ?? SCRAPER_DEFINITIONS.map((item) => item.source));
  const definitions = SCRAPER_DEFINITIONS.filter((definition) => selectedSources.has(definition.source));

  if (definitions.length === 0) {
    throw new Error("Nenhuma fonte de leilão válida foi selecionada.");
  }

  // Carrega filtros configurados
  const filters = await getAuctionFilters(dataMongoConfig);
  log(
    `[auction] Filtros: combos=${filters.comboRules.length}` +
    ` | locais=${filters.locations.join(", ") || "padrão"}` +
    ` | estados=${filters.states.join(", ") || "-"}` +
    ` | cidades=${filters.cities.join(", ") || "-"}`
  );

  // Notifica início
  if (zApiConfig.enabled) {
    const sourceList = definitions.map((item) => item.label).join(", ");
    await sendTextMessageToZApi(zApiConfig, {
      phone: groupPhone,
      message: `🔍 *Busca nos leilões iniciada...*\nFontes: ${sourceList}`
    });
  }

  // Roda scrapers em paralelo com retry específico por fonte
  const outcomes = await Promise.all(
    definitions.map(async (definition) => {
      options.onSourceProgress?.({
        source: definition.source,
        label: definition.label,
        status: "running",
        found: 0
      });

      const outcome = await runScraperWithRetry(definition, {
        filters,
        headless,
        log
      });

      options.onSourceProgress?.({
        source: definition.source,
        label: definition.label,
        status: outcome.ok ? "success" : "error",
        found: outcome.vehicles.length,
        ...(outcome.ok ? {} : { error: outcome.error })
      });

      return outcome;
    })
  );
  const allVehicles: AuctionVehicle[] = [];
  const sourceFailures: Array<{
    source: ScraperSource;
    label: string;
    attempts: number;
    reason: string;
  }> = [];

  for (const outcome of outcomes) {
    if (outcome.ok) {
      allVehicles.push(...outcome.vehicles);
      continue;
    }

    sourceFailures.push({
      source: outcome.source,
      label: outcome.label,
      attempts: outcome.attempts,
      reason: outcome.error
    });
    log(`[auction][${outcome.source}] Falha final após ${outcome.attempts} tentativa(s): ${outcome.error}`);
  }

  const deduped = deduplicateByUrl(allVehicles);
  const unique = deduped;
  log(`[auction] Total único (após negativados): ${unique.length} veículo(s).`);
  const geoFilteredResult = filterAuctionVehiclesByGeo(unique, {
    states: filters.states,
    cities: filters.cities
  });
  const geoFiltered = geoFilteredResult.vehicles;
  if (geoFilteredResult.activeStates.length > 0 || geoFilteredResult.activeCities.length > 0) {
    log(
      `[auction] Localização: ${geoFiltered.length}/${unique.length} veículo(s)` +
      ` (estados=${geoFilteredResult.activeStates.join(", ") || "-"};` +
      ` cidades=${geoFilteredResult.activeCities.join(", ") || "-"})`
    );
  }

  const hiddenUrlSet = await getHiddenAuctionVehicleUrlSet(
    dataMongoConfig,
    geoFiltered.map((vehicle) => vehicle.url)
  );
  const readyToSend = geoFiltered.filter((vehicle) => !hiddenUrlSet.has(vehicle.url));
  const hiddenOrAlreadySentCount = geoFiltered.length - readyToSend.length;
  if (hiddenOrAlreadySentCount > 0) {
    log(`[auction] ${hiddenOrAlreadySentCount} veículo(s) ignorado(s): já enviado(s) ou arquivado(s).`);
  }

  // Salva no MongoDB
  await saveAuctionResults(
    dataMongoConfig,
    geoFiltered.map((v) => ({
      source: v.source,
      brand: v.brand,
      model: v.model,
      year: v.year,
      damage: v.damage,
      price: v.price,
      priceRaw: v.priceRaw,
      imageUrls: v.imageUrls,
      description: v.description,
      url: v.url,
      auctionDate: v.auctionDate,
      km: v.km ?? null,
      color: v.color ?? null,
      scrapedAt: new Date()
    }))
  );

  // Envia para o grupo
  if (zApiConfig.enabled && readyToSend.length > 0) {
    const sentUrls: string[] = [];
    const sentVehicles: AuctionVehicle[] = [];

    for (const vehicle of readyToSend) {
      try {
        await sendVehicleToGroup(vehicle, groupPhone, zApiConfig, log);
        sentUrls.push(vehicle.url);
        sentVehicles.push(vehicle);
      } catch (error) {
        log(`[auction] Erro ao enviar veículo: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    await markAuctionResultsSent(dataMongoConfig, sentUrls);
    await hideAuctionVehicles(
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
    );
  }

  // Resumo final
  const bySource = readyToSend.reduce<Record<string, number>>((acc, v) => {
    acc[v.source] = (acc[v.source] ?? 0) + 1;
    return acc;
  }, {});

  const sourceCounts = geoFiltered.reduce<Record<string, number>>((acc, vehicle) => {
    acc[vehicle.source] = (acc[vehicle.source] ?? 0) + 1;
    return acc;
  }, {});

  const summary =
    readyToSend.length > 0
      ? formatAuctionSummary(readyToSend)
      : hiddenOrAlreadySentCount > 0
        ? "✅ Nenhum veículo novo para envio. Todos os resultados desta rodada já haviam sido enviados/arquivados."
        : formatAuctionSummary(readyToSend);
  if (zApiConfig.enabled) {
    await sendTextMessageToZApi(zApiConfig, { phone: groupPhone, message: summary });

    if (sourceFailures.length > 0) {
      const failureLines = sourceFailures
        .map((item) => `• ${item.label}: ${truncateText(item.reason, 110)}`)
        .join("\n");

      await sendTextMessageToZApi(zApiConfig, {
        phone: groupPhone,
        message: `⚠️ Algumas fontes falharam nesta busca:\n${failureLines}`
      });
    }
  }

  log(`[auction] Busca finalizada. ${readyToSend.length} veículo(s) elegível(is) para envio.`);
  return {
    total: readyToSend.length,
    bySource,
    sourceCounts,
    vehicles: geoFiltered,
    sourceFailures
  };
}
