import { randomUUID } from "node:crypto";
import { orderedCloudProgress } from "../layers/scrapers/server/utils/cloud-progress.js";
import { externalId, toIngestRecord } from "../layers/scrapers/server/utils/cloud-ingest.js";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname } from "node:os";
import { URL } from "node:url";
import dotenv from "dotenv";
import { isAuctionSourceDisabled } from "../shared/constants/sources.js";
import cron from "node-cron";
import type { AuctionVehicle } from "./formatters/auction-card.js";
import {
  runAuctionSearch,
  type AuctionSourceProgressEvent
} from "./commands/auction-search.js";
import {
  clearActiveCopartConditionalQueue,
  countPendingCopartConditionals,
  getMongoDataConfigFromEnv,
  getRunningCopartConditionalRun,
  listActiveCopartConditionalQueue,
} from "./integrations/mongo.js";
import { getZApiConfigFromEnv } from "./integrations/zapi.js";
import { enqueueCopartConditionalStatusCheck } from "./scheduler/copart-conditional-queue.js";

dotenv.config();

// Exposto no /health para confirmar qual build está no ar após o deploy.
const SERVICE_VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "desconhecida");
  } catch {
    return "desconhecida";
  }
})();

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
  persisted?: boolean;
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
const PICARETA_OPPORTUNITY_WEBHOOK_URL = normalizeConfiguredUrl(process.env.PICARETA_OPPORTUNITY_WEBHOOK_URL ?? "")
  || (PICARETA_INGEST_URL ? new URL("/api/v1/push/opportunity-matches", PICARETA_INGEST_URL).toString() : "");
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
  "ph-batidos": "PH Batidos",
  pestana: "Pestana Leilões",
  pampasul: "Pampa Sul Leilões",
  palacio: "Palácio dos Leilões",
  leilo: "Leilo Sul e Sudeste",
  freitas: "Freitas Leiloeiro"
};

const DEFAULT_SOURCES: CloudSource[] = ([
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
  "pestana",
  "pampasul",
  "freitas",
  "palacio",
  "leilo",
] satisfies CloudSource[]).filter(source => !isAuctionSourceDisabled(source));

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

type ConditionalCheckTriggerOptions = {
  trigger: "schedule" | "manual";
  force?: boolean;
  vehicleId?: string;
  vehicleIds?: string[];
  runId?: string;
};

async function triggerCopartConditionalCheck(options: ConditionalCheckTriggerOptions): Promise<Awaited<ReturnType<typeof enqueueCopartConditionalStatusCheck>> | null> {
  const dataMongoConfig = getMongoDataConfigFromEnv();
  if (!dataMongoConfig.enabled) {
    console.error("[conditional-check] Mongo de dados não configurado; consulta de condicionais ignorada.");
    return null;
  }

  try {
    const result = await enqueueCopartConditionalStatusCheck({
      dataMongoConfig,
      trigger: options.trigger,
      force: options.force,
      vehicleId: options.vehicleId,
      vehicleIds: options.vehicleIds,
      runId: options.runId,
    });
    console.log(`[conditional-check] ${result.queued} lote(s) enfileirado(s) para a extensão.`);
    return result;
  } catch (error) {
    console.error(`[conditional-check] Falha geral: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  } finally {
    conditionalCheckRunning = false;
  }
}

cron.schedule("0 9 * * 1,4", () => {
  if (conditionalCheckRunning) {
    console.warn("[conditional-check] Execução anterior ainda está em andamento; agendamento ignorado.");
    return;
  }
  conditionalCheckRunning = true;
  void triggerCopartConditionalCheck({ trigger: "schedule", runId: randomUUID() }).finally(() => {
    conditionalCheckRunning = false;
  });
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
  const allowed = new Set(Object.keys(SOURCE_LABELS).filter(source => !isAuctionSourceDisabled(source)));
  const selected = value
    .map((item) => String(item).trim().toLowerCase())
    .filter((item): item is CloudSource => allowed.has(item));
  return [...new Set(selected)] as CloudSource[];
}

const LOG_MESSAGE_MAX = 500;

function addLog(job: CloudJob, message: string): void {
  const normalized = message.length > LOG_MESSAGE_MAX ? `${message.slice(0, LOG_MESSAGE_MAX - 3)}...` : message;
  job.logs.push(normalized);
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
      updatedCount: 0,
      persisted: false
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

const progressCallbacks = new WeakMap<CloudJob, ReturnType<typeof orderedCloudProgress<Record<string, unknown>>>>();

function notifyPicareta(job: CloudJob): Promise<void> {
  if (!job.callbackUrl) return Promise.resolve();
  if (!PICARETA_INGEST_KEY) {
    console.error("[scraper-cloud] PICARETA_INGEST_KEY não configurada; progresso não será enviado ao Picareta.");
    return Promise.resolve();
  }
  let notify = progressCallbacks.get(job);
  if (!notify) {
    notify = orderedCloudProgress(async snapshot => {
      const response = await fetch(job.callbackUrl, {
        method: "POST",
        headers: { "content-type": "application/json", "x-picareta-ingest-key": PICARETA_INGEST_KEY },
        body: JSON.stringify(snapshot), signal: AbortSignal.timeout(60_000)
      });
      if (!response.ok) throw new Error(`callback HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
      const result = await response.json() as { whatsapp?: { eligible: number; queued: number } | null };
      if (result.whatsapp) addLog(job, `[whatsapp] ${result.whatsapp.eligible} elegível(is), ${result.whatsapp.queued} novo(s) na fila.`);
    }, error => {
      const message = `[picareta] Falha ao atualizar progresso após 3 tentativas: ${error instanceof Error ? error.message : String(error)}`;
      addLog(job, message);
      console.error(`[scraper-cloud] ${message}`);
    });
    progressCallbacks.set(job, notify);
  }
  return notify({
    runId: job.runId, status: job.status, phase: job.phase, percent: job.percent, message: job.message,
    sourceProgress: job.sourceProgress, totalFound: job.totalFound, totalNew: job.totalNew,
    totalUpdated: job.totalUpdated, logs: job.logs.slice(-30), startedAt: job.startedAt,
    finishedAt: job.finishedAt, error: job.error
  });
}

