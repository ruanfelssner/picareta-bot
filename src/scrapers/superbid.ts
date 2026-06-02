import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";

const BASE_URL = "https://www.superbid.net";
const CATEGORY_PATH = "/categorias/carros-motos/carros";
const CATEGORY_URL = `${BASE_URL}${CATEGORY_PATH}`;
const REQUEST_DELAY_MS = 250;
const DEFAULT_PAGE_SIZE = 30;
const DEFAULT_MAX_PAGES = 8;
const HARD_MAX_PAGES = 80;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

type SuperbidOffer = {
  id?: number | string;
  lotNumber?: number | string | null;
  price?: number | null;
  priceFormatted?: string | null;
  offerDetail?: {
    currentMinBid?: number | null;
    currentMinBidFormatted?: string | null;
    initialBidValue?: number | null;
    initialBidValueFormatted?: string | null;
  } | null;
  auction?: {
    endDate?: string | null;
    beginDate?: string | null;
    desc?: string | null;
  } | null;
  product?: {
    shortDesc?: string | null;
    detailedDescription?: string | null;
    thumbnailUrl?: string | null;
    galleryJson?: Array<{
      link?: string | null;
      thumbnailUrl?: string | null;
    }> | null;
    template?: {
      groups?: Array<{
        properties?: Array<{
          id?: string | null;
          title?: string | null;
          value?: string | number | null;
        }> | null;
      }> | null;
    } | null;
    brand?: unknown;
    model?: unknown;
    location?: {
      city?: string | null;
      state?: string | null;
      address?: string | null;
    } | null;
  } | null;
  offerDescription?: {
    title?: string | null;
    desc?: string | null;
    offerDescription?: string | null;
  } | null;
  seller?: {
    name?: string | null;
  } | null;
};

type SuperbidNextData = {
  props?: {
    pageProps?: {
      offersList?: {
        total?: number;
        start?: number;
        limit?: number;
        offers?: SuperbidOffer[];
      };
    };
  };
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseMaxPagesFromEnv(): number {
  const raw = Number.parseInt((process.env.SUPERBID_MAX_PAGES ?? "").trim(), 10);
  if (!Number.isFinite(raw) || raw < 1) {
    return DEFAULT_MAX_PAGES;
  }
  return Math.max(1, Math.min(HARD_MAX_PAGES, raw));
}

function toAbsoluteUrl(value: string | null | undefined): string {
  const text = (value ?? "").trim();
  if (!text) return "";
  if (text.startsWith("http://") || text.startsWith("https://")) return text;
  if (text.startsWith("//")) return `https:${text}`;
  if (text.startsWith("/")) return `${BASE_URL}${text}`;
  return `${BASE_URL}/${text}`;
}

function pickText(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!value || typeof value !== "object") {
    return "";
  }

  const obj = value as Record<string, unknown>;
  const candidates = ["description", "desc", "name", "title"];
  for (const key of candidates) {
    const candidate = obj[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }

  return "";
}

function parsePrice(raw: string | null | undefined): { price: number | null; priceRaw: string | null } {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  const match = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) {
    return { price: null, priceRaw: null };
  }

  const numericText = match[1];
  const normalized = numericText.replace(/\./g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return {
    price: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null,
    priceRaw: `R$ ${numericText}`
  };
}

function parseMoneyValue(raw: string | number | null | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw);
  }

  const text = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;

  const cleaned = text.replace(/[^\d,.-]/g, "");
  if (!cleaned) return null;

  // Se vier com vírgula decimal, interpreta decimal. Caso contrário, inteiro.
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned.replace(/[.,]/g, "");
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed);
}

function formatPriceRawFromNumber(value: number | null): string | null {
  if (!Number.isFinite(Number(value)) || Number(value) <= 0) return null;
  return `R$ ${Math.round(Number(value)).toLocaleString("pt-BR")}`;
}

