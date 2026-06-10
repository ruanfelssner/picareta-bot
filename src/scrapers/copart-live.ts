import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type {
  CopartLiveAuctionEvent,
  CopartLiveEventType,
  CopartLiveSaleStatus
} from "../integrations/mongo.js";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";

const DEFAULT_PROFILE_PATH = "./data/facebook-profile";
const DEFAULT_COPART_LIVE_URL = "https://www.copart.com.br/auctionDashboard";
const DEFAULT_POLL_MS = 1_250;
const DEFAULT_MAX_SECONDS = 60 * 60 * 4;

export type CopartLiveAuctionMonitorEvent = Omit<
  CopartLiveAuctionEvent,
  "source" | "updatedAt" | "createdAt"
>;

export type CopartLiveAuctionMonitorOptions = {
  liveUrl?: string | null;
  profilePath?: string | null;
  headless?: boolean;
  pollMs?: number;
  maxSeconds?: number;
  log?: (message: string) => void;
  onEvents?: (events: CopartLiveAuctionMonitorEvent[]) => Promise<void> | void;
  shouldCancel?: () => boolean;
};

export type CopartLiveAuctionMonitorSummary = {
  events: number;
  snapshots: number;
  systemMessages: number;
  startedAt: Date;
  finishedAt: Date;
};

export type CopartLiveProfilePageResult = {
  liveUrl: string;
  profilePath: string;
};

type RawCopartLiveImage = {
  src: string;
  alt: string;
  width: number;
  height: number;
  area: number;
};

type RawCopartLivePageState = {
  url: string;
  text: string;
  currentBidText: string | null;
  bidButtonText: string | null;
  titleTexts: string[];
  images: RawCopartLiveImage[];
};

type CopartLiveSnapshot = {
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
  imageUrl: string | null;
  vehicleUrl: string | null;
  liveStatus: string | null;
};

type ParsedSystemMessage = {
  eventType: CopartLiveEventType;
  saleStatus: CopartLiveSaleStatus;
  lot: string | null;
  bid: number | null;
  bidRaw: string | null;
  message: string;
};

let manualCopartLiveContext: BrowserContext | null = null;
let manualCopartLiveBrowser: Browser | null = null;
let manualCopartLiveUsesCdp = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function compactText(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(value: string | null | undefined): string {
  return compactText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(compactText)
    .filter(Boolean);
}

const KNOWN_FIELD_LABELS = [
  "leilao / lote",
  "leilão / lote",
  "codigo",
  "código",
  "descricao",
  "descrição",
  "versao",
  "versão",
  "fabricacao / modelo",
  "fabricação / modelo",
  "marca",
  "modelo",
  "categoria",
  "fipe",
  "tipo de documento",
  "tipo de monta",
  "tipo de chassi",
  "blindado",
  "condicao",
  "condição",
  "condicao func",
  "condição func",
  "numero do chassi",
  "número do chassi",
  "chave",
  "final da placa",
  "combustivel",
  "combustível",
  "patio",
  "pátio",
  "comitente",
  "complemento",
  "oferta atual"
].map(normalizeText);

function isKnownLabelLine(line: string): boolean {
  const normalized = normalizeText(line.replace(/:$/, ""));
  return KNOWN_FIELD_LABELS.some((label) => normalized === label || normalized.startsWith(`${label}:`));
}

function getValueAfterLabel(lines: string[], labels: string[]): string | null {
  const normalizedLabels = labels.map(normalizeText);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const normalizedLine = normalizeText(line);
    const matchedLabel = normalizedLabels.find(
      (label) => normalizedLine === label || normalizedLine.startsWith(`${label}:`)
    );
    if (!matchedLabel) continue;

    const colonIndex = line.indexOf(":");
    if (colonIndex >= 0) {
      const inline = compactText(line.slice(colonIndex + 1));
      if (inline) return inline;
    }

    for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
      const candidate = lines[j] ?? "";
      if (!candidate || isKnownLabelLine(candidate)) continue;
      return candidate;
    }
  }

  return null;
}

function extractMoneyText(raw: string | null | undefined): string | null {
  const text = compactText(raw);
  const match = text.match(/R\$\s*[\d.]+(?:,\d{1,2})?/i);
  return match ? compactText(match[0]) : null;
}

