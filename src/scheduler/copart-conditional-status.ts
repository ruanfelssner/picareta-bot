import { randomUUID } from "node:crypto";
import { chromium, type BrowserContext, type Page } from "playwright";
import type { MongoConfig } from "../integrations/mongo.js";
import {
  createCopartConditionalAttempt,
  listPendingCopartConditionals,
  updateCopartConditionalAttempt,
  updateCopartConditionalStatus,
  type CopartConditionalStatusUpdate,
} from "../integrations/mongo.js";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";
import type {
  CopartConditionalAttemptStatus,
  CopartConditionalCheckTrigger,
} from "../../shared/types/copart-conditional-check.js";

const DEFAULT_PROFILE_PATH = "./data/facebook-profile";
const PAGE_TIMEOUT_MS = 30_000;
const SETTLE_TIME_MS = 1_500;

export type CopartConditionalCheckStatus = "pending" | "approved" | "refused";

export type CopartConditionalPageResult = {
  status: CopartConditionalCheckStatus;
  statusRaw: string;
  nextAuctionDate: Date | null;
  currentBid: number | null;
};

export type CopartConditionalCheckOptions = {
  dataMongoConfig: MongoConfig;
  headless?: boolean;
  profilePath?: string;
  log?: (message: string) => void;
  now?: Date;
  trigger?: CopartConditionalCheckTrigger;
  runId?: string;
  force?: boolean;
  vehicleId?: string;
};

export type CopartConditionalCheckSummary = {
  eligible: number;
  checked: number;
  approved: number;
  refused: number;
  pending: number;
  errors: number;
  runId: string;
};

export async function runCopartConditionalStatusCheck(
  options: CopartConditionalCheckOptions,
): Promise<CopartConditionalCheckSummary> {
  const log = options.log ?? console.log;
  const now = options.now ?? new Date();
  const runId = options.runId ?? randomUUID();
  const trigger = options.trigger ?? "schedule";
  const candidates = await listPendingCopartConditionals(options.dataMongoConfig, now, {
    force: options.force,
    vehicleId: options.vehicleId,
  });
  const summary: CopartConditionalCheckSummary = {
    eligible: candidates.length,
    checked: 0,
    approved: 0,
    refused: 0,
    pending: 0,
    errors: 0,
    runId,
  };

  if (!candidates.length) {
    log("[conditional-check] Nenhum lote condicional elegível para reconsulta.");
    return summary;
  }

  const profilePath = options.profilePath?.trim() || process.env.PROFILE_PATH?.trim() || DEFAULT_PROFILE_PATH;
  log(`[conditional-check] Reconsultando ${candidates.length} lote(s) condicionais; perfil: ${profilePath}.`);

  let context: BrowserContext;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      ...buildPlaywrightLaunchOptions(options.headless ?? true),
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
      locale: "pt-BR",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const finishedAt = new Date();
    await Promise.all(candidates.map(candidate => {
      const startedAt = new Date(finishedAt);
      return createCopartConditionalAttempt(options.dataMongoConfig, buildAttemptRecord(
        candidate,
        runId,
        trigger,
        "error",
        startedAt,
        finishedAt,
        message,
      ));
    }));
    summary.errors = candidates.length;
    log(`[conditional-check] Falha ao abrir o navegador: ${message}`);
    return summary;
  }
  const page = context.pages()[0] ?? await context.newPage();

  try {
    for (const candidate of candidates) {
      const startedAt = new Date();
      const attemptId = await createCopartConditionalAttempt(options.dataMongoConfig, buildAttemptRecord(
        candidate,
        runId,
        trigger,
        "running",
        startedAt,
      ));
      const attempt = attemptId ? { id: attemptId, startedAt } : null;
      try {
        const result = await checkCopartConditionalPage(page, candidate.url, candidate.auctionDate);
        if (result.status === "pending") {
          summary.pending += 1;
          if (attempt) {
            await updateCopartConditionalAttempt(options.dataMongoConfig, attempt.id, finishAttempt(
              "pending",
              attempt.startedAt,
              new Date(),
              null,
              result.statusRaw,
              result.nextAuctionDate,
            ));
          }
          log(`[conditional-check] Ainda pendente: ${candidate.url}`);
          continue;
        }

        const originalAuctionDate = candidate.conditionalOriginalAuctionDate ?? candidate.auctionDate;
        const update: CopartConditionalStatusUpdate = {
          id: String(candidate._id),
          status: result.status,
          statusRaw: result.statusRaw,
          checkedAt: new Date(),
          originalAuctionDate,
          ...(result.status === "refused"
            ? { nextAuctionDate: result.nextAuctionDate, currentBid: result.currentBid }
            : {}),
        };
        const updated = await updateCopartConditionalStatus(options.dataMongoConfig, update);
        if (!updated) {
          if (attempt) {
            await updateCopartConditionalAttempt(options.dataMongoConfig, attempt.id, finishAttempt(
              "skipped",
              attempt.startedAt,
              new Date(),
              "O lote mudou durante a consulta.",
              result.statusRaw,
              result.nextAuctionDate,
            ));
          }
          log(`[conditional-check] Lote mudou durante a consulta: ${candidate.url}`);
          continue;
        }

        summary.checked += 1;
        summary[result.status] += 1;
        if (attempt) {
          await updateCopartConditionalAttempt(options.dataMongoConfig, attempt.id, finishAttempt(
            result.status,
            attempt.startedAt,
            new Date(),
            null,
            result.statusRaw,
            result.nextAuctionDate,
          ));
        }
        log(`[conditional-check] ${result.status === "approved" ? "Aprovado" : "Recusado"}: ${candidate.url}`);
      } catch (error) {
        summary.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt) {
          await updateCopartConditionalAttempt(options.dataMongoConfig, attempt.id, finishAttempt(
            "error",
            attempt.startedAt,
            new Date(),
            message,
          ));
        }
        log(`[conditional-check] Falha no lote ${candidate.url}: ${message}`);
      }
    }
  } finally {
    await context.close();
  }

  log(
    `[conditional-check] Concluído: ${summary.approved} aprovado(s), `
      + `${summary.refused} recusado(s), ${summary.pending} pendente(s), ${summary.errors} erro(s).`,
  );
  return summary;
}

