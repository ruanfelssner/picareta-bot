import { load } from "cheerio";
import type { RawScrapedVehicle, ScraperOptions, ScraperSource } from "../source-types.js";
import {
  describeResponseBody,
  openBrowserTransport,
  type BrowserTransport
} from "../browser-transport.js";

const BASE = "https://www.favaretoleiloes.com.br";
const LEILOES_URL = "https://www.favaretoleiloes.com.br/leiloes/";
const API_URL = `${BASE}/classes/json_lance.php`;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

type LotApiResponse = {
  grupo?: string;
  veiculo: string;
  ano: string;
  cor: string;
  combustivel: string;
  km: string | number;
  minimo: string;
  numlote: string;
  tipo: string;
  bem: string;
  ordem: string;
  data: string;
  obs: string;
  path_foto: string;
  foto0?: string; foto1?: string; foto2?: string;
  foto3?: string; foto4?: string; foto5?: string;
  foto6?: string; foto7?: string; foto8?: string;
  qtde: number;
  stl?: string | number;
};

type LotHistoryResponse = {
  top_lance?: string | null;
  lance_atual?: string | number | null;
  of1?: string | null;
  tem_lance?: string | number | null;
  stl?: string | number | null;
};

// Páginas de desafio/bloqueio (Cloudflare/WAF). Não incluir "captcha": o site legítimo carrega reCAPTCHA.
const BLOCK_PAGE_RE = /just a moment|_cf_chl_opt|cf-chl-|cf-browser-verification|attention required|access denied/i;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** HTTP direto (fetch do Node) ou Chromium real quando o WAF recusa/esvazia o HTTP direto. */
type FavaretoTransport = {
  via: "HTTP" | "navegador";
  html: (url: string) => Promise<string>;
  post: (url: string, referer: string, body: string) => Promise<{ status: number; text: string }>;
};

function checkHtml(url: string, status: number, html: string): string {
  const blocked = BLOCK_PAGE_RE.test(html);
  if (status < 200 || status > 299) throw new Error(`[favareto] HTTP ${status} em ${url}${blocked ? " (bloqueio anti-bot)" : ""}`);
  if (blocked) throw new Error(`[favareto] Página de bloqueio anti-bot em ${url} (${describeResponseBody(html)})`);
  return html;
}

// O site serve HTML em ISO-8859-1 sem charset no header; res.text() corromperia os acentos.
function httpTransport(signal?: AbortSignal): FavaretoTransport {
  return {
    via: "HTTP",
    html: async (url) => {
      let res: Response;
      try {
        res = await fetch(url, { headers: HEADERS, signal });
      } catch (err) {
        throw new Error(`[favareto] Falha de rede em ${url}: ${errorMessage(err)}`);
      }
      return checkHtml(url, res.status, new TextDecoder("windows-1252").decode(await res.arrayBuffer()));
    },
    post: async (url, referer, body) => {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": referer,
          "User-Agent": HEADERS["User-Agent"],
          "X-Requested-With": "XMLHttpRequest"
        },
        body,
        signal
      });
      return { status: res.status, text: await res.text() };
    }
  };
}

function browserTransport(browser: BrowserTransport): FavaretoTransport {
  return {
    via: "navegador",
    html: async (url) => {
      const res = await browser.request(url, { charset: "windows-1252" });
      return checkHtml(url, res.status, res.body);
    },
    post: async (url, _referer, body) => {
      const res = await browser.request(url, {
        method: "POST",
        body,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" }
      });
      return { status: res.status, text: res.body };
    }
  };
}

async function postJson<T>(transport: FavaretoTransport, url: string, editalId: number, seq: number, body: string): Promise<T> {
  const { status, text } = await transport.post(url, `${BASE}/lance/${editalId}/${seq}/`, body);
  if (status < 200 || status > 299) throw new Error(`HTTP ${status}${BLOCK_PAGE_RE.test(text) ? " (bloqueio anti-bot)" : ""}`);
  try {
    const data = JSON.parse(text.trim());
    if (!data || typeof data !== "object") throw new Error("JSON inesperado");
    return data as T;
  } catch {
    throw new Error(`resposta não é JSON${BLOCK_PAGE_RE.test(text) ? " (bloqueio anti-bot)" : ""}: ${normalizeSpace(text).slice(0, 80)}`);
  }
}