function updateJob(job: CloudJob, update: Partial<Pick<CloudJob, "status" | "phase" | "percent" | "message" | "error">>): void {
  Object.assign(job, update);
  void notifyPicareta(job);
}

async function ingestVehicles(vehicles: AuctionVehicle[], snapshotSource: string, complete = true): Promise<{ newCount: number; updatedCount: number; vehicleIds: string[] }> {
  if (!PICARETA_INGEST_URL) throw new Error("PICARETA_INGEST_URL não configurada no serviço cloud.");
  let newCount = 0;
  let updatedCount = 0;
  const vehicleIds: string[] = [];

  for (let index = 0; index < vehicles.length; index += MAX_BATCH_SIZE) {
    const batch = vehicles.slice(index, index + MAX_BATCH_SIZE).map(toIngestRecord);
    // Coleta parcial nunca fecha o snapshot: anúncios não visitados não podem ser removidos.
    const last = complete && index + MAX_BATCH_SIZE >= vehicles.length;
    const response = await fetch(PICARETA_INGEST_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-picareta-ingest-key": PICARETA_INGEST_KEY
      },
      body: JSON.stringify({
        vehicles: batch,
        snapshotSource,
        snapshotComplete: last,
        ...(last ? { snapshotExternalIds: vehicles.map(externalId) } : {}),
      }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) {
      const raw = await response.text();
      let detail = raw.slice(0, 350);
      try {
        const payload = JSON.parse(raw) as { message?: string; data?: { issues?: Array<{ path: string; message: string }> } };
        detail = payload.data?.issues?.length
          ? payload.data.issues.slice(0, 3).map(issue => `${issue.path}: ${issue.message}`).join("; ")
          : payload.message || detail;
      } catch { /* Resposta não JSON mantém o resumo HTTP. */ }
      throw new Error(`Picareta ingestão HTTP ${response.status}: ${detail}`);
    }
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

  const vehicleIds: string[] = [];
  let saving = Promise.resolve();
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
      onSourceResult: result => {
        const task = saving.then(async () => {
          const source = job.sourceProgress[result.source];
          if (!source || (!result.complete && !result.vehicles.length)) return;
          source.status = "saving";
          job.message = `${source.label}: salvando ${result.vehicles.length} veículo(s)...`;
          addLog(job, job.message);
          await notifyPicareta(job);
          const saved = await ingestVehicles(result.vehicles, result.source, result.complete);
          source.newCount = saved.newCount;
          source.updatedCount = saved.updatedCount;
          source.persisted = result.complete && result.vehicles.length > 0;
          // Apenas snapshot completo alimenta a seleção automática.
          if (result.complete) vehicleIds.push(...saved.vehicleIds);
          job.totalNew += saved.newCount;
          job.totalUpdated += saved.updatedCount;
          addLog(job, `${source.label}: ${saved.newCount} novo(s), ${saved.updatedCount} atualizado(s)${result.complete ? "" : " (parcial)"}.`);
        });
        saving = task.catch(() => undefined);
        return task;
      },
      log: (message) => addLog(job, message)
    });

    updateJob(job, { phase: "analyzing", percent: 93, message: "Analisando oportunidades..." });
    try { await notifyOpportunityMatches(job.runId, vehicleIds); }
    catch (error) { addLog(job, `[oportunidades] Análise adicional falhou: ${error instanceof Error ? error.message : String(error)}`); }
    updateJob(job, { phase: "finalizing", percent: 98, message: "Finalizando execução..." });
    job.finishedAt = new Date().toISOString();
    const allFailed = result.sourceFailures.length === job.sources.length;
    updateJob(job, {
      status: allFailed ? "failed" : "completed",
      phase: allFailed ? "failed" : "completed",
      percent: allFailed ? 99 : 100,
      error: allFailed ? "Nenhuma fonte concluiu a coleta e a ingestão. Confira os erros por fonte." : null,
      message: `Scraping finalizado: ${job.totalNew} novo(s), ${job.totalUpdated} atualizado(s), ${result.sourceFailures.length} fonte(s) com falha.`
    });
  } catch (error) {
    job.finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    addLog(job, `Erro: ${message}`);
    updateJob(job, { status: "failed", phase: "failed", percent: Math.min(job.percent, 99), message: "Scraping finalizado com erro.", error: message });
  } finally {
    // Garantir que o callback terminal saia antes de liberar a execução.
    await notifyPicareta(job);
    if (activeRunId === job.runId) activeRunId = null;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (requestUrl.pathname === "/health") {
    json(res, 200, { ok: true, service: "bot-anuncios-scraper", version: SERVICE_VERSION, activeRunId, host: hostname() });
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

  if (requestUrl.pathname === "/internal/scraping/conditional-check" && req.method === "POST") {
    if (conditionalCheckRunning) {
      json(res, 409, { ok: false, message: "Já existe uma reconsulta de condicionais em execução." });
      return;
    }
    const dataMongoConfig = getMongoDataConfigFromEnv();
    if (!dataMongoConfig.enabled) {
      json(res, 503, { ok: false, message: "Mongo de dados não configurado." });
      return;
    }
    const body = await readJson(req);
    const vehicleId = typeof body.vehicleId === "string" && body.vehicleId.trim()
      ? body.vehicleId.trim()
      : undefined;
    if (body.vehicleIds !== undefined && (!Array.isArray(body.vehicleIds) || body.vehicleIds.length < 1 || body.vehicleIds.length > 100)) {
      json(res, 400, { ok: false, message: "A seleção deve conter entre 1 e 100 lotes." });
      return;
    }
    const requestedVehicleIds = Array.isArray(body.vehicleIds)
      ? body.vehicleIds.map((value) => typeof value === "string" ? value.trim() : "")
      : [];
    if ((vehicleId && !/^[a-f\d]{24}$/i.test(vehicleId)) || requestedVehicleIds.some((id) => !/^[a-f\d]{24}$/i.test(id))) {
      json(res, 400, { ok: false, message: "A seleção contém identificadores de veículo inválidos." });
      return;
    }
    const vehicleIds = [...new Set(requestedVehicleIds)];
    if (vehicleId && vehicleIds.length) {
      json(res, 400, { ok: false, message: "Informe um veículo individual ou uma seleção, não os dois." });
      return;
    }
    const hasSelectedVehicles = Boolean(vehicleId || vehicleIds.length);
    const force = body.force === true;
    if (hasSelectedVehicles) {
      const activeQueue = await listActiveCopartConditionalQueue(dataMongoConfig);
      if (activeQueue.claimed > 0) {
        json(res, 409, { ok: false, message: "Já existe uma condicional em processamento. Aguarde a conclusão ou limpe a fila antes de iniciar outra consulta." });
        return;
      }
    }
    const cleared = hasSelectedVehicles
      ? await clearActiveCopartConditionalQueue(dataMongoConfig, vehicleId ? "Fila geral substituída por consulta individual." : "Fila geral substituída pelos lotes selecionados no Histórico.")
      : { jobsRemoved: 0, runsClosed: 0 };
    const running = await getRunningCopartConditionalRun(dataMongoConfig);
    if (running) {
      json(res, 202, {
        ok: true,
        runId: running.runId,
        status: "running",
        resumed: true,
        vehicleId: vehicleId ?? null,
        vehicleIds,
        eligible: Math.max(0, running.total - running.processed),
        queued: 0,
      });
      return;
    }
    const eligible = await countPendingCopartConditionals(dataMongoConfig, new Date(), { force, vehicleId, vehicleIds });
    const runId = randomUUID();
    conditionalCheckRunning = true;
    const result = await triggerCopartConditionalCheck({
      trigger: "manual",
      force,
      vehicleId,
      vehicleIds,
      runId,
    });
    json(res, result ? 202 : 500, {
      ok: Boolean(result),
      runId,
      status: result ? "running" : "failed",
      vehicleId: vehicleId ?? null,
      vehicleIds,
      eligible: result?.eligible ?? eligible,
      queued: result?.queued ?? 0,
      cleared,
      ...(result ? {} : { message: "Não foi possível criar a fila de condicionais." }),
    });
    return;
  }

  if (requestUrl.pathname === "/internal/scraping/conditional-check" && req.method === "GET") {
    const dataMongoConfig = getMongoDataConfigFromEnv();
    if (!dataMongoConfig.enabled) {
      json(res, 503, { ok: false, message: "Mongo de dados não configurado." });
      return;
    }
    const queue = await listActiveCopartConditionalQueue(dataMongoConfig);
    json(res, 200, { ok: true, ...queue, total: queue.queued + queue.claimed });
    return;
  }

  if (requestUrl.pathname === "/internal/scraping/conditional-check" && req.method === "DELETE") {
    const dataMongoConfig = getMongoDataConfigFromEnv();
    if (!dataMongoConfig.enabled) {
      json(res, 503, { ok: false, message: "Mongo de dados não configurado." });
      return;
    }
    const cleared = await clearActiveCopartConditionalQueue(dataMongoConfig, "Fila limpa manualmente pelo administrador.");
    json(res, 200, { ok: true, ...cleared });
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