function extractFipeFromTemplate(offer: SuperbidOffer): { fipe: number | null; fipeRaw: string | null } {
  const groups = offer.product?.template?.groups;
  if (!Array.isArray(groups)) {
    return { fipe: null, fipeRaw: null };
  }

  let fallbackValue: number | null = null;

  for (const group of groups) {
    const properties = Array.isArray((group as { properties?: unknown[] }).properties)
      ? ((group as { properties?: unknown[] }).properties ?? [])
      : [];
    for (const property of properties) {
      if (!property || typeof property !== "object") continue;
      const prop = property as { id?: unknown; title?: unknown; value?: unknown };
      const id = String(prop.id ?? "").toLowerCase().trim();
      const title = String(prop.title ?? "").toLowerCase().trim();
      const isFipeField = id.includes("fipe") || title.includes("fipe");
      if (!isFipeField) continue;

      const value = parseMoneyValue(
        typeof prop.value === "string" || typeof prop.value === "number" ? prop.value : null
      );
      if (value == null) continue;

      // Prioriza explicitamente o campo "Valor Tabela FIPE".
      if (id.includes("valortabelafipe") || title.includes("valor tabela fipe")) {
        return { fipe: value, fipeRaw: formatPriceRawFromNumber(value) };
      }

      if (fallbackValue == null) {
        fallbackValue = value;
      }
    }
  }

  return { fipe: fallbackValue, fipeRaw: formatPriceRawFromNumber(fallbackValue) };
}

function extractFipeFromTexts(texts: Array<string | null | undefined>): { fipe: number | null; fipeRaw: string | null } {
  const patterns = [
    /pre(?:c|ç)o\s*fipe[^r$0-9]{0,30}r\$\s*([\d.]+(?:,\d{1,2})?)/i,
    /valor\s*(?:da|de)?\s*tabela\s*fipe[^r$0-9]{0,30}r\$\s*([\d.]+(?:,\d{1,2})?)/i,
    /\bfipe\b[^r$0-9]{0,30}r\$\s*([\d.]+(?:,\d{1,2})?)/i
  ] as const;

  for (const rawText of texts) {
    const text = String(rawText ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const value = parseMoneyValue(match[1]);
      if (value == null) continue;
      return { fipe: value, fipeRaw: formatPriceRawFromNumber(value) };
    }
  }

  return { fipe: null, fipeRaw: null };
}

function parseYear(raw: string): number | null {
  const modelYearMatch = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:\d{2,4})\b/);
  if (modelYearMatch) {
    return Number.parseInt(modelYearMatch[1], 10);
  }

  const allYears = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)];
  if (allYears.length === 0) return null;
  const year = Number.parseInt(allYears[0]?.[1] ?? "", 10);
  return Number.isFinite(year) ? year : null;
}

function parseDateTime(raw: string | null | undefined): Date | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const normalized = text.includes("T") ? text : text.replace(" ", "T");
  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const alt = new Date(text);
  return Number.isNaN(alt.getTime()) ? null : alt;
}

function normalizeSlugPiece(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function parseBrandAndModelFromTitle(rawTitle: string): { brand: string; model: string } {
  const cleaned = rawTitle
    .replace(/\s+/g, " ")
    .replace(
      /^(?:SUCATA\s+DE\s+)?(?:DIREITOS?\s+SOBRE\s+)?(?:CARRO|VE[IÍ]CULO|CAMINHONETE|MOTO|MOTOCICLETA|CAMINH[AÃ]O)\s+/i,
      ""
    )
    .trim();

  const cutByYear = cleaned.split(/\s+-\s+(?:19|20)\d{2}/)[0]?.trim() ?? cleaned;
  const tokens = cutByYear.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { brand: "UNKNOWN", model: "SEM MODELO" };
  }

  const brand = tokens[0].toUpperCase();
  const model = tokens.slice(1).join(" ").trim().toUpperCase();
  return {
    brand: brand || "UNKNOWN",
    model: model || cutByYear.toUpperCase()
  };
}

function extractNextData(html: string): SuperbidNextData | null {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match) return null;

  try {
    return JSON.parse(match[1]) as SuperbidNextData;
  } catch {
    return null;
  }
}