async function fetchLotDetails(transport: FavaretoTransport, editalId: number, seq: number): Promise<LotApiResponse> {
  const lot = await postJson<LotApiResponse>(transport, API_URL, editalId, seq, `ordem=${seq}&leilao=${editalId}`);
  if (!lot.veiculo && !lot.bem) throw new Error("lote sem veiculo/bem no JSON");
  return lot;
}

async function fetchLotHistory(
  transport: FavaretoTransport,
  editalId: number,
  seq: number,
  lotDate: string
): Promise<LotHistoryResponse | null> {
  try {
    const params = new URLSearchParams({
      seq: String(seq),
      data: String(editalId),
      dataleilao: String(lotDate ?? "")
    });
    return await postJson<LotHistoryResponse>(transport, `${BASE}/classes/json_historico.php`, editalId, seq, params.toString());
  } catch {
    // Histórico é opcional: sem ele o preço cai para lance do edital/mínimo.
    return null;
  }
}

function parseEditalId(url: string): number | null {
  const m = url.match(/\/edital\/(\d+)/);
  return m ? parseInt(m[1]!, 10) : null;
}

function parseYear(text: string): number | null {
  const m = text.match(/\b((?:19|20)\d{2})\/(?:19|20)\d{2}\b/);
  return m ? parseInt(m[1]!, 10) : null;
}

function parsePrice(rawValue: string | number | null | undefined): number | null {
  if (rawValue == null) return null;
  let raw = String(rawValue).trim();
  if (!raw) return null;

  raw = raw.replace(/\u00a0/g, " ").replace(/R\$\s*/gi, "").trim();
  if (!raw) return null;

  if (raw.includes(",") && raw.includes(".")) {
    // "38.400,00"
    raw = raw.replace(/\./g, "").replace(",", ".");
  } else if (raw.includes(",")) {
    // "38400,00"
    raw = raw.replace(",", ".");
  } else {
    // "38.400" (milhar) vs "38400.00" (decimal)
    const dots = (raw.match(/\./g) ?? []).length;
    if (dots > 1) {
      raw = raw.replace(/\./g, "");
    } else if (dots === 1) {
      const [left, right] = raw.split(".");
      if ((right?.length ?? 0) === 3) {
        raw = `${left}${right}`;
      }
    }
  }

  raw = raw.replace(/[^\d.-]/g, "");
  if (!raw) return null;

  const numeric = Number.parseFloat(raw);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.round(numeric);
}

function pickLotPrice(
  lot: LotApiResponse,
  history: LotHistoryResponse | null,
  editalBidRaw: string | null
): { price: number | null; priceRaw: string | null; priceLabel: string | null } {
  const fromHistory =
    parsePrice(history?.top_lance) ??
    parsePrice(history?.lance_atual) ??
    parsePrice(history?.of1);
  if (fromHistory != null) {
    return {
      price: fromHistory,
      priceRaw: `R$ ${fromHistory.toLocaleString("pt-BR")}`,
      priceLabel: "Último lance"
    };
  }

  const fromEdital = parsePrice(editalBidRaw);
  if (fromEdital != null) {
    return {
      price: fromEdital,
      priceRaw: `R$ ${fromEdital.toLocaleString("pt-BR")}`,
      priceLabel: "Lance atual"
    };
  }

  const fromMinimo = parsePrice(lot.minimo);
  if (fromMinimo != null) {
    return {
      price: fromMinimo,
      priceRaw: `R$ ${fromMinimo.toLocaleString("pt-BR")}`,
      priceLabel: "Lance inicial"
    };
  }

  return { price: null, priceRaw: null, priceLabel: null };
}

