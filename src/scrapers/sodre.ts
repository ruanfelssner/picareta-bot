import { chromium } from "playwright";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";

const SEARCH_URL = "https://www.sodresantoro.com.br/veiculos/lotes?lot_category=carros";
const API_URL = "https://www.sodresantoro.com.br/api/search-lots";
const LOT_BASE = "https://leilao.sodresantoro.com.br/leilao";
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

type SodreItem = {
  lot_id: number;
  auction_id: number;
  lot_brand: string;
  lot_model: string;
  lot_year_manufacture: number;
  lot_year_model: number;
  lot_sinister: string;
  bid_actual: string;
  lot_pictures: string[];
  lot_description: string;
  lot_km: number;
  lot_color: string;
  auction_date_init: string;
  [key: string]: unknown;
};

type SodrePayloadOptions = {
  includeLocationCategoryFilter: boolean;
  from: number;
};

function buildPayload(options: SodrePayloadOptions): object {
  const filterClauses: object[] = [];

  if (options.includeLocationCategoryFilter) {
    filterClauses.push(
      { terms: { lot_category: ["carros"] } }
    );
  }

  return {
    indices: ["veiculos", "judiciais-veiculos"],
    query: {
      bool: {
        filter: [
          {
            bool: {
              should: [
                { bool: { must: [{ term: { auction_status: "online" } }] } },
                { bool: { must: [{ term: { auction_status: "aberto" } }], must_not: [{ terms: { lot_status_id: [5, 7] } }] } },
                { bool: { must: [{ term: { auction_status: "encerrado" } }, { terms: { lot_status_id: [6] } }] } }
              ],
              minimum_should_match: 1
            }
          },
          {
            bool: {
              should: [
                { bool: { must_not: { term: { lot_status_id: 6 } } } },
                { bool: { must: [{ term: { lot_status_id: 6 } }, { term: { segment_id: 1 } }] } }
              ],
              minimum_should_match: 1
            }
          },
          { bool: { should: [{ bool: { must_not: [{ term: { lot_test: true } }] } }], minimum_should_match: 1 } }
        ]
      }
    },
    post_filter: {
      bool: {
        filter: filterClauses
      }
    },
    from: options.from,
    size: PAGE_SIZE,
    sort: [
      { lot_status_id_order: { order: "asc" } },
      { auction_date_init: { order: "asc" } }
    ]
  };
}

function buildLotLookupPayload(input: { auctionId: number; lotId: number }): object {
  return {
    indices: ["veiculos", "judiciais-veiculos"],
    query: {
      bool: {
        filter: [
          { term: { auction_id: input.auctionId } },
          { term: { lot_id: input.lotId } },
          { bool: { should: [{ bool: { must_not: [{ term: { lot_test: true } }] } }], minimum_should_match: 1 } }
        ]
      }
    },
    from: 0,
    size: 5
  };
}

export function parseSodreLotUrl(rawUrl: string): { auctionId: number; lotId: number; canonicalUrl: string } | null {
  const text = rawUrl.trim();
  if (!text) return null;

  let pathname = text;
  try {
    const parsed = new URL(text);
    pathname = parsed.pathname;
  } catch {
    // aceita também caminho puro colado manualmente
  }

  const match = pathname.match(/\/leilao\/(\d+)\/(?:lote|lotes-encerrados)\/(\d+)/i);
  if (!match) return null;

  const auctionId = Number(match[1]);
  const lotId = Number(match[2]);
  if (!Number.isFinite(auctionId) || !Number.isFinite(lotId)) return null;

  return {
    auctionId,
    lotId,
    canonicalUrl: `${LOT_BASE}/${auctionId}/lote/${lotId}/`
  };
}

function parsePrice(bidActual: string): number | null {
  const n = parseFloat(bidActual);
  return isNaN(n) || n <= 0 ? null : Math.round(n);
}

function parseDate(dateStr: string): Date | null {
  const m = dateStr?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function extractYardFromDescription(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw);
  if (!text) return null;

  const match = text.match(
    /(?:Local(?:iza(?:ção|cao)\s+do\s+lote| do lote)?|P[aá]tio)\s*:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)(?=\s+(?:Lance|Leil[aã]o|Situa[cç][aã]o|Status)\b|$)/i
  );
  return match?.[1]?.trim() || null;
}

