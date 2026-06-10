import { load } from "cheerio";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";

const BASE_URL = "https://lucineiautomoveis.com.br";
const SEARCH_URL = `${BASE_URL}/BuscadorVeiculo.aspx`;
const LUCINEI_YARD = "Ribeirão Preto - SP";
const DEFAULT_MAX_PAGES = 20;
const HARD_MAX_PAGES = 50;
const PAGE_DELAY_MS = 500;
const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const MIN_FETCH_TIMEOUT_MS = 5_000;
const MAX_FETCH_TIMEOUT_MS = 60_000;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function normalizeNullableText(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw);
  return text ? text : null;
}

function clampPositiveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function getFetchTimeoutMs(): number {
  return clampPositiveInt(
    process.env.LUCINEI_FETCH_TIMEOUT_MS,
    DEFAULT_FETCH_TIMEOUT_MS,
    MIN_FETCH_TIMEOUT_MS,
    MAX_FETCH_TIMEOUT_MS
  );
}

function buildPageUrl(page: number): string {
  if (page <= 1) return SEARCH_URL;
  return `${SEARCH_URL}?pag=${page}`;
}

function toAbsoluteUrl(raw: string | null | undefined): string | null {
  const value = normalizeSpace(raw);
  if (!value) return null;

  try {
    return new URL(value.replace(/^~\//, "/"), `${BASE_URL}/`).toString();
  } catch {
    return null;
  }
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const match = raw.match(/R\$\s*([\d.]+(?:,\d{2})?)/i);
  if (!match?.[1]) return { price: null, priceRaw: null };

  const priceRaw = `R$ ${match[1]}`;
  const numeric = Number.parseFloat(match[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return { price: null, priceRaw };

  return {
    price: Math.round(numeric),
    priceRaw
  };
}

function parseYear(raw: string): number | null {
  const match = raw.match(/\b((?:19|20)\d{2})\s*\/\s*((?:19|20)\d{2})\b/);
  if (match?.[1]) return Number.parseInt(match[1], 10);

  const fallback = raw.match(/\b((?:19|20)\d{2})\b/);
  return fallback?.[1] ? Number.parseInt(fallback[1], 10) : null;
}

function parseLot(raw: string): string | undefined {
  const match = raw.match(/C[oó]d\.?\s*:\s*([0-9]+)/i);
  return match?.[1] ?? undefined;
}

function parseBrand(raw: string): string {
  const match = raw.match(/Marca\s*:\s*(.+?)(?=\s+Ano\s*:|$)/i);
  return normalizeSpace(match?.[1]).trim() || "UNKNOWN";
}

function normalizeDamage(raw: string | null | undefined): string | null {
  const value = normalizeNullableText(raw);
  if (!value) return null;

  return value
    .replace(/\s*-\s*/g, "-")
    .replace(/\bmonta\b/gi, "monta")
    .replace(/^media-/i, "Média-")
    .replace(/^pequena-/i, "Pequena-")
    .trim();
}

function extractDamageFromText(raw: string): string | null {
  const match = raw.match(/\b(?:pequena|m[eé]dia)\s*-?\s*monta\b|\bsucata\b/i);
  return normalizeDamage(match?.[0]);
}

function upgradeImageUrlQuality(url: string): string {
  return url.replace(/-(\d+)b(\.[a-z0-9]+)$/i, "-$1c$2");
}

function pickImageUrl(raw: string | null | undefined): string[] {
  const url = toAbsoluteUrl(raw);
  if (!url) return [];
  if (/imagem-n-disponivel/i.test(url)) return [];
  return [upgradeImageUrlQuality(url)];
}

async function fetchHtml(url: string, log: (message: string) => void): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), getFetchTimeoutMs());

  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) {
      log(`[lucinei] HTTP ${response.status} em ${url}`);
      return null;
    }
    return response.text();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = error instanceof Error && error.name === "AbortError"
      ? `timeout após ${Math.round(getFetchTimeoutMs() / 1000)}s`
      : message;
    log(`[lucinei] Erro ao buscar ${url}: ${reason}`);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parsePaginationPages(html: string): number[] {
  const $ = load(html);
  const pages = new Set<number>();

  $('a[href*="pag="]').each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    try {
      const url = new URL(href, `${BASE_URL}/`);
      const page = Number.parseInt(url.searchParams.get("pag") ?? "", 10);
      if (Number.isFinite(page) && page > 0) {
        pages.add(page);
      }
    } catch {
      // Ignora links malformados do paginador.
    }
  });

  return [...pages].sort((a, b) => a - b);
}