function buildAttemptRecord(
  candidate: {
    _id: { toString(): string };
    url: string;
    lot?: string | null;
    title?: string | null;
    brand?: string | null;
    model?: string | null;
    year?: number | null;
    auctionDate: Date | null;
    conditionalOriginalAuctionDate?: Date | null;
  },
  runId: string,
  trigger: CopartConditionalCheckTrigger,
  status: CopartConditionalAttemptStatus,
  startedAt: Date,
  finishedAt: Date | null = null,
  error: string | null = null,
) {
  return {
    runId,
    vehicleId: candidate._id.toString(),
    url: candidate.url,
    lot: candidate.lot ?? null,
    title: candidate.title ?? null,
    brand: candidate.brand ?? null,
    model: candidate.model ?? null,
    year: candidate.year ?? null,
    trigger,
    status,
    statusRaw: null,
    startedAt,
    finishedAt,
    checkedAt: finishedAt,
    durationMs: finishedAt ? Math.max(0, finishedAt.getTime() - startedAt.getTime()) : null,
    originalAuctionDate: candidate.conditionalOriginalAuctionDate ?? candidate.auctionDate,
    auctionDate: candidate.auctionDate,
    nextAuctionDate: null,
    error,
  };
}

function finishAttempt(
  status: CopartConditionalAttemptStatus,
  startedAt: Date,
  finishedAt: Date,
  error: string | null,
  statusRaw: string | null = null,
  nextAuctionDate: Date | null = null,
) {
  return {
    status,
    statusRaw,
    finishedAt,
    checkedAt: finishedAt,
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    nextAuctionDate,
    error,
  };
}

export async function checkCopartConditionalPage(
  page: Pick<Page, "goto" | "waitForLoadState" | "waitForTimeout" | "locator" | "content" | "textContent">,
  url: string,
  originalAuctionDate: Date | null,
): Promise<CopartConditionalPageResult> {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_TIME_MS);

  const bodyText = (await page.locator("body").innerText().catch(() => ""))
    || (await page.textContent("body").catch(() => ""))
    || "";
  const pageHtml = await page.content().catch(() => "");
  const normalized = normalizePageText(bodyText);
  if (isCopartProtectionPage(normalized, normalizePageText(pageHtml))) {
    throw new Error("Copart bloqueou a página com Incapsula/Captcha");
  }

  return classifyCopartConditionalPageText(bodyText, originalAuctionDate);
}