function extractSodreYard(item: SodreItem): string | null {
  const dynamic = item as Record<string, unknown>;
  const candidateKeys = [
    "lot_location",
    "lot_local",
    "lot_locality",
    "lot_city",
    "lot_state",
    "yard",
    "yard_name",
    "auction_place",
    "auction_location",
    "deposito"
  ];

  for (const key of candidateKeys) {
    const value = dynamic[key];
    if (typeof value !== "string") continue;
    const cleaned = normalizeSpace(value);
    if (cleaned) return cleaned;
  }

  const city = normalizeSpace(typeof dynamic.lot_city === "string" ? dynamic.lot_city : "");
  const state = normalizeSpace(typeof dynamic.lot_state === "string" ? dynamic.lot_state : "");
  if (city && state && !city.toUpperCase().includes(state.toUpperCase())) {
    return `${city} - ${state}`;
  }

  return extractYardFromDescription(item.lot_description);
}

function mapSodreItemToAuctionVehicle(item: SodreItem, log?: (msg: string) => void): AuctionVehicle {
  const brandRaw = (item.lot_brand ?? "").trim();
  const matchedBrand = brandRaw || null;
  const year = item.lot_year_model ?? item.lot_year_manufacture ?? null;
  const price = parsePrice(item.bid_actual);
  const modelRaw = (item.lot_model ?? "").trim();
  const damage = item.lot_sinister?.trim() || null;
  const priceRaw = price !== null ? `R$ ${price.toLocaleString("pt-BR")}` : null;
  const kmNum = typeof item.lot_km === "number" ? item.lot_km : parseInt(String(item.lot_km ?? 0), 10);
  const kmFormatted = kmNum > 0 ? kmNum.toLocaleString("pt-BR") : null;
  log?.(`[sodre] ${matchedBrand ?? "UNKNOWN"} ${modelRaw} — km=${kmNum} cor=${item.lot_color ?? "?"} preço=${price}`);
  const color = capitalize(item.lot_color ?? "") || null;
  const auctionDate = parseDate(item.auction_date_init);
  const imageUrls = (item.lot_pictures ?? [])
    .filter((u) => u?.startsWith("http"))
    .slice(0, 4);
  const yard = extractSodreYard(item);
  const description = (item.lot_description ?? "")
    .replace(/\r\n/g, " ")
    .trim()
    .slice(0, 200);
  const lotUrl = `${LOT_BASE}/${item.auction_id}/lote/${item.lot_id}/`;

  return {
    source: "sodre",
    brand: (matchedBrand ?? "UNKNOWN").trim() || "UNKNOWN",
    model: modelRaw,
    year,
    damage,
    price,
    priceRaw,
    imageUrls,
    description,
    url: lotUrl,
    auctionDate,
    km: kmFormatted,
    color,
    yard,
    lot: String(item.lot_id)
  };
}

async function fetchSodreApiItems(
  payload: object,
  options: { headless: boolean; log: (msg: string) => void }
): Promise<SodreItem[]> {
  const browser = await chromium.launch(buildPlaywrightLaunchOptions(options.headless));
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR"
  });
  const page = await context.newPage();

  try {
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const result = await page.evaluate(
      async ({ url, body }: { url: string; body: object }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) return { error: res.status, results: [] };
        return res.json();
      },
      { url: API_URL, body: payload }
    ) as { error?: number; results?: SodreItem[] };

    if (result.error) {
      options.log(`[sodre] API retornou erro: HTTP ${result.error}`);
      return [];
    }
    return result.results ?? [];
  } finally {
    await browser.close();
  }
}

