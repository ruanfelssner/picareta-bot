import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { URL } from "node:url";
import dotenv from "dotenv";
import cron from "node-cron";
import type { AuctionVehicle } from "./formatters/auction-card.js";
import {
  runAuctionSearch,
  type AuctionSourceProgressEvent
} from "./commands/auction-search.js";
import { getMongoDataConfigFromEnv } from "./integrations/mongo.js";
import { getZApiConfigFromEnv } from "./integrations/zapi.js";
import { runCopartConditionalStatusCheck } from "./scheduler/copart-conditional-status.js";

dotenv.config();

type CloudSource = AuctionSourceProgressEvent["source"];
type JobStatus = "queued" | "running" | "completed" | "failed";
type JobPhase = "queued" | "searching" | "saving" | "analyzing" | "finalizing" | "completed" | "failed";

type SourceState = {
  source: CloudSource;
  label: string;
  status: "queued" | "searching" | "saving" | "completed" | "failed";
  found: number;
  newCount: number;
  updatedCount: number;
  error?: string;
};

type CloudJob = {
  runId: string;
  status: JobStatus;
  phase: JobPhase;
  percent: number;
  message: string;
  sources: CloudSource[];
  sourceProgress: Record<string, SourceState>;
  totalFound: number;
  totalNew: number;
  totalUpdated: number;
  logs: string[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  callbackUrl: string;
};

const PORT = Number.parseInt(process.env.PORT ?? process.env.SCRAPER_PORT ?? "4000", 10) || 4000;
const HOST = (process.env.HOST ?? process.env.SCRAPER_HOST ?? "0.0.0.0").trim() || "0.0.0.0";
const SERVICE_KEY = (process.env.SCRAPER_SERVICE_KEY ?? "").trim();
function normalizeHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("A URL precisa usar http:// ou https://.");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeConfiguredUrl(value: string): string {
  try {
    return normalizeHttpUrl(value);
  } catch {
    return "";
  }
}

const PICARETA_INGEST_URL = normalizeConfiguredUrl(process.env.PICARETA_INGEST_URL ?? "");
const PICARETA_INGEST_KEY = (process.env.PICARETA_INGEST_KEY ?? "").trim();
const PICARETA_DAILY_SCRAPING_URL = PICARETA_INGEST_URL
  ? new URL("/api/v1/internal/scraping/daily", PICARETA_INGEST_URL).toString()
  : "";
const PICARETA_OPPORTUNITY_WEBHOOK_URL = normalizeConfiguredUrl(process.env.PICARETA_OPPORTUNITY_WEBHOOK_URL ?? "");
const MAX_BATCH_SIZE = 100;
const JOBS = new Map<string, CloudJob>();
let activeRunId: string | null = null;

const SOURCE_LABELS: Record<string, string> = {
  sodre: "Sodré Santoro",
  copart: "Copart",
  "vs-veiculos": "VS Veículos",
  favareto: "Favareto",
  "claudio-kuss": "Claudio Kuss",
  lucinei: "Lucinei Automóveis",
  vardana: "Vardana Leilões",
  megaleiloes: "Mega Leilões",
  superbid: "Superbid",
  leiloesjudiciais: "Leilões Judiciais",
  vipleiloes: "VIP Leilões",
  mgl: "MGL",
  "ph-batidos": "PH Batidos"
};

const DEFAULT_SOURCES: CloudSource[] = [
  "vs-veiculos",
  "sodre",
  "copart",
  "favareto",
  "claudio-kuss",
  "lucinei",
  "vardana",
  "megaleiloes",
  "superbid",
  "leiloesjudiciais",
  "vipleiloes",
  "mgl",
  "ph-batidos",
];

async function triggerDailyPicaretaScraping(): Promise<void> {
  if (!PICARETA_DAILY_SCRAPING_URL || !PICARETA_INGEST_KEY) {
    console.error("[scraper-schedule] PICARETA_INGEST_URL/PICARETA_INGEST_KEY não configurados; coleta diária ignorada.");
    return;
  }
  try {
    const response = await fetch(PICARETA_DAILY_SCRAPING_URL, {
      method: "POST",
      headers: { "x-picareta-ingest-key": PICARETA_INGEST_KEY },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Picareta respondeu HTTP ${response.status}: ${body.slice(0, 240)}`);
    console.log(`[scraper-schedule] Coleta diária acionada: ${body.slice(0, 240)}`);
  } catch (error) {
    console.error(`[scraper-schedule] Falha ao acionar coleta diária: ${error instanceof Error ? error.message : String(error)}`);
  }
}

cron.schedule("0 12 * * *", () => {
  void triggerDailyPicaretaScraping();
}, { timezone: "America/Sao_Paulo" });
console.log('[scraper-schedule] Cron diário configurado para 12:00 (America/Sao_Paulo).');

let conditionalCheckRunning = false;

async function triggerCopartConditionalCheck(): Promise<void> {
  if (conditionalCheckRunning) {
    console.warn("[conditional-check] Execução anterior ainda está em andamento; nova execução ignorada.");
    return;
  }

  const dataMongoConfig = getMongoDataConfigFromEnv();
  if (!dataMongoConfig.enabled) {
    console.error("[conditional-check] Mongo de dados não configurado; consulta de condicionais ignorada.");
    return;
  }

  conditionalCheckRunning = true;
  try {
    await runCopartConditionalStatusCheck({
      dataMongoConfig,
      headless: true,
      log: (message) => console.log(message),
    });
  } catch (error) {
    console.error(`[conditional-check] Falha geral: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    conditionalCheckRunning = false;
  }
}

cron.schedule("0 9 * * 1,4", () => {
  void triggerCopartConditionalCheck();
}, { timezone: "America/Sao_Paulo" });
console.log("[scraper-schedule] Cron de condicionais configurado para segunda e quinta às 09:00 (America/Sao_Paulo).");

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function authorized(req: IncomingMessage): boolean {
  if (!SERVICE_KEY) return false;
  return (req.headers["x-scraper-service-key"] ?? "") === SERVICE_KEY;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
}

function asSourceList(value: unknown): CloudSource[] {
  if (!Array.isArray(value)) return DEFAULT_SOURCES;
  const allowed = new Set(Object.keys(SOURCE_LABELS));
  const selected = value
    .map((item) => String(item).trim().toLowerCase())
    .filter((item): item is CloudSource => allowed.has(item));
  return [...new Set(selected)] as CloudSource[];
}

function addLog(job: CloudJob, message: string): void {
  job.logs.push(message);
  if (job.logs.length > 100) job.logs.splice(0, job.logs.length - 100);
}

function createJob(runId: string, sources: CloudSource[], callbackUrl: string): CloudJob {
  const sourceProgress = Object.fromEntries(
    sources.map((source) => [source, {
      source,
      label: SOURCE_LABELS[source] ?? source,
      status: "queued",
      found: 0,
      newCount: 0,
      updatedCount: 0
    } satisfies SourceState])
  );

  return {
    runId,
    status: "queued",
    phase: "queued",
    percent: 0,
    message: "Scraping aguardando início.",
    sources,
    sourceProgress,
    totalFound: 0,
    totalNew: 0,
    totalUpdated: 0,
    logs: [],
    startedAt: null,
    finishedAt: null,
    error: null,
    callbackUrl
  };
}

async function notifyPicareta(job: CloudJob): Promise<void> {
  if (!job.callbackUrl) return;
  if (!PICARETA_INGEST_KEY) {
    console.error("[scraper-cloud] PICARETA_INGEST_KEY não configurada; progresso não será enviado ao Picareta.");
    return;
  }
  try {
    const response = await fetch(job.callbackUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-picareta-ingest-key": PICARETA_INGEST_KEY
      },
      body: JSON.stringify({
        runId: job.runId,
        status: job.status,
        phase: job.phase,
        percent: job.percent,
        message: job.message,
        sourceProgress: job.sourceProgress,
        totalFound: job.totalFound,
        totalNew: job.totalNew,
        totalUpdated: job.totalUpdated,
        logs: job.logs.slice(-30),
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        error: job.error
      }),
      signal: AbortSignal.timeout(10_000)
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 240);
      throw new Error(`callback HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
  } catch (error) {
    const message = `[picareta] Falha ao atualizar progresso: ${error instanceof Error ? error.message : String(error)}`;
    addLog(job, message);
    console.error(`[scraper-cloud] ${message}`);
  }
}

function updateJob(job: CloudJob, update: Partial<Pick<CloudJob, "status" | "phase" | "percent" | "message" | "error">>): void {
  Object.assign(job, update);
  void notifyPicareta(job);
}

function externalId(vehicle: AuctionVehicle): string {
  const identity = [vehicle.source, vehicle.url, vehicle.lot, vehicle.brand, vehicle.model, vehicle.year]
    .filter((value) => value != null && String(value).trim())
    .join("|");
  return `bot-${createHash("sha256").update(identity).digest("hex")}`;
}

function toIngestRecord(vehicle: AuctionVehicle): Record<string, unknown> {
  return {
    externalId: externalId(vehicle),
    source: vehicle.source,
    brand: vehicle.brand || null,
    model: vehicle.model || null,
    title: [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(" ") || null,
    description: vehicle.description || null,
    year: vehicle.year ?? null,
    km: vehicle.km ? Number(String(vehicle.km).replace(/\D/g, "")) || null : null,
    price: vehicle.price ?? null,
    priceRaw: vehicle.priceRaw ?? null,
    damage: vehicle.damage ?? null,
    condition: vehicle.condition ?? null,
    lot: vehicle.lot ?? null,
    auctionDate: vehicle.auctionDate ?? null,
    auctionStatus: vehicle.source === "vs-veiculos" ? "upcoming" : "unknown",
    city: vehicle.city ?? null,
    state: vehicle.state ?? null,
    fipe: vehicle.fipe ?? null,
    fipeRaw: vehicle.fipeRaw ?? null,
    fipeCode: vehicle.fipeCode ?? null,
    fipeReferenceMonth: vehicle.fipeReferenceMonth ?? null,
    fipeFuel: vehicle.fipeFuel ?? null,
    fipeBrandMatched: vehicle.fipeBrandMatched ?? null,
    fipeModelMatched: vehicle.fipeModelMatched ?? null,
    fipeCheckedAt: vehicle.fipeCheckedAt ?? null,
    status: "scraped",
    yard: vehicle.yard ?? null,
    consignor: vehicle.consignor ?? null,
    imageUrls: vehicle.imageUrls ?? [],
    url: vehicle.url ?? null,
    scrapedAt: new Date().toISOString()
  };
}

async function ingestVehicles(vehicles: AuctionVehicle[], snapshotSource: string): Promise<{ newCount: number; updatedCount: number; vehicleIds: string[] }> {
  if (!PICARETA_INGEST_URL) throw new Error("PICARETA_INGEST_URL não configurada no serviço cloud.");
  let newCount = 0;
  let updatedCount = 0;
  const vehicleIds: string[] = [];

  for (let index = 0; index < vehicles.length; index += MAX_BATCH_SIZE) {
    const batch = vehicles.slice(index, index + MAX_BATCH_SIZE).map(toIngestRecord);
    const response = await fetch(PICARETA_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-picareta-ingest-key": PICARETA_INGEST_KEY
      },
      body: JSON.stringify({
        vehicles: batch,
        snapshotSource,
        snapshotComplete: index + MAX_BATCH_SIZE >= vehicles.length,
        ...(index + MAX_BATCH_SIZE >= vehicles.length
          ? { snapshotExternalIds: vehicles.map(externalId) }
          : {}),
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`Picareta ingestão HTTP ${response.status}: ${(await response.text()).slice(0, 240)}`);
    const result = await response.json() as { upserted?: number; matched?: number; modified?: number; vehicleIds?: string[] };
    newCount += Number(result.upserted ?? 0);
    updatedCount += Number(result.modified ?? result.matched ?? 0);
    vehicleIds.push(...(result.vehicleIds ?? []));
  }

  return { newCount, updatedCount, vehicleIds: [...new Set(vehicleIds)] };
}

async function notifyOpportunityMatches(runId: string, vehicleIds: string[]): Promise<void> {
  if (!PICARETA_OPPORTUNITY_WEBHOOK_URL || !vehicleIds.length) return;
  const response = await fetch(PICARETA_OPPORTUNITY_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-picareta-ingest-key": PICARETA_INGEST_KEY
    },
    body: JSON.stringify({ runId, vehicleIds }),
    signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(`Análise de oportunidades HTTP ${response.status}`);
}

async function executeJob(job: CloudJob): Promise<void> {
  activeRunId = job.runId;
  job.startedAt = new Date().toISOString();
  updateJob(job, {
    status: "running",
    phase: "searching",
    percent: 5,
    message: `Buscando ${job.sources.length} leiloeiro(s)...`
  });
  addLog(job, `Iniciando: ${job.sources.map((source) => SOURCE_LABELS[source] ?? source).join(", ")}.`);

  try {
    const result = await runAuctionSearch({
      groupPhone: "__cloud__",
      dataMongoConfig: getMongoDataConfigFromEnv(),
      zApiConfig: { ...getZApiConfigFromEnv(), enabled: false },
      headless: true,
      sources: job.sources,
      onSourceProgress: (event) => {
        const source = job.sourceProgress[event.source];
        if (!source) return;
        source.status = event.status === "running" ? "searching" : event.status === "success" ? "completed" : "failed";
        source.found = event.found;
        source.error = event.error;
        job.totalFound = Object.values(job.sourceProgress).reduce((sum, item) => sum + item.found, 0);
        const completed = Object.values(job.sourceProgress).filter((item) => item.status === "completed" || item.status === "failed").length;
        job.percent = Math.min(68, 8 + Math.round((completed / job.sources.length) * 60));
        job.message = event.status === "running"
          ? `Buscando ${event.label}...`
          : event.status === "success"
            ? `${event.label}: ${event.found} encontrado(s).`
            : `${event.label}: falha na coleta.`;
        addLog(job, job.message);
        void notifyPicareta(job);
      },
      log: (message) => addLog(job, message)
    });

    updateJob(job, {
      phase: "saving",
      percent: 70,
      message: "Salvando veículos encontrados..."
    });

    const vehicleIds: string[] = [];
    for (const sourceName of job.sources) {
      const source = job.sourceProgress[sourceName];
      if (!source) continue;
      if (source.status === "failed") {
        addLog(job, `${source.label}: salvamento ignorado porque a coleta falhou.`);
        continue;
      }
      source.status = "saving";
      const vehicles = result.vehicles.filter((vehicle) => vehicle.source === sourceName);
      const saved = await ingestVehicles(vehicles, sourceName);
      source.newCount = saved.newCount;
      source.updatedCount = saved.updatedCount;
      source.status = "completed";
      vehicleIds.push(...saved.vehicleIds);
      job.totalNew += saved.newCount;
      job.totalUpdated += saved.updatedCount;
      job.percent = Math.min(90, 70 + Math.round((Object.values(job.sourceProgress).filter((item) => item.status === "completed").length / job.sources.length) * 20));
      job.message = `${source.label}: ${saved.newCount} novo(s), ${saved.updatedCount} atualizado(s).`;
      addLog(job, job.message);
      await notifyPicareta(job);
    }

    updateJob(job, { phase: "analyzing", percent: 93, message: "Analisando oportunidades..." });
    await notifyOpportunityMatches(job.runId, vehicleIds);
    updateJob(job, { phase: "finalizing", percent: 98, message: "Finalizando execução..." });
    job.finishedAt = new Date().toISOString();
    updateJob(job, {
      status: "completed",
      phase: "completed",
      percent: 100,
      message: `Scraping finalizado: ${job.totalNew} novo(s) encontrado(s).`
    });
  } catch (error) {
    job.finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    addLog(job, `Erro: ${message}`);
    updateJob(job, { status: "failed", phase: "failed", percent: Math.min(job.percent, 99), message: "Scraping finalizado com erro.", error: message });
  } finally {
    if (activeRunId === job.runId) activeRunId = null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (requestUrl.pathname === "/health") {
    json(res, 200, { ok: true, service: "bot-anuncios-scraper", activeRunId, host: hostname() });
    return;
  }

  if (!authorized(req)) {
    json(res, 401, { ok: false, message: "Chave do serviço inválida." });
    return;
  }

  if (requestUrl.pathname === "/internal/scraping/runs" && req.method === "POST") {
    const body = await readJson(req);
    const runId = String(body.runId ?? randomUUID()).trim();
    let callbackUrl = "";
    try {
      callbackUrl = normalizeHttpUrl(String(body.callbackUrl ?? ""));
    } catch {
      json(res, 400, { ok: false, message: "callbackUrl precisa ser uma URL absoluta com http:// ou https://." });
      return;
    }
    const sources = asSourceList(body.sources);
    if (!callbackUrl || sources.length === 0) {
      json(res, 400, { ok: false, message: "runId, callbackUrl e sources são obrigatórios." });
      return;
    }
    if (activeRunId) {
      json(res, 409, { ok: false, message: "Já existe um scraping em execução.", runId: activeRunId });
      return;
    }
    const job = createJob(runId, sources, callbackUrl);
    JOBS.set(runId, job);
    void notifyPicareta(job);
    setImmediate(() => void executeJob(job));
    json(res, 202, { ok: true, runId, status: job.status });
    return;
  }

  const match = requestUrl.pathname.match(/^\/internal\/scraping\/runs\/([^/]+)$/);
  if (match && req.method === "GET") {
    const job = JOBS.get(decodeURIComponent(match[1] ?? ""));
    if (!job) {
      json(res, 404, { ok: false, message: "Execução não encontrada." });
      return;
    }
    json(res, 200, { ok: true, job });
    return;
  }

  json(res, 404, { ok: false, message: "Rota não encontrada." });
}

createServer((req, res) => {
  void handle(req, res).catch((error) => {
    json(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
  });
}).listen(PORT, HOST, () => {
  console.log(`[scraper-cloud] ouvindo em http://${HOST}:${PORT}`);
});