function extractOfferUrlsById(html: string): Map<number, string> {
  const out = new Map<number, string>();
  const regex = /href="(https:\/\/exchange\.superbid\.net\/oferta\/[^"]+-(\d+))"/gi;

  for (const match of html.matchAll(regex)) {
    const url = match[1];
    const id = Number.parseInt(match[2], 10);
    if (!Number.isFinite(id) || id <= 0) continue;
    if (!out.has(id)) out.set(id, url);
  }

  return out;
}

function buildFallbackOfferUrl(title: string, id: number): string {
  const slug = normalizeSlugPiece(title) || `oferta-${id}`;
  return `https://exchange.superbid.net/oferta/${slug}-${id}`;
}

function normalizeLocation(location: SuperbidOffer["product"] extends { location?: infer T } ? T : unknown): string | null {
  if (!location || typeof location !== "object") return null;
  const obj = location as Record<string, unknown>;
  const city = typeof obj.city === "string" ? obj.city.trim() : "";
  const state = typeof obj.state === "string" ? obj.state.trim() : "";
  const address = typeof obj.address === "string" ? obj.address.trim() : "";

  if (city && state && !city.includes(state)) return `${city} - ${state}`;
  if (city) return city;
  if (address) return address;
  return state || null;
}

function parseOffer(
  offer: SuperbidOffer,
  pageUrlMap: Map<number, string>
): AuctionVehicle | null {
  const idNum = Number.parseInt(String(offer.id ?? ""), 10);
  if (!Number.isFinite(idNum) || idNum <= 0) {
    return null;
  }

  const product = offer.product ?? null;
  const offerDetail = offer.offerDetail ?? null;

  const title =
    (product?.shortDesc ?? "").trim() ||
    (offer.offerDescription?.title ?? "").trim() ||
    (offer.offerDescription?.desc ?? "").trim();
  if (!title) {
    return null;
  }

  const fallbackBrandModel = parseBrandAndModelFromTitle(title);
  const brand = (pickText(product?.brand) || fallbackBrandModel.brand).toUpperCase();
  const model = (pickText(product?.model) || fallbackBrandModel.model).toUpperCase();

  const detailPriceRaw =
    offerDetail?.currentMinBidFormatted ??
    offerDetail?.initialBidValueFormatted ??
    offer.priceFormatted ??
    null;
  const detailPrice =
    (typeof offerDetail?.currentMinBid === "number" && offerDetail.currentMinBid > 0
      ? offerDetail.currentMinBid
      : typeof offerDetail?.initialBidValue === "number" && offerDetail.initialBidValue > 0
        ? offerDetail.initialBidValue
        : typeof offer.price === "number" && offer.price > 0
          ? offer.price
          : null);
  const parsedPriceFromRaw = parsePrice(detailPriceRaw);
  const finalPrice = detailPrice ?? parsedPriceFromRaw.price;
  const finalPriceRaw =
    parsedPriceFromRaw.priceRaw ??
    (typeof detailPrice === "number" && detailPrice > 0
      ? `R$ ${detailPrice.toLocaleString("pt-BR")}`
      : null);

  const images: string[] = [];
  const gallery = Array.isArray(product?.galleryJson) ? product.galleryJson : [];
  for (const entry of gallery) {
    const link = toAbsoluteUrl(entry?.link ?? entry?.thumbnailUrl ?? "");
    if (link && !images.includes(link)) {
      images.push(link);
    }
    if (images.length >= 5) break;
  }
  const thumb = toAbsoluteUrl(product?.thumbnailUrl ?? "");
  if (thumb && !images.includes(thumb)) {
    images.unshift(thumb);
  }

  const lot = offer.lotNumber != null ? String(offer.lotNumber).trim() : undefined;
  const yard = normalizeLocation(product?.location ?? null);
  const url = pageUrlMap.get(idNum) || buildFallbackOfferUrl(title, idNum);

  const damage = /\b(sucata|batid[oa]|sinistrad[oa])\b/i.test(title)
    ? (title.match(/\b(sucata|batid[oa]|sinistrad[oa])\b/i)?.[0] ?? null)
    : null;

  const fipeFromTemplate = extractFipeFromTemplate(offer);
  const fipeFromText = extractFipeFromTexts([
    product?.detailedDescription ?? null,
    offer.offerDescription?.offerDescription ?? null,
    offer.offerDescription?.desc ?? null
  ]);
  const fipe = fipeFromTemplate.fipe ?? fipeFromText.fipe;
  const fipeRaw = fipeFromTemplate.fipeRaw ?? fipeFromText.fipeRaw;

  const descriptionBase = [
    title,
    offer.seller?.name?.trim() || null,
    offer.auction?.desc?.trim() || null
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 260);

  return {
    source: "superbid",
    brand: brand || "UNKNOWN",
    model: model || "SEM MODELO",
    year: parseYear(title),
    damage,
    price: typeof finalPrice === "number" && finalPrice > 0 ? Math.round(finalPrice) : null,
    priceRaw: finalPriceRaw,
    imageUrls: images,
    description: descriptionBase,
    url,
    auctionDate: parseDateTime(offer.auction?.endDate ?? null),
    lot,
    yard,
    fipe,
    fipeRaw
  };
}

