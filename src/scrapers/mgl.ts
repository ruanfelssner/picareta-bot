import { chromium, type Page } from "playwright";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";

const BASE_URL = "https://www.mgl.com.br";
const SEARCH_ENDPOINT_PATH = "/apiplugin/GetBusca";
const CATEGORY_FILTERS = [88, 108];
const PAGE_SIZE = 48;
const REQUEST_DELAY_MS = 350;
const DEFAULT_MAX_PAGES = 8;
const HARD_MAX_PAGES = 80;
const CLOUDFLARE_JSD_PATH = "/cdn-cgi/challenge-platform/scripts/jsd/";
const BROWSER_BLOCKED_RESOURCES = new Set(["image", "media", "font", "stylesheet"]);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const DIRECT_HEADERS: Record<string, string> = {
  "User-Agent": USER_AGENT,
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
  "Content-Type": "application/json; charset=UTF-8",
  "X-Requested-With": "XMLHttpRequest",
  Referer: `${BASE_URL}/`,
  Origin: BASE_URL
};

type MglPhoto = {
  Foto?: string | null;
};

type MglRealtime = {
  ValorLanceAtual?: number | null;
  ValorMinimoLancePrimeiraPraca?: number | null;
  DataHoraEncerramentoPrimeiraPraca?: string | null;
  DataHoraAberturaPrimeiraPraca?: string | null;
  IsVendaDireta?: boolean | null;
  Lote_SubStatus_Label?: string | null;
  StatusLote?: string | null;
};

type MglLot = {
  Lote?: string | null;
  LoteNumero?: string | null;
  URLlote?: string | null;
  Cidade?: string | null;
  UF?: string | null;
  Lote_Endereco?: string | null;
  Lote_Numero?: string | null;
  Lote_Bairro?: string | null;
  ValorAvaliacao?: number | null;
  ValorVendaDireta?: number | null;
  ValorInicialPrimeiraPraca?: number | null;
  Fotos?: MglPhoto[] | null;
  GetLoteRealTime?: MglRealtime[] | null;
};

type MglPageRef = {
  Pagina?: number | null;
};

type MglPagination = {
  Paginas?: MglPageRef[] | null;
};

type MglApiResponse = {
  CountTotal?: number | null;
  Lotes?: MglLot[] | null;
  Paginacao?: MglPagination | null;
};