function parseMoney(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? Math.round(raw) : null;
  }

  const moneyText = extractMoneyText(raw) ?? compactText(raw);
  if (!moneyText) return null;

  const normalized = moneyText
    .replace(/[^\d,.-]/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(",", ".");
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function parseAuctionAndLot(raw: string | null): { auctionId: string | null; lot: string | null } {
  const value = compactText(raw);
  if (!value) return { auctionId: null, lot: null };

  const slash = value.match(/([A-Za-z0-9.-]+)\s*\/\s*([A-Za-z0-9.-]+)/);
  if (slash) {
    return { auctionId: slash[1] ?? null, lot: slash[2] ?? null };
  }

  const lot = value.match(/\blote\s+([A-Za-z0-9.-]+)/i)?.[1] ?? null;
  return { auctionId: null, lot };
}

function detectSaleStatus(text: string): CopartLiveSaleStatus {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (normalized.includes("condicional")) return "conditional";
  if (
    /\bvendid[oa]\b/.test(normalized) ||
    normalized.includes("arrematado") ||
    normalized.includes("venda confirmada") ||
    normalized.includes("venda realizada")
  ) {
    return "sold";
  }
  return null;
}

function pickMainImage(images: RawCopartLiveImage[]): string | null {
  const sorted = images
    .filter((image) => {
      if (!image.src) return false;
      if (image.width < 120 || image.height < 90) return false;
      const normalized = image.src.toLowerCase();
      if (normalized.includes("logo")) return false;
      if (normalized.includes("sprite")) return false;
      return true;
    })
    .sort((a, b) => b.area - a.area);

  return sorted[0]?.src ?? null;
}

function findLiveStatus(lines: string[], titleTexts: string[]): string | null {
  const candidates = [...titleTexts, ...lines]
    .map(compactText)
    .filter((line) => line.length > 0 && line.length <= 80);

  return (
    candidates.find((line) => {
      const normalized = normalizeText(line);
      return (
        normalized.includes("maior lance") ||
        normalized.includes("condicional") ||
        normalized.includes("vendido") ||
        normalized.includes("em leilao") ||
        normalized.includes("em leilão")
      );
    }) ?? null
  );
}

function buildVehicleUrl(code: string | null): string | null {
  if (!code) return null;
  const normalized = code.replace(/\D/g, "");
  return normalized ? `https://www.copart.com.br/lot/${normalized}` : null;
}

function parseSnapshot(raw: RawCopartLivePageState): CopartLiveSnapshot {
  const lines = splitLines(raw.text);
  const auctionLot = parseAuctionAndLot(getValueAfterLabel(lines, ["Leilao / Lote", "Leilão / Lote"]));
  const code = getValueAfterLabel(lines, ["Código", "Codigo"]);
  const description = getValueAfterLabel(lines, ["Descrição", "Descricao"]);
  const version = getValueAfterLabel(lines, ["Versão", "Versao"]);
  const yearModel = getValueAfterLabel(lines, ["Fabricação / Modelo", "Fabricacao / Modelo"]);
  const fipeRaw = extractMoneyText(getValueAfterLabel(lines, ["FIPE"]));
  const bidRaw = extractMoneyText(raw.currentBidText) ?? extractMoneyText(getValueAfterLabel(lines, ["Oferta atual"]));
  const liveStatus = findLiveStatus(lines, raw.titleTexts);

  return {
    auctionId: auctionLot.auctionId,
    lot: auctionLot.lot,
    code,
    description,
    version,
    yearModel,
    fipe: parseMoney(fipeRaw),
    fipeRaw,
    damage: getValueAfterLabel(lines, ["Tipo de Monta"]),
    yard: getValueAfterLabel(lines, ["Pátio", "Patio"]),
    bid: parseMoney(bidRaw),
    bidRaw,
    saleStatus: detectSaleStatus(liveStatus ?? ""),
    imageUrl: pickMainImage(raw.images),
    vehicleUrl: buildVehicleUrl(code),
    liveStatus
  };
}

function extractLotFromMessage(message: string): string | null {
  return (
    message.match(/\blote\s+([A-Za-z0-9.-]+)/i)?.[1] ??
    message.match(/\blot\s+([A-Za-z0-9.-]+)/i)?.[1] ??
    null
  );
}

function parseSystemMessage(message: string): ParsedSystemMessage | null {
  const text = compactText(message);
  if (!text) return null;

  const normalized = normalizeText(text);
  const bidRaw = extractMoneyText(text);
  const bid = parseMoney(bidRaw);
  const lot = extractLotFromMessage(text);

  if (normalized.includes("venda condicional")) {
    return {
      eventType: "sale",
      saleStatus: "conditional",
      lot,
      bid,
      bidRaw,
      message: text
    };
  }

  if (
    /\bvendid[oa]\b/.test(normalized) ||
    normalized.includes("venda realizada") ||
    normalized.includes("venda confirmada") ||
    normalized.includes("arrematado")
  ) {
    return {
      eventType: "sale",
      saleStatus: "sold",
      lot,
      bid,
      bidRaw,
      message: text
    };
  }

  if (normalized.includes("novo lance") && normalized.includes("recebido")) {
    return {
      eventType: "bid",
      saleStatus: "open",
      lot,
      bid,
      bidRaw,
      message: text
    };
  }

  if (normalized.includes("lances") && normalized.includes("encerrad")) {
    return {
      eventType: "closed",
      saleStatus: null,
      lot,
      bid,
      bidRaw,
      message: text
    };
  }

  return null;
}

function eventFingerprint(value: string | null | undefined): string {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function calculateFipePercent(bid: number | null, fipe: number | null): number | null {
  if (bid == null || fipe == null || fipe <= 0) return null;
  return Math.round((bid / fipe) * 100);
}

function buildEvent(
  snapshot: CopartLiveSnapshot,
  observedAt: Date,
  eventType: CopartLiveEventType,
  overrides?: Partial<ParsedSystemMessage>
): CopartLiveAuctionMonitorEvent {
  const lot = overrides?.lot ?? snapshot.lot;
  const bid = overrides?.bid ?? snapshot.bid;
  const bidRaw = overrides?.bidRaw ?? snapshot.bidRaw;
  const saleStatus = overrides?.saleStatus ?? snapshot.saleStatus;
  const message = overrides?.message ?? snapshot.liveStatus;
  const eventKey = [
    "copart-live",
    snapshot.auctionId ?? "",
    lot ?? "",
    eventType,
    saleStatus ?? "",
    bid != null ? String(bid) : "",
    eventFingerprint(message)
  ].join("|");

  return {
    eventKey,
    auctionId: snapshot.auctionId,
    lot,
    code: snapshot.code,
    description: snapshot.description,
    version: snapshot.version,
    yearModel: snapshot.yearModel,
    fipe: snapshot.fipe,
    fipeRaw: snapshot.fipeRaw,
    damage: snapshot.damage,
    yard: snapshot.yard,
    bid,
    bidRaw,
    saleStatus,
    eventType,
    fipePercent: calculateFipePercent(bid, snapshot.fipe),
    imageUrl: snapshot.imageUrl,
    vehicleUrl: snapshot.vehicleUrl,
    message,
    observedAt
  };
}

function getSystemMessages(text: string): string[] {
  return splitLines(text)
    .filter((line) => normalizeText(line).startsWith("sistema:"))
    .slice(-80);
}

async function readCopartLivePageState(page: Page): Promise<RawCopartLivePageState> {
  const result = await page.evaluate(`
    (() => {
      function compact(value) {
        return String(value || "").replace(/\\s+/g, " ").trim();
      }

      function isVisible(element) {
        const rect = element.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(element);
        return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity || "1") > 0;
      }

      const titleTexts = Array.from(document.querySelectorAll(".title-container, .title, .label-title, h1, h2, h3"))
        .map((element) => compact(element.textContent))
        .filter(Boolean);

      const images = Array.from(document.images)
        .filter(isVisible)
        .map((image) => {
          const rect = image.getBoundingClientRect();
          return {
            src: image.currentSrc || image.src || "",
            alt: image.alt || "",
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            area: Math.round(rect.width * rect.height)
          };
        });

      const currentBidText =
        compact(document.querySelector(".main-bid-container .title-container .data-value")?.textContent) ||
        compact(document.querySelector(".main-bid-container .data-value")?.textContent) ||
        null;
      const bidButtonText = compact(document.querySelector(".main-bid-button")?.textContent) || null;

      return {
        url: window.location.href,
        text: document.body?.innerText || "",
        currentBidText,
        bidButtonText,
        titleTexts,
        images
      };
    })()
  `);
  return result as RawCopartLivePageState;
}

function getLiveUrl(input: string | null | undefined): string {
  const raw = compactText(input);
  if (!raw) return process.env.COPART_LIVE_URL?.trim() || DEFAULT_COPART_LIVE_URL;
  try {
    return new URL(raw).toString();
  } catch {
    return raw;
  }
}

function getPositiveInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value == null) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getProfilePath(input: string | null | undefined): string {
  return compactText(input) || process.env.PROFILE_PATH?.trim() || DEFAULT_PROFILE_PATH;
}

function getCopartChromeCdpUrl(): string | null {
  const raw = compactText(process.env.COPART_CHROME_CDP_URL);
  return raw || null;
}

function buildVisibleCopartLaunchOptions(): {
  headless: false;
  args: string[];
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
} {
  const base = buildPlaywrightLaunchOptions(false);
  const args = new Set(base.args ?? []);
  args.add("--start-maximized");
  args.add("--window-position=0,0");
  args.add("--window-size=1920,1080");
  return {
    headless: false,
    args: Array.from(args),
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 }
  };
}