function parseCards(html: string, log: (message: string) => void): AuctionVehicle[] {
  const $ = load(html);
  const vehicles: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();
  let candidateLinks = 0;

  function looksLikeVehicleContainer(text: string): boolean {
    return /Marca\s*:/i.test(text) && /C[oó]d\.?\s*:/i.test(text) && /R\$\s*[\d.]+/i.test(text);
  }

  function isTitleCandidate(raw: string): boolean {
    const text = normalizeSpace(raw);
    if (!text) return false;
    if (/^R\$/i.test(text)) return false;
    if (/^VER MAIS$/i.test(text)) return false;
    if (/^(?:pequena|m[eé]dia)\s*-?\s*monta$/i.test(text)) return false;
    if (/^sucata$/i.test(text)) return false;
    if (/^(?:marca|ano|c[oó]d)\s*:/i.test(text)) return false;
    if (/^(?:ve[ií]culo marca|faixa de pre[cç]o|categoria|buscar|limpar)$/i.test(text)) return false;
    return /[a-zà-ú]/i.test(text);
  }

  function extractTitleFromCard(card: ReturnType<typeof $>): string {
    const headingCandidates = card
      .find("h1,h2,h3,h4,h5,h6,.alert-link,.card-title,.card-text")
      .map((_candidateIndex, titleElement) => normalizeSpace($(titleElement).text()))
      .get()
      .filter(isTitleCandidate);

    const heading = headingCandidates[0];
    if (heading) return heading;

    const textLine = card
      .text()
      .split(/\r?\n/)
      .map(normalizeSpace)
      .find(isTitleCandidate);

    return textLine ?? "";
  }

  function findVehicleCard(anchor: ReturnType<typeof $>): ReturnType<typeof $> {
    let current = anchor.parent();

    for (let depth = 0; depth < 8 && current.length > 0; depth += 1) {
      const text = normalizeSpace(current.text());
      if (looksLikeVehicleContainer(text)) return current;
      current = current.parent();
    }

    return anchor.closest(".card, [class*='card'], [class*='col-'], li, article").first();
  }

  $('a[href*="Veiculo.aspx?id="]').each((_index, element) => {
    candidateLinks += 1;
    const detailAnchor = $(element);
    const detailUrl = toAbsoluteUrl(detailAnchor.attr("href"));
    if (!detailUrl || seenUrls.has(detailUrl)) return;

    const card = findVehicleCard(detailAnchor);
    if (!card.length) return;

    const title = extractTitleFromCard(card);
    if (!title) return;

    const metaText = normalizeSpace(card.text());
    const brand = parseBrand(metaText);
    const year = parseYear(metaText);
    const lot = parseLot(metaText);
    const damageText = card
      .find(".btn.disabled, .disabled, .badge, .label")
      .map((_damageIndex, damageElement) => normalizeSpace($(damageElement).text()))
      .get()
      .find((text) => /monta|sucata/i.test(text));
    const damage = normalizeDamage(damageText) ?? extractDamageFromText(metaText);
    const priceText = normalizeSpace(card.find("h5.text-right, .text-right").first().text()) || metaText;
    const { price, priceRaw } = parsePrice(priceText);
    const imageUrls = pickImageUrl(
      detailAnchor.find("img").first().attr("src") ??
      card.find("img").first().attr("src")
    );
    const description = [
      "Lucinei Automóveis - Ribeirão Preto/SP",
      damage,
      lot ? `Cód.: ${lot}` : null
    ].filter((item): item is string => Boolean(item)).join(" · ");

    seenUrls.add(detailUrl);
    vehicles.push({
      source: "lucinei",
      brand,
      model: title,
      year,
      damage,
      price,
      priceRaw,
      imageUrls,
      description,
      url: detailUrl,
      auctionDate: null,
      lot,
      yard: LUCINEI_YARD
    });
  });

  log(`[lucinei] ${vehicles.length} card(s) válido(s) nesta página (${candidateLinks} link(s) de detalhe).`);
  return vehicles;
}

export async function scrapeLucinei(
  _filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const maxPages = clampPositiveInt(process.env.LUCINEI_MAX_PAGES, DEFAULT_MAX_PAGES, 1, HARD_MAX_PAGES);
  const queuedPages = new Set<number>([1]);
  const pagesToVisit = [1];
  const allVehicles: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  console.info("[scraper:lucinei] iniciando");
  log(`[lucinei] Iniciando Lucinei Automóveis (limite ${maxPages} página(s)).`);

  for (let index = 0; index < pagesToVisit.length; index += 1) {
    const page = pagesToVisit[index] ?? 1;
    if (page > maxPages) continue;

    const url = buildPageUrl(page);
    log(`[lucinei] Página ${page}: ${url}`);

    const html = await fetchHtml(url, log);
    if (!html) continue;

    for (const vehicle of parseCards(html, log)) {
      if (seenUrls.has(vehicle.url)) continue;
      seenUrls.add(vehicle.url);
      allVehicles.push(vehicle);
    }

    for (const pageNumber of parsePaginationPages(html)) {
      if (pageNumber > maxPages || queuedPages.has(pageNumber)) continue;
      queuedPages.add(pageNumber);
      pagesToVisit.push(pageNumber);
    }

    if (index < pagesToVisit.length - 1) {
      await sleep(PAGE_DELAY_MS);
    }
  }

  log(`[lucinei] Total: ${allVehicles.length} veículo(s).`);
  console.info(`[scraper:lucinei] finalizado (${allVehicles.length} veículos)`);
  return allVehicles;
}