export async function fetchSodreVehicleByUrl(
  url: string,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle | null> {
  const log = options?.log ?? console.log;
  const parsed = parseSodreLotUrl(url);
  if (!parsed) return null;

  const headless = options?.headless ?? true;
  log(`[sodre] Buscando lote por URL: leilao=${parsed.auctionId} lote=${parsed.lotId}`);
  const items = await fetchSodreApiItems(buildLotLookupPayload(parsed), { headless, log });
  const item = items.find((candidate) =>
    Number(candidate.lot_id) === parsed.lotId && Number(candidate.auction_id) === parsed.auctionId
  ) ?? items[0] ?? null;

  return item ? mapSodreItemToAuctionVehicle(item, log) : null;
}

export async function scrapeSodre(
  _filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  log("[sodre] Iniciando (fetch via browser)...");

  const headless = options?.headless ?? true;
  const browser = await chromium.launch(buildPlaywrightLaunchOptions(headless));
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    locale: "pt-BR"
  });
  const page = await context.newPage();

  let items: SodreItem[] = [];

  try {
    // Carrega a página para obter cookies de sessão (WAF bypass)
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    log("[sodre] Sessão estabelecida. Chamando API...");

    // Executa o fetch de dentro do browser (usa cookies da sessão automaticamente)
    const fetchSearch = async (payload: object) =>
      page.evaluate(
      async ({ url, body }: { url: string; body: object }) => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Accept": "application/json, text/plain, */*", "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(body)
        });
        if (!res.ok) return { error: res.status, results: [] };
        return res.json();
      },
      { url: API_URL, body: payload }
    ) as Promise<{ error?: number; results?: SodreItem[]; total?: number }>;

    const fetchAllPages = async (includeLocationCategoryFilter: boolean): Promise<{ error?: number; results?: SodreItem[]; total?: number }> => {
      const collected: SodreItem[] = [];
      let total: number | null = null;

      for (let pageNumber = 1; pageNumber <= MAX_PAGES; pageNumber += 1) {
        const from = (pageNumber - 1) * PAGE_SIZE;
        const result = await fetchSearch(buildPayload({ includeLocationCategoryFilter, from }));
        if (result.error) return result;

        const pageItems = result.results ?? [];
        if (typeof result.total === "number" && Number.isFinite(result.total) && result.total >= 0) {
          total = result.total;
        }

        collected.push(...pageItems);
        const progress = total === null ? String(collected.length) : `${collected.length}/${total}`;
        log(`[sodre] Página ${pageNumber}: ${pageItems.length} lote(s) recebido(s) (${progress}).`);

        if (pageItems.length < PAGE_SIZE || (total !== null && collected.length >= total)) break;
        if (pageNumber === MAX_PAGES) {
          log(`[sodre] Limite defensivo de ${MAX_PAGES} páginas atingido.`);
        }
      }

      return { results: collected, total: total ?? collected.length };
    };

    let result = await fetchAllPages(true);

    if (result.error) {
      log(`[sodre] API retornou erro: HTTP ${result.error}`);
      return [];
    }

    items = result.results ?? [];
    log(`[sodre] ${items.length} lote(s) recebidos (categoria carros).`);

    if (items.length === 0) {
      log("[sodre] Sem lotes no filtro de localização/categoria. Tentando fallback sem filtro fixo...");
      result = await fetchAllPages(false);

      if (result.error) {
        log(`[sodre] Fallback API erro: HTTP ${result.error}`);
        return [];
      }

      items = result.results ?? [];
      log(`[sodre] ${items.length} lote(s) recebidos no fallback sem filtro fixo.`);
    }
  } catch (err) {
    log(`[sodre] Erro: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  } finally {
    await browser.close();
  }

  const results: AuctionVehicle[] = [];
  const stats = {
    total: items.length,
    accepted: 0
  };
  const brandSample = new Set<string>();

  for (const item of items) {
    const brandRaw = (item.lot_brand ?? "").trim();
    if (brandRaw) {
      if (brandSample.size < 10) {
        brandSample.add(brandRaw);
      }
    }

    results.push(mapSodreItemToAuctionVehicle(item, log));
    stats.accepted += 1;
  }

  log(
    `[sodre] Filtro resumo: total=${stats.total} | aceitos=${stats.accepted}`
  );
  if (stats.accepted === 0 && brandSample.size > 0) {
    log(`[sodre] Marcas recebidas (amostra): ${[...brandSample].join(", ")}`);
  }
  log(`[sodre] ${results.length} veículo(s) após filtros.`);
  return results;
}