function readWindowId(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const value = (result as { windowId?: unknown }).windowId;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function forceVisiblePageMaximized(page: Page): Promise<void> {
  const session = await page.context().newCDPSession(page);
  try {
    const windowInfo = await session.send("Browser.getWindowForTarget");
    const windowId = readWindowId(windowInfo);
    if (windowId == null) return;

    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: 0,
        top: 0,
        windowState: "maximized"
      }
    });
    await page.waitForTimeout(250);
  } catch {
    try {
      await page.setViewportSize({ width: 1920, height: 1080 });
    } catch {
      // best effort only
    }
  } finally {
    await session.detach().catch(() => {});
  }
}

export async function closeCopartLiveProfilePage(): Promise<void> {
  const context = manualCopartLiveContext;
  const browser = manualCopartLiveBrowser;
  const usesCdp = manualCopartLiveUsesCdp;
  manualCopartLiveContext = null;
  manualCopartLiveBrowser = null;
  manualCopartLiveUsesCdp = false;
  if (usesCdp) {
    return;
  }
  if (!context) return;
  await context.close().catch(() => {});
  await browser?.close().catch(() => {});
}

export async function openCopartLiveProfilePage(
  options: Pick<CopartLiveAuctionMonitorOptions, "liveUrl" | "profilePath"> = {}
): Promise<CopartLiveProfilePageResult> {
  await closeCopartLiveProfilePage();

  const profilePath = getProfilePath(options.profilePath);
  const liveUrl = getLiveUrl(options.liveUrl);
  const cdpUrl = getCopartChromeCdpUrl();

  if (cdpUrl) {
    manualCopartLiveBrowser = await chromium.connectOverCDP(cdpUrl);
    manualCopartLiveContext =
      manualCopartLiveBrowser.contexts()[0] ?? await manualCopartLiveBrowser.newContext({
        viewport: { width: 1920, height: 1080 },
        screen: { width: 1920, height: 1080 }
      });
    manualCopartLiveUsesCdp = true;
  } else {
    manualCopartLiveContext = await chromium.launchPersistentContext(profilePath, {
      ...buildVisibleCopartLaunchOptions(),
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "pt-BR"
    });
    const openedContext = manualCopartLiveContext;
    openedContext.once("close", () => {
      if (manualCopartLiveContext === openedContext) {
        manualCopartLiveContext = null;
      }
    });
  }

  const page = manualCopartLiveContext.pages()[0] ?? await manualCopartLiveContext.newPage();
  await forceVisiblePageMaximized(page);
  await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
  await forceVisiblePageMaximized(page);

  return {
    liveUrl,
    profilePath: cdpUrl ? `chrome-cdp:${cdpUrl}` : profilePath
  };
}