async function fetchHtml(url: string, log: (msg: string) => void): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      log(`[superbid] HTTP ${response.status} em ${url}`);
      return null;
    }
    return await response.text();
  } catch (error) {
    log(`[superbid] Erro em ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function buildPageUrl(page: number, pageSize: number): string {
  if (page <= 1) return CATEGORY_URL;
  return `${CATEGORY_URL}?pageNumber=${page}&pageSize=${pageSize}`;
}

export async function scrapeSuperbid(
  _filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const maxPages = parseMaxPagesFromEnv();
  const all: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  log("[superbid] Iniciando...");
  const firstHtml = await fetchHtml(buildPageUrl(1, DEFAULT_PAGE_SIZE), log);
  if (!firstHtml) {
    log("[superbid] Falha ao carregar página inicial.");
    return [];
  }

  const firstNextData = extractNextData(firstHtml);
  if (!firstNextData?.props?.pageProps?.offersList?.offers) {
    log("[superbid] __NEXT_DATA__ sem offers.");
    return [];
  }

  const firstList = firstNextData.props.pageProps.offersList;
  const total = typeof firstList.total === "number" && firstList.total > 0 ? firstList.total : 0;
  const pageSize =
    typeof firstList.limit === "number" && firstList.limit > 0
      ? Math.max(1, Math.min(100, firstList.limit))
      : DEFAULT_PAGE_SIZE;
  const discoveredPages = total > 0 ? Math.ceil(total / pageSize) : 1;
  const totalPages = Math.max(1, Math.min(discoveredPages, maxPages));

  log(
    `[superbid] Página(s): total=${discoveredPages} | limite=${maxPages} | varrendo=${totalPages} ` +
      `(total estimado=${total}, pageSize=${pageSize}).`
  );

  const appendOffers = (offers: SuperbidOffer[], html: string): void => {
    const urlMap = extractOfferUrlsById(html);
    for (const offer of offers) {
      const parsed = parseOffer(offer, urlMap);
      if (!parsed) continue;
      if (!parsed.url || seenUrls.has(parsed.url)) continue;
      seenUrls.add(parsed.url);
      all.push(parsed);
    }
  };

  appendOffers(firstList.offers ?? [], firstHtml);
  log(`[superbid] Página 1/${totalPages}: ${all.length} veículo(s) acumulado(s).`);

  for (let page = 2; page <= totalPages; page += 1) {
    const pageUrl = buildPageUrl(page, pageSize);
    log(`[superbid] Página ${page}/${totalPages}: ${pageUrl}`);

    const html = await fetchHtml(pageUrl, log);
    if (!html) continue;

    const nextData = extractNextData(html);
    const offers = nextData?.props?.pageProps?.offersList?.offers ?? [];
    appendOffers(offers, html);
    log(`[superbid] Página ${page}/${totalPages}: ${offers.length} lote(s) bruto; ${all.length} acumulado(s).`);

    await sleep(REQUEST_DELAY_MS);
  }

  log(`[superbid] Total: ${all.length} veículo(s).`);
  return all;
}