export function classifyCopartConditionalPageText(
  bodyText: string,
  originalAuctionDate: Date | null,
): CopartConditionalPageResult {
  const normalized = normalizePageText(bodyText);
  const dates = parseCopartAuctionDates(bodyText);
  const futureDates = dates.filter(date => originalAuctionDate == null || date.getTime() > originalAuctionDate.getTime());
  const nextAuctionDate = futureDates.sort((first, second) => first.getTime() - second.getTime())[0] ?? null;
  const currentBid = parseCurrentBid(bodyText);
  const hasFinalizedWord = normalized.includes("FINALIZADO") || normalized.includes("FINALIZADA");
  const hasNonFinalizedStatus = normalized.includes("NAO FINALIZADO") || normalized.includes("AINDA NAO FINALIZADO");
  const hasFinalizedStatus = !hasNonFinalizedStatus && (hasFinalizedWord
    || normalized.includes("LEILAO FINALIZADO")
    || normalized.includes("RESULTADO DA CONDICIONAL") && (normalized.includes("FINALIZADO") || normalized.includes("FINALIZADA"))
    || normalized.includes("CONDICIONAL FINALIZADA")
    || normalized.includes("CONDICIONAL FINALIZADO"));
  const allowsBidding = normalized.includes("DAR LANCE")
    || normalized.includes("DAR LANCES")
    || normalized.includes("PERMITINDO DAR LANCE")
    || normalized.includes("LANCE AGORA");

  if (hasFinalizedStatus && nextAuctionDate == null) {
    return { status: "approved", statusRaw: "Venda Finalizada", nextAuctionDate: null, currentBid };
  }

  if (nextAuctionDate != null && allowsBidding) {
    return { status: "refused", statusRaw: "Dar Lance Agora", nextAuctionDate, currentBid };
  }

  return { status: "pending", statusRaw: extractStatusRaw(bodyText), nextAuctionDate, currentBid };
}

export function normalizePageText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function parseCopartAuctionDates(value: string): Date[] {
  const dates: Date[] = [];
  const pattern = /(?:SEGUNDA|TERCA|QUARTA|QUINTA|SEXTA|SABADO|DOMINGO)?\s*\|?\s*(\d{2})[./-](\d{2})[./-](\d{4})\s*(?:\|\s*)?(\d{2}):(\d{2})/gi;
  for (const match of value.matchAll(pattern)) {
    const [, day, month, year, hour, minute] = match;
    if (!day || !month || !year || !hour || !minute) continue;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:00-03:00`);
    if (!Number.isNaN(parsed.getTime()) && !dates.some(date => date.getTime() === parsed.getTime())) dates.push(parsed);
  }
  return dates;
}

function parseCurrentBid(value: string): number | null {
  const normalized = normalizePageText(value);
  const match = normalized.match(/(?:LANCE\s+ATUAL|LANCE\s+VENCEDOR|VALOR\s+DA\s+VENDA)\s*:?\s*R\$\s*([\d.]+(?:,\d{1,2})?)/);
  if (!match?.[1]) return null;
  const parsed = Number.parseFloat(match[1].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

function extractStatusRaw(value: string): string {
  const normalized = normalizePageText(value);
  if (normalized.includes("VENDA CONDICIONAL")) return "Venda Condicional";
  if (normalized.includes("VENDA FUTURA")) return "Venda Futura";
  if (normalized.includes("DAR LANCE")) return "Dar Lance Agora";
  return "Aguardando resultado da condicional";
}

function isCopartProtectionPage(normalizedBody: string, normalizedHtml = normalizedBody): boolean {
  const hasProtectionMarker = normalizedBody.includes("CAPTCHA")
    || normalizedBody.includes("ACCESS DENIED")
    || normalizedBody.includes("INCAPSULA")
    || normalizedHtml.includes("INCAPSULA_RESOURCE")
    || normalizedHtml.includes("VISID_INCAP")
    || normalizedHtml.includes("INCAP_SES");
  return hasProtectionMarker && (normalizedBody.length < 300 || normalizedHtml.includes("INCAPSULA"));
}