export async function runCopartLiveAuctionMonitor(
  options: CopartLiveAuctionMonitorOptions = {}
): Promise<CopartLiveAuctionMonitorSummary> {
  const log = options.log ?? console.log;
  const profilePath = getProfilePath(options.profilePath);
  const liveUrl = getLiveUrl(options.liveUrl);
  const headless = options.headless ?? true;
  const pollMs = getPositiveInt(options.pollMs, DEFAULT_POLL_MS, 500, 10_000);
  const maxSeconds = getPositiveInt(options.maxSeconds, DEFAULT_MAX_SECONDS, 10, 60 * 60 * 12);
  const startedAt = new Date();
  const seenEventKeys = new Set<string>();
  const seenSystemMessages = new Set<string>();
  const snapshotsByLot = new Map<string, CopartLiveSnapshot>();
  let eventCount = 0;
  let snapshotCount = 0;
  let systemMessageCount = 0;

  log(`[copart-live] Abrindo ${liveUrl}`);
  log(`[copart-live] Perfil: ${profilePath}`);

  const existingContext = manualCopartLiveContext;
  const cdpUrl = getCopartChromeCdpUrl();
  let context: BrowserContext;
  if (existingContext) {
    context = existingContext;
  } else if (cdpUrl) {
    const cdpBrowser = await chromium.connectOverCDP(cdpUrl);
    context = cdpBrowser.contexts()[0] ?? await cdpBrowser.newContext({
      viewport: { width: 1920, height: 1080 },
      screen: { width: 1920, height: 1080 }
    });
    log(`[copart-live] Conectado ao Chrome existente via CDP: ${cdpUrl}`);
  } else {
    context = await chromium.launchPersistentContext(profilePath, {
      ...buildPlaywrightLaunchOptions(headless),
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "pt-BR"
    });
  }
  const shouldCloseContext = existingContext == null;
  if (existingContext) {
    log("[copart-live] Reaproveitando janela Copart já aberta para manter a sessão logada.");
  }

  const page = context.pages()[0] ?? await context.newPage();

  try {
    await page.goto(liveUrl, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch((error: unknown) => {
      log(`[copart-live] Aviso ao abrir página: ${error instanceof Error ? error.message : String(error)}`);
    });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(1_500);

    const deadline = Date.now() + maxSeconds * 1000;
    while (Date.now() < deadline) {
      if (options.shouldCancel?.()) {
        log("[copart-live] Monitor cancelado pelo cliente.");
        break;
      }

      const observedAt = new Date();
      const state = await readCopartLivePageState(page);
      const currentSnapshot = parseSnapshot(state);
      if (currentSnapshot.lot) {
        snapshotsByLot.set(currentSnapshot.lot, currentSnapshot);
      }

      const events: CopartLiveAuctionMonitorEvent[] = [];
      if (currentSnapshot.lot || currentSnapshot.code || currentSnapshot.description) {
        const snapshotEvent = buildEvent(currentSnapshot, observedAt, "snapshot");
        if (!seenEventKeys.has(snapshotEvent.eventKey)) {
          seenEventKeys.add(snapshotEvent.eventKey);
          snapshotCount += 1;
          events.push(snapshotEvent);
        }
      }

      for (const message of getSystemMessages(state.text)) {
        const messageKey = eventFingerprint(message);
        if (!messageKey || seenSystemMessages.has(messageKey)) continue;
        seenSystemMessages.add(messageKey);

        const parsed = parseSystemMessage(message);
        if (!parsed) continue;

        const snapshotForMessage =
          parsed.lot != null
            ? snapshotsByLot.get(parsed.lot) ?? currentSnapshot
            : currentSnapshot;
        const messageEvent = buildEvent(snapshotForMessage, observedAt, parsed.eventType, parsed);
        if (seenEventKeys.has(messageEvent.eventKey)) continue;
        seenEventKeys.add(messageEvent.eventKey);
        systemMessageCount += 1;
        events.push(messageEvent);
      }

      if (events.length > 0) {
        eventCount += events.length;
        await options.onEvents?.(events);
      }

      await sleep(pollMs);
    }
  } finally {
    if (shouldCloseContext && !cdpUrl) {
      await context.close();
    }
  }

  return {
    events: eventCount,
    snapshots: snapshotCount,
    systemMessages: systemMessageCount,
    startedAt,
    finishedAt: new Date()
  };
}