function buildImageUrls(lot: LotApiResponse): string[] {
  const urls: string[] = [];
  const keys: Array<keyof LotApiResponse> = ["foto0","foto1","foto2","foto3","foto4","foto5","foto6","foto7","foto8"];
  const declaredCount = Number(lot.qtde);
  const count = Math.min(
    Number.isFinite(declaredCount) && declaredCount > 0 ? declaredCount : keys.length,
    keys.length
  );
  for (let i = 0; i < count; i++) {
    const fname = lot[keys[i]!] as string | undefined;
    if (!fname?.trim()) continue;
    try {
      const path = String(lot.path_foto ?? '').trim();
      const base = path ? new URL(path.endsWith('/') ? path : `${path}/`, BASE).toString() : `${BASE}/`;
      const photo = fname.trim();
      urls.push(new URL(/^https?:\/\//i.test(photo) ? photo : photo.replace(/^\/+/, ''), base).toString());
    } catch {
      // Uma foto malformada não deve descartar o lote inteiro.
    }
  }
  return urls;
}

function parseAuctionDate(data: string): Date | null {
  // "13/05/2026" or "13/05/26"
  const m = data.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
  if (!m) return null;
  const y = m[3]!.length === 2 ? 2000 + parseInt(m[3]!, 10) : parseInt(m[3]!, 10);
  return new Date(y, parseInt(m[2]!, 10) - 1, parseInt(m[1]!, 10));
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

const FAVARETO_BRAND_ALIASES: Record<string, string> = {
  GM: "CHEVROLET",
  LR: "LAND ROVER"
};

function normalizeFavaretoBrand(raw: string | null | undefined): string {
  const brand = normalizeSpace(raw).toUpperCase();
  return FAVARETO_BRAND_ALIASES[brand] ?? brand;
}

export function parseFavaretoVehicleIdentity(
  raw: string | null | undefined,
  fallbackBrandRaw?: string | null
): { brand: string; model: string } {
  const vehicle = normalizeSpace(raw)
    .replace(/^(?:I|IMPORTADO)(?:\s*\/\s*|\s+)/i, "")
    .replace(/\s*\/\s*/g, "/");

  const [brandPart = "", ...modelParts] = vehicle.split("/");
  const hasBrandSeparator = modelParts.length > 0;
  const fallbackBrand = normalizeFavaretoBrand(fallbackBrandRaw);
  const brand = normalizeFavaretoBrand(brandPart) || fallbackBrand || "UNKNOWN";
  const model = hasBrandSeparator
    ? normalizeSpace(modelParts.join("/"))
    : normalizeSpace(vehicle.split(/\s+/).slice(1).join(" "));

  return { brand, model: model || "SEM MODELO" };
}

function normalizeYardToken(raw: string): string {
  return normalizeSpace(raw)
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s*-\s*/g, " - ")
    .trim();
}

function extractFavaretoYardFromText(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw);
  if (!text) return null;

  const transferMatch =
    text.match(/Transferid[oa]\s+em\s*:?\s*([A-Za-zÀ-ÿ0-9 .()/-]+?)(?=\s*(?:\||·|Lote|Data|Leil[aã]o|$))/i) ??
    text.match(/P[aá]tio\s*:?\s*([A-Za-zÀ-ÿ0-9 .()/-]+?)(?=\s*(?:\||·|Lote|Data|Leil[aã]o|$))/i);
  if (transferMatch?.[1]) {
    return normalizeYardToken(transferMatch[1]);
  }

  const cityUfMatch = text.match(/\b([A-Za-zÀ-ÿ ]{2,})\s*[-/]\s*([A-Z]{2})\b/);
  if (cityUfMatch) {
    return normalizeYardToken(`${cityUfMatch[1]} - ${cityUfMatch[2]}`);
  }

  return null;
}

function extractFavaretoYard(lot: LotApiResponse, row: EditalRow): string | null {
  const fromObs = extractFavaretoYardFromText(lot.obs);
  if (fromObs) return fromObs;

  const fromVehicle = extractFavaretoYardFromText(lot.veiculo);
  if (fromVehicle) return fromVehicle;

  const fromBem = extractFavaretoYardFromText(lot.bem);
  if (fromBem) return fromBem;

  const fromRow = extractFavaretoYardFromText(row.descRaw);
  if (fromRow) return fromRow;

  // Favareto opera com pátio base em Curitiba/PR; mantém filtro geográfico consistente.
  return "Curitiba - PR";
}

// Retorna lista de linhas do edital para cada "tela_lance(...)"
type EditalRow = {
  editalId: number;
  seq: number;
  descRaw: string;
  brandRaw: string;
  editalBidRaw: string | null;
  consignor: string | null;
};

function parseEditalRows(html: string, editalId: number): EditalRow[] {
  const $ = load(html);
  const rows: EditalRow[] = [];
  let consignor: string | null = null;
  const seen = new Set<number>();

  $("table tr").each((_i, tr) => {
    const cells = $(tr).find("td");
    if (cells.length === 1 && cells.eq(0).is('.grupo')) {
      consignor = normalizeSpace(cells.eq(0).text()) || null;
      return;
    }
    if (cells.length < 2) return;

    // Extrai seq do onclick da célula com "Ver Lote"
    const onclick = $(tr).find("a[onclick]").map((_i, el) => $(el).attr("onclick")).get().join(" ");
    const seqM = onclick.match(/tela_lance\(\s*\d+\s*,\s*(\d+)\s*\)/);
    if (!seqM) return;
    const seq = parseInt(seqM[1]!, 10);
    if (seen.has(seq)) return;

    const descRaw = cells.eq(1).text().trim();
    if (!descRaw) return;

    const { brand: brandRaw } = parseFavaretoVehicleIdentity(descRaw);

    const bidRaw = normalizeSpace(cells.eq(6).text());
    const editalBidRaw = bidRaw && !/\*{2,}/.test(bidRaw) ? bidRaw : null;

    seen.add(seq);
    rows.push({ editalId, seq, descRaw, brandRaw, editalBidRaw, consignor });
  });

  return rows;
}

export type FavaretoVehicle = RawScrapedVehicle & { priceLabel: string | null };
export interface FavaretoScraperOptions extends ScraperOptions {
  browserFallback?: false | typeof openBrowserTransport;
}

export async function runFavaretoScraper(options?: FavaretoScraperOptions): Promise<FavaretoVehicle[]> {
  const log = options?.log ?? console.log;
  const signal = options?.signal;
  let httpProblem: string;
  try {
    const vehicles = await collectFavareto(httpTransport(signal), log, signal);
    if (vehicles.length) return vehicles;
    httpProblem = "HTTP direto não trouxe veículos";
  } catch (err) {
    if (signal?.aborted) throw err;
    httpProblem = errorMessage(err);
  }
  // Recupera pelo navegador quando HTTP direto falha ou entrega uma listagem sem lotes reconhecíveis.
  signal?.throwIfAborted();
  if (options?.browserFallback === false) throw new Error(`[favareto] ${httpProblem}. Fallback por navegador desativado.`);
  log(`[favareto] ${httpProblem}; repetindo a coleta pelo navegador.`);
  let browser: BrowserTransport | undefined;
  try {
    browser = await (options?.browserFallback ?? openBrowserTransport)({ warmupUrl: LEILOES_URL, headless: options?.headless ?? true, signal, log });
    return await collectFavareto(browserTransport(browser), log, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(`[favareto] HTTP direto falhou (${httpProblem}) e o navegador também falhou: ${errorMessage(err)}`);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

async function collectFavareto(
  transport: FavaretoTransport,
  log: (msg: string) => void,
  signal?: AbortSignal
): Promise<FavaretoVehicle[]> {
  const assertNotAborted = () => {
    if (signal?.aborted) throw new Error("[favareto] Coleta interrompida.");
  };
  log(`[scraper:favareto] iniciando (${transport.via})`);
  assertNotAborted();

  // Falha total da listagem lança erro; antes virava "0 encontrados" silencioso.
  const leiloesHtml = await transport.html(LEILOES_URL);

  const $ = load(leiloesHtml);
  const editalUrls: string[] = [];
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    try {
      const url = new URL(href, `${BASE}/`);
      const id = parseEditalId(url.pathname);
      if (url.origin !== BASE || !id) return;
      const canonical = `${BASE}/edital/${id}/`;
      if (!editalUrls.includes(canonical)) editalUrls.push(canonical);
    } catch { /* Link inválido não representa um edital. */ }
  });

  if (editalUrls.length === 0) {
    // Sem editais não é possível confirmar o catálogo; aciona o navegador e preserva o diagnóstico.
    throw new Error(`[favareto] Nenhum edital em ${LEILOES_URL} via ${transport.via} (${describeResponseBody(leiloesHtml)}).`);
  }
  log(`[favareto] ${editalUrls.length} edital(is): ${editalUrls.join(", ")}`);

  const allResults: FavaretoVehicle[] = [];
  const seenKeys = new Set<string>();
  const editalErrors: string[] = [];
  let editaisOk = 0;
  let totalRows = 0;
  let lotFailures = 0;
  let lastLotError = "";

  for (const editalUrl of editalUrls) {
    assertNotAborted();
    const editalId = parseEditalId(editalUrl);
    if (!editalId) continue;

    let editalHtml: string;
    try {
      editalHtml = await transport.html(editalUrl);
    } catch (err) {
      editalErrors.push(errorMessage(err));
      log(errorMessage(err));
      continue;
    }

    const rows = parseEditalRows(editalHtml, editalId);
    if (rows.length === 0) {
      const msg = `[favareto] edital ${editalId}: nenhum lote reconhecido em ${editalUrl} via ${transport.via} (${describeResponseBody(editalHtml)}).`;
      editalErrors.push(msg);
      log(msg);
      continue;
    }
    editaisOk++;
    totalRows += rows.length;
    log(`[favareto] edital ${editalId}: ${rows.length} lote(s) total.`);

    for (const row of rows) {
      assertNotAborted();
      let lot: LotApiResponse;
      try {
        lot = await fetchLotDetails(transport, row.editalId, row.seq);
      } catch (err) {
        lotFailures++;
        lastLotError = errorMessage(err);
        if (lotFailures <= 3) log(`[favareto] lote ${row.editalId}/${row.seq}: ${lastLotError}`);
        // API recusando desde o início: desiste cedo para sobrar tempo ao navegador.
        if (lotFailures >= 5 && allResults.length === 0) {
          throw new Error(`[favareto] API de lotes falhou nos ${lotFailures} primeiros lote(s) via ${transport.via}: ${lastLotError}`);
        }
        continue;
      }
      const history = await fetchLotHistory(transport, row.editalId, row.seq, lot.data);
      assertNotAborted();

      const year = parseYear(lot.ano);
      const priceInfo = pickLotPrice(lot, history, row.editalBidRaw);

      // Marca/modelo do JSON da API (mais completo que o edital)
      const identity = parseFavaretoVehicleIdentity(lot.veiculo, row.brandRaw);

      const imageUrls = buildImageUrls(lot);

      const kmRaw = lot.km ? String(lot.km).replace(/\D/g, "") : null;
      const kmFormatted = kmRaw ? Number(kmRaw).toLocaleString("pt-BR") : null;

      const desc = [lot.obs || null]
        .filter(Boolean)
        .join(" ")
        .slice(0, 200);
      const yard = extractFavaretoYard(lot, row);

      const lotUrl = `${BASE}/lance/${row.editalId}/${row.seq}/`;
      const key = lotUrl;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      allResults.push({
        source: "favareto",
        brand: identity.brand,
        model: identity.model,
        year,
        damage: null,
        price: priceInfo.price,
        priceRaw: priceInfo.priceRaw,
        priceLabel: priceInfo.priceLabel,
        imageUrls,
        description: desc,
        url: lotUrl,
        auctionDate: parseAuctionDate(lot.data),
        auctionUrl: editalUrl,
        auctionId: String(row.editalId),
        lot: normalizeSpace(lot.numlote) || String(row.seq),
        consignor: normalizeSpace(lot.grupo) || row.consignor,
        fuel: normalizeSpace(lot.combustivel) || null,
        fipe: null,
        km: kmFormatted,
        color: lot.cor || null,
        yard
      });

      // Pausa entre chamadas à API
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  if (editaisOk === 0 && editalErrors.length > 0) {
    throw new Error(`[favareto] Nenhum edital pôde ser lido: ${editalErrors.join(" | ")}`);
  }
  if (totalRows > 0 && lotFailures === totalRows) {
    throw new Error(`[favareto] API de lotes falhou em todos os ${totalRows} lote(s): ${lastLotError}`);
  }
  if (lotFailures > 0) log(`[favareto] ${lotFailures}/${totalRows} lote(s) ignorado(s) por falha na API.`);

  log(`[scraper:favareto] finalizado: ${allResults.length} veículo(s).`);
  return allResults;
}

export const favaretoSource: ScraperSource = {
  id: 'favareto',
  name: 'Favareto Leilões',
  run: (_filters, options) => runFavaretoScraper(options),
};