type EndpointResponse = {
  ok: boolean;
  status: number;
  contentType: string;
  raw: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMaxPagesFromEnv(): number {
  const raw = Number.parseInt((process.env.MGL_MAX_PAGES ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.max(1, Math.min(HARD_MAX_PAGES, raw));
}

function parseManualChallengeWaitMs(): number {
  const raw = Number.parseInt((process.env.MGL_MANUAL_CHALLENGE_SECONDS ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw < 1) {
    return 45_000;
  }
  return Math.max(5_000, Math.min(10 * 60_000, raw * 1_000));
}

function parsePersistentProfileDir(): string | null {
  const raw = (process.env.MGL_USER_DATA_DIR ?? "").trim();
  return raw.length > 0 ? raw : null;
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function normalizeAlpha(raw: string): string {
  return normalizeSpace(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

/**
 * Detecta a página de desafio do Cloudflare. Não usar "cdn-cgi/challenge-platform" sozinho: o Cloudflare injeta
 * `/cdn-cgi/challenge-platform/scripts/jsd/main.js` em TODA página normal do MGL, o que fazia o fallback por
 * navegador tratar /comprar/ como bloqueada e devolver 0 lotes.
 */
export function looksLikeCloudflareChallenge(raw: string): boolean {
  return (
    /<title>\s*(?:just a moment|attention required)/i.test(raw) ||
    /performing security verification|enable javascript and cookies to continue|_cf_chl_opt|challenge-platform\/h\//i.test(raw)
  );
}

function buildSearchUrl(pageNumber: number): string {
  const query = CATEGORY_FILTERS.map((value) => `FiltroCategorias=${encodeURIComponent(String(value))}`).join("&");
  return `${BASE_URL}${SEARCH_ENDPOINT_PATH}/${pageNumber}/1/0?${query}`;
}

function buildRequestBody(pageNumber: number): Record<string, unknown> {
  return {
    RangeValores: 0,
    Scopo: 0,
    IgnoreScopo: 0,
    OrientacaoBusca: 0,
    Mapa: "",
    Busca: "",
    ID_Categoria: 0,
    ID_Modelo: 48,
    ID_Estado: 0,
    ID_Cidade: 0,
    Bairro: "",
    ID_Regiao: 0,
    ValorMinSelecionado: 0,
    ValorMaxSelecionado: 0,
    CFGs: "",
    Pagina: pageNumber,
    sInL: "",
    Ordem: 5,
    QtdPorPagina: PAGE_SIZE,
    SubStatus: [],
    ID_Leiloes_Status: [],
    PaginaIndex: pageNumber,
    BuscaProcesso: "",
    NomesPartes: "",
    CodLeilao: "",
    TiposLeiloes: [],
    PracaAtual: 0,
    DataAbertura: "",
    DataEncerramento: "",
    CamposDinamicos: [
      { NomeFiltro: "QtdPorPagina", Valor: PAGE_SIZE },
      { NomeFiltro: "Ordem", Valor: 5 }
    ],
    Filtro: {}
  };
}

/**
 * Falha de acesso à API de busca (rede, HTTP não 2xx, bloqueio/desafio anti-bot, corpo não JSON).
 * Só esse tipo de falha aciona o fallback por navegador; estrutura irreconhecível propaga direto.
 */
class MglAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MglAccessError";
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/^\[mgl\]\s*/, "");
}

function looksLikeCloudflareBlock(raw: string): boolean {
  return /you have been blocked|sorry, you have been blocked|cf-error-details/i.test(raw);
}

function describeBlock(raw: string): string {
  if (looksLikeCloudflareBlock(raw)) return " (bloqueio Cloudflare: \"Sorry, you have been blocked\")";
  if (looksLikeCloudflareChallenge(raw)) return " (desafio anti-bot Cloudflare)";
  return "";
}

async function fetchPageDirect(pageNumber: number, signal?: AbortSignal): Promise<EndpointResponse> {
  const url = buildSearchUrl(pageNumber);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: DIRECT_HEADERS,
      body: JSON.stringify(buildRequestBody(pageNumber)),
      signal
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new MglAccessError(`[mgl] Falha de rede na API de busca (página ${pageNumber}): ${errorMessage(error)}`);
  }

  return {
    ok: response.ok,
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
    raw: await response.text()
  };
}

/**
 * Valida a resposta da API de busca. Lança `MglAccessError` para bloqueio/HTTP/corpo não JSON e
 * `Error` para JSON sem a lista "Lotes" (estrutura mudou).
 */
function parseSearchPayload(response: EndpointResponse, pageNumber: number, via: string): MglApiResponse {
  const preview = normalizeSpace(response.raw).slice(0, 120) || "corpo vazio";

  if (!response.ok) {
    throw new MglAccessError(
      `[mgl] API de busca respondeu HTTP ${response.status}${describeBlock(response.raw)} na página ${pageNumber} via ${via}.`
    );
  }

  const payload = tryParseResponse(response.raw);
  if (!payload) {
    throw new MglAccessError(
      `[mgl] API de busca respondeu sem JSON válido${describeBlock(response.raw)} na página ${pageNumber} via ${via} ` +
        `(content-type: ${response.contentType || "ausente"}): ${preview}`
    );
  }

  if (!Array.isArray(payload.Lotes)) {
    throw new Error(`[mgl] Resposta inesperada da API de busca (sem lista "Lotes") na página ${pageNumber} via ${via}: ${preview}`);
  }

  return payload;
}

function tryParseResponse(raw: string): MglApiResponse | null {
  const normalized = raw.trim();

  // Alguns backends prefixam payload JSON com anti-JSON-hijacking.
  const maybePrefixed = normalized.startsWith(")]}',")
    ? normalized.slice(5).trim()
    : normalized;

  try {
    const parsed = JSON.parse(maybePrefixed) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as MglApiResponse;
  } catch {
    return null;
  }
}

function parseTotalPages(payload: MglApiResponse): number {
  const pages = Array.isArray(payload.Paginacao?.Paginas) ? payload.Paginacao?.Paginas ?? [] : [];
  const max = pages
    .map((item) => Number(item?.Pagina ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((acc, value) => (value > acc ? value : acc), 1);

  if (max > 1) return max;

  const count = Array.isArray(payload.Lotes) ? payload.Lotes.length : 0;
  if (count >= PAGE_SIZE) return 2;
  return 1;
}

function parseMoney(value: number | null | undefined): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function formatMoneyRaw(value: number | null): string | null {
  if (value == null) return null;
  return `R$ ${value.toLocaleString("pt-BR")}`;
}

function toAbsoluteLotUrl(value: string | null | undefined): string {
  const raw = normalizeSpace(value);
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  const cleaned = raw.startsWith("/") ? raw.slice(1) : raw;
  return `${BASE_URL}/${cleaned}`;
}

function toImageUrl(fileName: string | null | undefined): string {
  const raw = normalizeSpace(fileName);
  if (!raw) return "";
  if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
  return `${BASE_URL}/imagens-center/279x202/${raw}`;
}

function parseYear(raw: string): number | null {
  const modelYearMatch = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:19|20)?\d{2}\b/);
  if (modelYearMatch) {
    return Number.parseInt(modelYearMatch[1] ?? "", 10);
  }

  const years = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)];
  if (years.length === 0) return null;

  const parsed = Number.parseInt(years[0]?.[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

const BRAND_ALIASES: Record<string, string> = {
  VW: "VOLKSWAGEN",
  VOLKS: "VOLKSWAGEN",
  CHEV: "CHEVROLET",
  GM: "CHEVROLET",
  "M BENZ": "MERCEDES-BENZ",
  "MERCEDES BENZ": "MERCEDES-BENZ"
};

function normalizeBrandToken(raw: string): string {
  const cleaned = normalizeAlpha(raw)
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return BRAND_ALIASES[cleaned] ?? cleaned;
}

function cleanupVehicleTitle(raw: string): string {
  const normalized = normalizeSpace(raw);
  if (!normalized) return "";

  const parts = normalized.split(/\s+-\s+/).map((part) => normalizeSpace(part)).filter(Boolean);
  if (parts.length <= 1) return normalized;

  const head = parts[0] ?? "";
  const hasCityUfPrefix = /\/[A-Z]{2}$/i.test(head) || /\b[A-Z]{2}\/[A-Z]{2}\b/.test(head);
  const candidate = hasCityUfPrefix ? parts.slice(1).join(" - ") : normalized;

  return candidate
    .replace(/\s+-\s+[A-Z]{1,5}\d{2,8}\s*$/i, "")
    .replace(/\s+-\s+LOTE\s*\d+.*$/i, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseBrandModelFromTitle(rawTitle: string): { brand: string; model: string } {
  const cleaned = cleanupVehicleTitle(rawTitle)
    .replace(/[.,]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) {
    return { brand: "UNKNOWN", model: "SEM MODELO" };
  }

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 0) {
    return { brand: "UNKNOWN", model: cleaned.toUpperCase() || "SEM MODELO" };
  }

  const first = normalizeBrandToken(tokens[0] ?? "");
  const second = normalizeBrandToken(tokens[1] ?? "");
  const dual = normalizeBrandToken(`${tokens[0]} ${tokens[1] ?? ""}`);

  if (BRAND_ALIASES[dual] || (first === "MERCEDES" && second === "BENZ")) {
    const brand = BRAND_ALIASES[dual] ?? "MERCEDES-BENZ";
    const model = tokens.slice(2).join(" ").trim();
    return {
      brand,
      model: (model || cleaned).toUpperCase()
    };
  }

  const model = tokens.slice(1).join(" ").trim();
  return {
    brand: first || "UNKNOWN",
    model: (model || cleaned).toUpperCase()
  };
}

function parseDateTime(raw: string | null | undefined): Date | null {
  const text = normalizeSpace(raw);
  if (!text) return null;

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.getFullYear() <= 1901) return null;
  return parsed;
}

function pickAuctionDate(rt: MglRealtime | null): Date | null {
  if (!rt) return null;

  return (
    parseDateTime(rt.DataHoraEncerramentoPrimeiraPraca ?? null) ??
    parseDateTime(rt.DataHoraAberturaPrimeiraPraca ?? null)
  );
}

function pickImageUrls(lot: MglLot): string[] {
  const photos = Array.isArray(lot.Fotos) ? lot.Fotos : [];
  const urls: string[] = [];

  for (const photo of photos) {
    // "Semfoto.jpg" é o placeholder do site para lote sem imagem.
    if (/^semfoto\./i.test(normalizeSpace(photo?.Foto))) continue;
    const url = toImageUrl(photo?.Foto ?? null);
    if (!url) continue;
    if (!urls.includes(url)) urls.push(url);
  }

  return urls;
}

function pickPrice(lot: MglLot, rt: MglRealtime | null): {
  price: number | null;
  priceRaw: string | null;
  priceLabel: string | null;
} {
  const currentBid = parseMoney(rt?.ValorLanceAtual ?? null);
  if (currentBid != null) {
    return {
      price: currentBid,
      priceRaw: formatMoneyRaw(currentBid),
      priceLabel: "Lance atual"
    };
  }

  const directSale = parseMoney(lot.ValorVendaDireta ?? null);
  if (directSale != null) {
    return {
      price: directSale,
      priceRaw: formatMoneyRaw(directSale),
      priceLabel: "Venda direta"
    };
  }

  const initialBid =
    parseMoney(rt?.ValorMinimoLancePrimeiraPraca ?? null) ??
    parseMoney(lot.ValorInicialPrimeiraPraca ?? null);
  if (initialBid != null) {
    return {
      price: initialBid,
      priceRaw: formatMoneyRaw(initialBid),
      priceLabel: "Lance inicial"
    };
  }

  return { price: null, priceRaw: null, priceLabel: null };
}

function normalizeYard(lot: MglLot): string | null {
  const cityUf = [normalizeSpace(lot.Cidade), normalizeSpace(lot.UF)].filter(Boolean).join("/");
  const addressParts = [
    normalizeSpace(lot.Lote_Endereco),
    normalizeSpace(lot.Lote_Numero),
    normalizeSpace(lot.Lote_Bairro)
  ].filter(Boolean);

  const address = addressParts.join(" ").replace(/\s+,/g, ",").replace(/,{2,}/g, ",").trim();
  const composed = [cityUf, address].filter(Boolean).join(" · ");
  return composed || null;
}

function parseLots(payload: MglApiResponse, log: (msg: string) => void): AuctionVehicle[] {
  const lots = Array.isArray(payload.Lotes) ? payload.Lotes : [];
  const out: AuctionVehicle[] = [];

  for (const lot of lots) {
    const url = toAbsoluteLotUrl(lot.URLlote ?? null);
    if (!url) continue;

    const titleRaw = normalizeSpace(lot.Lote);
    if (!titleRaw) continue;

    const rt = Array.isArray(lot.GetLoteRealTime) && lot.GetLoteRealTime.length > 0
      ? (lot.GetLoteRealTime[0] ?? null)
      : null;

    const { brand, model } = parseBrandModelFromTitle(titleRaw);
    const year = parseYear(titleRaw);
    const priceInfo = pickPrice(lot, rt);
    const appraisal = parseMoney(lot.ValorAvaliacao ?? null);
    const appraisalRaw = formatMoneyRaw(appraisal);
    const imageUrls = pickImageUrls(lot);
    const yard = normalizeYard(lot);
    const status = normalizeSpace(rt?.Lote_SubStatus_Label) || normalizeSpace(rt?.StatusLote);

    const descriptionParts = [
      titleRaw,
      lot.LoteNumero ? `Lote: ${normalizeSpace(lot.LoteNumero)}` : null,
      status || null,
      yard,
      appraisalRaw ? `Avaliação: ${appraisalRaw}` : null
    ].filter(Boolean);

    out.push({
      source: "mgl",
      brand: brand || "UNKNOWN",
      model: model || "SEM MODELO",
      year,
      damage: null,
      price: priceInfo.price,
      priceRaw: priceInfo.priceRaw,
      priceLabel: priceInfo.priceLabel,
      imageUrls,
      description: descriptionParts.join(" · ").slice(0, 260),
      url,
      auctionDate: pickAuctionDate(rt),
      lot: normalizeSpace(lot.LoteNumero) || undefined,
      yard,
      appraisal,
      appraisalRaw,
      fipe: null,
      fipeRaw: null
    });
  }

  log(`[mgl] ${out.length} lote(s) convertido(s) nesta página.`);
  return out;
}

async function fetchPageFromBrowser(page: Page, pageNumber: number): Promise<EndpointResponse> {
  const endpointUrl = buildSearchUrl(pageNumber);
  const requestBody = buildRequestBody(pageNumber);

  return page.evaluate(
    // Sem funções nomeadas aqui dentro: o tsx (esbuild keepNames), usado em produção, as envolve em `__name(...)`,
    // helper que não existe na página e quebrava o evaluate com "ReferenceError: __name is not defined".
    async ({ endpointUrlInput, bodyInput }) => {
      const xsrfPrefix = "XSRF-TOKEN=";
      const xsrfRaw =
        document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith(xsrfPrefix))
          ?.slice(xsrfPrefix.length) ?? "";
      let xsrfFromCookie = xsrfRaw;
      try {
        xsrfFromCookie = decodeURIComponent(xsrfRaw);
      } catch {
        // mantém o valor bruto
      }

      const rvtFromInput =
        (document.querySelector('input[name="__rvt"]') as HTMLInputElement | null)?.value ||
        (document.querySelector('input[name="__RequestVerificationToken"]') as HTMLInputElement | null)?.value ||
        "";
      const rvtFromMeta =
        document.querySelector('meta[name="__rvt"]')?.getAttribute("content") ||
        document.querySelector('meta[name="__RequestVerificationToken"]')?.getAttribute("content") ||
        "";
      const rvtFromWindow = (window as unknown as Record<string, unknown>).__rvt;
      const rvtToken = String(
        (typeof rvtFromWindow === "string" && rvtFromWindow) || rvtFromInput || rvtFromMeta || xsrfFromCookie
      ).trim();

      const headers: Record<string, string> = {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/json; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      };

      if (rvtToken) {
        headers.__rvt = rvtToken;
        headers["X-XSRF-TOKEN"] = rvtToken;
      }

      const response = await fetch(endpointUrlInput, {
        method: "POST",
        headers,
        credentials: "include",
        body: JSON.stringify(bodyInput)
      });

      return {
        ok: response.ok,
        status: response.status,
        contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
        raw: await response.text()
      };
    },
    {
      endpointUrlInput: endpointUrl,
      bodyInput: requestBody
    }
  );
}

function isJsonEndpointResponse(response: EndpointResponse): boolean {
  return response.ok && tryParseResponse(response.raw) != null;
}

async function fetchPageFromBrowserWithRetry(
  page: Page,
  pageNumber: number,
  log: (msg: string) => void,
  signal?: AbortSignal,
  attempts = 3
): Promise<EndpointResponse> {
  let lastResponse: EndpointResponse | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    signal?.throwIfAborted();
    const response = await fetchPageFromBrowser(page, pageNumber);
    lastResponse = response;

    if (isJsonEndpointResponse(response)) {
      return response;
    }

    // Bloqueio WAF ("you have been blocked") não se resolve esperando.
    if (looksLikeCloudflareBlock(response.raw)) {
      return response;
    }

    if (looksLikeCloudflareChallenge(response.raw)) {
      log(`[mgl] Página ${pageNumber} via navegador com desafio anti-bot (tentativa ${attempt}/${attempts}).`);
      await page.waitForTimeout(2_500);
      continue;
    }

    if (!response.ok) {
      log(`[mgl] Página ${pageNumber} via navegador retornou HTTP ${response.status} (tentativa ${attempt}/${attempts}).`);
      await page.waitForTimeout(1_250);
      continue;
    }

    // Resposta inesperada (HTTP 200 sem JSON válido).
    const snippet = normalizeSpace(response.raw).slice(0, 160);
    log(
      `[mgl] Página ${pageNumber} via navegador sem JSON válido (tentativa ${attempt}/${attempts})` +
      (snippet ? ` | trecho: ${snippet}` : "")
    );
    await page.waitForTimeout(1_250);
  }

  if (lastResponse) return lastResponse;
  throw new Error(`[mgl] falha ao carregar página ${pageNumber} via navegador`);
}

async function readPageHtml(page: Page): Promise<string> {
  return page.content().catch(() => "");
}

/** UA de navegador comum com a mesma versão principal do Chromium em uso (coerente com o sec-ch-ua). */
function buildBrowserUserAgent(browserVersion: string): string {
  const major = Number.parseInt(browserVersion.split(".")[0] ?? "", 10);
  if (!Number.isFinite(major) || major < 100) return USER_AGENT;
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

/**
 * Pagina a API de busca a partir de uma função que traz cada página (HTTP direto ou navegador).
 * Falha da página 1 propaga; páginas seguintes com falha são registradas e puladas.
 */
async function collectPages(
  fetchPage: (pageNumber: number) => Promise<EndpointResponse>,
  via: string,
  maxPages: number,
  log: (msg: string) => void,
  signal?: AbortSignal
): Promise<AuctionVehicle[]> {
  const all: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();
  const append = (vehicles: AuctionVehicle[]): void => {
    for (const vehicle of vehicles) {
      if (seenUrls.has(vehicle.url)) continue;
      seenUrls.add(vehicle.url);
      all.push(vehicle);
    }
  };

  const first = parseSearchPayload(await fetchPage(1), 1, via);
  const firstLots = first.Lotes ?? [];
  const countTotal = Number(first.CountTotal ?? 0);

  if (firstLots.length === 0) {
    if (Number.isFinite(countTotal) && countTotal > 0) {
      throw new Error(`[mgl] API informou CountTotal=${countTotal}, mas a página 1 veio sem lotes (via ${via}).`);
    }
    log(`[mgl] Nenhum lote de veículo publicado (via ${via}).`);
    return [];
  }

  append(parseLots(first, log));
  if (all.length === 0) {
    throw new Error(
      `[mgl] ${firstLots.length} lote(s) recebido(s) na página 1 via ${via}, mas nenhum reconhecido (estrutura da API mudou?).`
    );
  }

  const totalPagesDetected = parseTotalPages(first);
  const totalPagesToRead = Math.max(1, Math.min(totalPagesDetected, maxPages));
  log(
    `[mgl] Página(s) via ${via}: total=${totalPagesDetected} | limite=${maxPages} | varrendo=${totalPagesToRead}` +
      (Number.isFinite(countTotal) && countTotal > 0 ? ` | CountTotal=${countTotal}.` : ".")
  );

  for (let pageNumber = 2; pageNumber <= totalPagesToRead; pageNumber += 1) {
    await sleep(REQUEST_DELAY_MS);
    signal?.throwIfAborted();

    try {
      append(parseLots(parseSearchPayload(await fetchPage(pageNumber), pageNumber, via), log));
    } catch (error) {
      if (signal?.aborted) throw error;
      // Falha parcial: mantém o que já foi coletado e segue para a próxima página.
      log(`[mgl] Falha página ${pageNumber}: ${errorMessage(error)}`);
    }
  }

  log(`[mgl] Total via ${via}: ${all.length} veículo(s).`);
  return all;
}

async function scrapeViaBrowser(
  maxPages: number,
  headless: boolean,
  log: (msg: string) => void,
  signal?: AbortSignal
): Promise<AuctionVehicle[]> {
  const launchOptions = buildPlaywrightLaunchOptions(headless);
  const persistentProfileDir = parsePersistentProfileDir();
  const manualChallengeWaitMs = parseManualChallengeWaitMs();

  let context:
    | Awaited<ReturnType<typeof chromium.launchPersistentContext>>
    | Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launch>>["newContext"]>>
    | null = null;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  // Timeout do runner aborta o signal: fecha o Chromium para não deixar a tentativa pendurada.
  const onAbort = (): void => {
    void context?.close().catch(() => undefined);
    void browser?.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    signal?.throwIfAborted();

    if (persistentProfileDir) {
      log(`[mgl] Usando perfil persistente do navegador: ${persistentProfileDir}`);
      context = await chromium.launchPersistentContext(persistentProfileDir, {
        ...launchOptions,
        userAgent: USER_AGENT,
        locale: "pt-BR"
      });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext({
        userAgent: buildBrowserUserAgent(browser.version()),
        locale: "pt-BR"
      });
    }

    // O script passivo de detecção de bots do Cloudflare (JSD) marca o Chromium headless (cookie cf_clearance) e a
    // API passa a responder 403 "Sorry, you have been blocked" nas chamadas seguintes. A busca não precisa dele,
    // nem de imagens, fontes ou CSS.
    await context.route("**/*", (route) => {
      const request = route.request();
      if (BROWSER_BLOCKED_RESOURCES.has(request.resourceType()) || request.url().includes(CLOUDFLARE_JSD_PATH)) {
        return route.abort();
      }
      return route.continue();
    });

    const page = context.pages()[0] ?? await context.newPage();

    // O UA padrão "HeadlessChrome" e o TLS do Node recebem bloqueio WAF; a página de busca com UA comum passa.
    log("[mgl] Abrindo sessão navegador em /comprar/...");
    const navigation = await page.goto(`${BASE_URL}/comprar/`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });

    let html = await readPageHtml(page);
    if (looksLikeCloudflareBlock(html)) {
      throw new Error(
        `Cloudflare bloqueou o navegador em /comprar/ (HTTP ${navigation?.status() ?? "?"}, "Sorry, you have been blocked"). ` +
          "Provável bloqueio do IP de saída."
      );
    }

    if (looksLikeCloudflareChallenge(html)) {
      if (!headless) {
        const seconds = Math.round(manualChallengeWaitMs / 1000);
        log(`[mgl] Desafio anti-bot detectado. Aguardando resolução manual por até ${seconds}s...`);
        await page.bringToFront().catch(() => undefined);
        await page.waitForTimeout(manualChallengeWaitMs);
      } else {
        log("[mgl] Desafio anti-bot detectado. Tentando validação automática...");
        await page.waitForTimeout(8_000);
      }

      signal?.throwIfAborted();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);

      html = await readPageHtml(page);
      if (looksLikeCloudflareChallenge(html) || looksLikeCloudflareBlock(html)) {
        throw new Error(
          "Cloudflare ainda bloqueando após tentativa de validação. " +
            "Use HEADLESS=false e, se possível, configure MGL_USER_DATA_DIR para reaproveitar sessão."
        );
      }
    }

    return await collectPages(
      (pageNumber) => fetchPageFromBrowserWithRetry(page, pageNumber, log, signal),
      "navegador",
      maxPages,
      log,
      signal
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await context?.close().catch(() => undefined);
    if (browser) {
      await browser.close().catch(() => undefined);
    }
  }
}

export type MglBrowserFallback = (input: {
  maxPages: number;
  headless: boolean;
  log: (msg: string) => void;
  signal?: AbortSignal;
}) => Promise<AuctionVehicle[]>;

export async function scrapeMgl(
  _filters: AuctionFilters,
  options?: {
    headless?: boolean;
    log?: (msg: string) => void;
    signal?: AbortSignal;
    /** `false` desativa o fallback Playwright (ex.: testes); uma função substitui a coleta via navegador. */
    browserFallback?: false | MglBrowserFallback;
  }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const headless = options?.headless ?? true;
  const signal = options?.signal;
  const maxPages = parseMaxPagesFromEnv();
  const browserFallback: MglBrowserFallback | null =
    options?.browserFallback === false
      ? null
      : options?.browserFallback ??
        ((input) => scrapeViaBrowser(input.maxPages, input.headless, input.log, input.signal));

  log("[mgl] Iniciando...");
  signal?.throwIfAborted();

  // O Cloudflare do MGL bloqueia o fingerprint TLS do Node (HTTP 403 "Sorry, you have been blocked")
  // mesmo de IP residencial; o HTTP direto fica como caminho rápido e o navegador como caminho principal.
  let directFailure: string;
  try {
    return await collectPages((pageNumber) => fetchPageDirect(pageNumber, signal), "HTTP", maxPages, log, signal);
  } catch (error) {
    // Estrutura irreconhecível ou cancelamento: o navegador consultaria a mesma API, então propaga.
    if (signal?.aborted || !(error instanceof MglAccessError)) throw error;
    directFailure = errorMessage(error);
  }

  if (!browserFallback) {
    throw new Error(`[mgl] ${directFailure} Fallback por navegador desativado.`);
  }

  log(`[mgl] HTTP direto indisponível (${directFailure}). Tentando navegador...`);

  try {
    return await browserFallback({ maxPages, headless, log, signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    // Falha total não pode virar "0 encontrados": propaga os dois motivos.
    throw new Error(`[mgl] HTTP direto falhou (${directFailure}) e o navegador também falhou: ${errorMessage(error)}`);
  }
}
