import { load } from "cheerio";
import { chromium, type Page } from "playwright";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";

const BASE_URL = "https://www.vipleiloes.com.br";
const START_URL_FALLBACKS = [
  `${BASE_URL}/Veiculos/Home`,
  `${BASE_URL}/veiculos/home`,
  `${BASE_URL}/?lang=en`
];
const REQUEST_DELAY_MS = 350;
const DEFAULT_MAX_PAGES = 40;
const HARD_MAX_PAGES = 160;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const IMAGE_URL_ATTRS = [
  "src",
  "data-src",
  "data-original",
  "data-lazy",
  "data-lazy-src",
  "data-url"
] as const;

const IMAGE_SRCSET_ATTRS = ["srcset", "data-srcset"] as const;

type SearchFragmentParseResult = {
  vehicles: AuctionVehicle[];
  nextAjaxUrl: string | null;
  currentPage: number | null;
  totalResults: number | null;
};

type PartialFetchResult = {
  ok: boolean;
  status: number;
  requestUrl: string;
  html: string;
  error?: string;
};

type ParsedListingText = {
  titleRaw: string;
  lot: string | undefined;
  yard: string | null;
  km: string | null;
  auctionDate: Date | null;
  description: string;
};

type ImageAttrReader = (attr: string) => string | undefined;

type VipClassification = {
  name: string;
  damage: string;
};

const DEFAULT_CLASSIFICATIONS: VipClassification[] = [
  { name: "Sinistrados", damage: "sinistrado" },
  { name: "Usados", damage: "usado" },
  { name: "Seminovos", damage: "seminovo" }
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSpace(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

function normalizeText(raw: string | null | undefined): string {
  return normalizeSpace(raw)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildSearchHandlerPath(classification: VipClassification): string {
  return `/pesquisa?classificacao=${encodeURIComponent(classification.name)}&handler=pesquisar`;
}

function buildStartUrl(classification: VipClassification): string {
  return `${BASE_URL}/pesquisa?classificacao=${encodeURIComponent(classification.name)}`;
}

function ensureClassificationQuery(urlLike: string, classification: VipClassification): string {
  const trimmed = normalizeSpace(urlLike);
  if (!trimmed) return buildSearchHandlerPath(classification);

  try {
    const url = new URL(trimmed, BASE_URL);
    url.searchParams.set("classificacao", classification.name);
    if (!url.searchParams.has("handler")) {
      url.searchParams.set("handler", "pesquisar");
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return buildSearchHandlerPath(classification);
  }
}

function parseMaxPagesFromEnv(): number {
  const raw = Number.parseInt((process.env.VIPLEILOES_MAX_PAGES ?? "").trim(), 10);
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

function extractFirstSrcsetUrl(raw: string | null | undefined): string {
  const text = normalizeSpace(raw);
  if (!text) return "";
  return normalizeSpace(text.split(",")[0]?.split(/\s+/)[0] ?? "");
}

function extractCssBackgroundUrl(raw: string | null | undefined): string {
  const text = raw ?? "";
  const match = text.match(/url\((['"]?)(.*?)\1\)/i);
  return normalizeSpace(match?.[2] ?? "");
}

function isUsableImageUrl(raw: string): boolean {
  const text = normalizeSpace(raw);
  if (!text) return false;
  if (text.startsWith("data:")) return false;
  if (/^(?:#|javascript:)/i.test(text)) return false;
  return !/^(?:about:blank|blank)$/i.test(text);
}

function extractImageUrlFromAttrs(readAttr: ImageAttrReader): string {
  const candidates: string[] = [];

  for (const attr of IMAGE_URL_ATTRS) {
    candidates.push(readAttr(attr) ?? "");
  }
  for (const attr of IMAGE_SRCSET_ATTRS) {
    candidates.push(extractFirstSrcsetUrl(readAttr(attr)));
  }
  candidates.push(extractCssBackgroundUrl(readAttr("style")));

  const picked = candidates.find(isUsableImageUrl) ?? "";
  return picked ? toAbsoluteUrl(picked) : "";
}

function pickFirstImageUrl(...readers: ImageAttrReader[]): string {
  for (const readAttr of readers) {
    const url = extractImageUrlFromAttrs(readAttr);
    if (url) return url;
  }
  return "";
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const text = normalizeSpace(raw);
  const match = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match) {
    return { price: null, priceRaw: null };
  }

  const numericText = match[1];
  const normalized = numericText.replace(/\./g, "").replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return { price: null, priceRaw: `R$ ${numericText}` };
  }

  return {
    price: Math.round(parsed),
    priceRaw: `R$ ${numericText}`
  };
}

function parseYear(raw: string): number | null {
  const modelYearMatch = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:\d{2,4})\b/);
  if (modelYearMatch) {
    return Number.parseInt(modelYearMatch[1], 10);
  }

  const years = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)];
  if (years.length === 0) return null;

  const parsed = Number.parseInt(years[0]?.[1] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseKm(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;
  const parsed = Number.parseInt(digits, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed.toLocaleString("pt-BR");
}

function parseDatePtBr(dateRaw: string, hourRaw: string): Date | null {
  const dateText = normalizeSpace(dateRaw).replace(/^in[ií]cio:\s*/i, "");
  const hourText = normalizeSpace(hourRaw);

  const dateMatch = dateText.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!dateMatch) return null;

  const day = Number.parseInt(dateMatch[1], 10);
  const month = Number.parseInt(dateMatch[2], 10);
  const year = Number.parseInt(dateMatch[3], 10);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;

  const hourMatch = hourText.match(/(\d{2}):(\d{2})/);
  const hour = hourMatch ? Number.parseInt(hourMatch[1], 10) : 0;
  const minute = hourMatch ? Number.parseInt(hourMatch[2], 10) : 0;

  const parsed = new Date(year, month - 1, day, hour, minute, 0, 0);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function looksLikeVehicleListingText(raw: string): boolean {
  const text = normalizeSpace(raw);
  if (!text) return false;

  const hasYear = /\b(?:19|20)\d{2}\s*\/\s*(?:19|20)?\d{2}\b/.test(text);
  const hasListingHints = /valor atual|local:|r\$\s*[\d.]+(?:,\d+)?|km\b/i.test(text);
  const looksLikeAgenda = /vendedor\(es\):|leiloeiro:|lotes?\s+online/i.test(text);

  return hasYear && hasListingHints && !looksLikeAgenda;
}

function parseDateTimeFromText(raw: string): Date | null {
  const text = normalizeSpace(raw);
  const match = text.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
  if (!match) return null;
  return parseDatePtBr(match[1], match[2]);
}

function extractVipStatusText(raw: string | null | undefined): string | null {
  const text = normalizeSpace(raw);
  if (!text) return null;

  const markers = [
    /\bREPASSE\b/i,
    /\bAo Vivo\b/i,
    /\bAberto para lances\b/i,
    /\bEm Breve\b/i
  ];

  const hits = markers
    .map((pattern) => normalizeSpace(text.match(pattern)?.[0] ?? ""))
    .filter(Boolean);
  const unique = Array.from(new Set(hits.map((item) => item.toUpperCase())));
  return unique.length > 0 ? unique.join(" · ") : null;
}

function buildVipDamageLabel(classification: VipClassification, rawText: string, statusRaw: string | null): string {
  const parts = [classification.damage];
  const statusText = `${statusRaw ?? ""} ${rawText}`;
  if (/\bREPASSE\b/i.test(statusText)) {
    parts.push("repasse");
  }

  return Array.from(new Set(parts.map((part) => normalizeSpace(part)).filter(Boolean))).join(" · ");
}

function extractYardStateCountFallback(raw: string): string | null {
  const text = normalizeSpace(raw);
  if (!text) return null;

  const matches = [...text.matchAll(/\b([A-Z]{2})\s+(\d{1,4})\b/g)];
  if (matches.length < 2) return null;

  const chunks = matches.map((m) => `${m[1]} ${m[2]}`);
  const unique = Array.from(new Set(chunks));
  if (unique.length < 2) return null;
  return unique.join(" ");
}

function extractTitleFromListingText(raw: string): string {
  const text = normalizeSpace(raw);
  if (!text) return "";

  const explicitTitleMatch = text.match(
    /(?:Lote:\s*[A-Za-z0-9.-]+\s+Local:\s*[A-Za-zÀ-ÿ0-9 .,/()-]+\s+)?(.+?\b(?:19|20)\d{2}\s*\/\s*(?:19|20)?\d{2}\b)/i
  );
  if (explicitTitleMatch?.[1]) {
    return normalizeSpace(explicitTitleMatch[1]);
  }

  const beforePrice = text.split(/\bValor Atual\b/i)[0] ?? text;
  return normalizeSpace(beforePrice);
}

function parseListingText(raw: string, statusRaw: string | null): ParsedListingText {
  const text = normalizeSpace(raw);
  const titleRaw = extractTitleFromListingText(text);
  const lotMatch = text.match(/\bLote:\s*([A-Za-z0-9.-]+)/i);
  const lot = lotMatch?.[1]?.trim() || undefined;

  const yardMatch =
    text.match(/(?:Local(?:iza(?:ção|cao)\s+do\s+lote| do lote)?|Local)\s*:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)(?=\s+R\$|\s+\d{1,3}(?:\.\d{3})*(?:,\d+)?\s*Km|\s+\d{2}\/\d{2}\/\d{4}|\s+Lance|\s*$)/i) ??
    text.match(/\bLocal:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)\s+R\$/i);
  const yard = yardMatch?.[1]?.trim() || extractYardStateCountFallback(text);

  const kmMatch = text.match(/(\d{1,3}(?:\.\d{3})*(?:,\d+)?)\s*Km\b/i);
  const km = kmMatch ? parseKm(kmMatch[1]) : null;

  const auctionDate = parseDateTimeFromText(text);
  const initialPriceLine = text.match(/Lance Inicial:\s*R\$\s*[\d.]+(?:,\d{1,2})?/i)?.[0] ?? null;
  const status = normalizeSpace(statusRaw) || extractVipStatusText(text) || "";
  const description = [status || null, initialPriceLine].filter(Boolean).join(" · ").slice(0, 240);

  return {
    titleRaw,
    lot,
    yard,
    km,
    auctionDate,
    description
  };
}

const BRAND_TITLE_ALIASES: Array<{ alias: string; canonical: string }> = [
  { alias: "MERCEDES BENZ", canonical: "MERCEDES-BENZ" },
  { alias: "LAND ROVER", canonical: "LAND ROVER" },
  { alias: "CAOA CHERY", canonical: "CAOA CHERY" },
  { alias: "GREAT WALL", canonical: "GWM" },
  { alias: "VOLKSWAGEN", canonical: "VOLKSWAGEN" },
  { alias: "CHEVROLET", canonical: "CHEVROLET" },
  { alias: "HYUNDAI", canonical: "HYUNDAI" },
  { alias: "CITROEN", canonical: "CITROEN" },
  { alias: "PEUGEOT", canonical: "PEUGEOT" },
  { alias: "RENAULT", canonical: "RENAULT" },
  { alias: "TOYOTA", canonical: "TOYOTA" },
  { alias: "NISSAN", canonical: "NISSAN" },
  { alias: "HONDA", canonical: "HONDA" },
  { alias: "MITSUBISHI", canonical: "MITSUBISHI" },
  { alias: "MERCEDES", canonical: "MERCEDES-BENZ" },
  { alias: "VOLVO", canonical: "VOLVO" },
  { alias: "JAGUAR", canonical: "JAGUAR" },
  { alias: "PORSCHE", canonical: "PORSCHE" },
  { alias: "FERRARI", canonical: "FERRARI" },
  { alias: "LAMBORGHINI", canonical: "LAMBORGHINI" },
  { alias: "MASERATI", canonical: "MASERATI" },
  { alias: "ALFA ROMEO", canonical: "ALFA ROMEO" },
  { alias: "ASTON MARTIN", canonical: "ASTON MARTIN" },
  { alias: "CHERY", canonical: "CHERY" },
  { alias: "SUZUKI", canonical: "SUZUKI" },
  { alias: "SUBARU", canonical: "SUBARU" },
  { alias: "KIA", canonical: "KIA" },
  { alias: "FIAT", canonical: "FIAT" },
  { alias: "FORD", canonical: "FORD" },
  { alias: "JEEP", canonical: "JEEP" },
  { alias: "AUDI", canonical: "AUDI" },
  { alias: "BMW", canonical: "BMW" },
  { alias: "MINI", canonical: "MINI" },
  { alias: "RAM", canonical: "RAM" },
  { alias: "BYD", canonical: "BYD" },
  { alias: "GWM", canonical: "GWM" },
  { alias: "VW", canonical: "VOLKSWAGEN" }
];

function normalizeAlphaNumWords(raw: string): string {
  return normalizeText(raw).replace(/[^a-z0-9]+/g, " ").trim();
}

function inferBrandFromModelToken(modelTokenRaw: string): string {
  const token = normalizeAlphaNumWords(modelTokenRaw).replace(/\s+/g, "").toUpperCase();
  if (!token) return "";

  if (
    /^(GLE|GLA|GLB|GLC|GLK|GLS|CLA|CLS|C\d{3}|E\d{3}|S\d{3}|A\d{3}|B\d{3}|ML\d{3}|SL[KRC]?)/.test(
      token
    )
  ) {
    return "MERCEDES-BENZ";
  }

  return "";
}

function inferBrandFromListingText(raw: string): string {
  const normalized = normalizeAlphaNumWords(raw);
  if (!normalized) return "";

  for (const { alias, canonical } of BRAND_TITLE_ALIASES) {
    const aliasNormalized = normalizeAlphaNumWords(alias);
    if (!aliasNormalized) continue;

    if (
      normalized === aliasNormalized ||
      normalized.startsWith(`${aliasNormalized} `) ||
      normalized.includes(` ${aliasNormalized} `)
    ) {
      return canonical;
    }
  }

  return "";
}

function inferBrandFromTitle(titleRaw: string): string {
  const normalizedTitle = normalizeAlphaNumWords(titleRaw);
  if (!normalizedTitle) return "";

  for (const { alias, canonical } of BRAND_TITLE_ALIASES) {
    const aliasNormalized = normalizeAlphaNumWords(alias);
    if (!aliasNormalized) continue;
    if (normalizedTitle === aliasNormalized || normalizedTitle.startsWith(`${aliasNormalized} `)) {
      return canonical;
    }
  }

  return "";
}

function buildModelFromTitle(titleRaw: string, brandRaw: string): string {
  const titleWords = normalizeAlphaNumWords(titleRaw)
    .split(" ")
    .filter(Boolean);
  if (titleWords.length === 0) return "";

  const brandWords = normalizeAlphaNumWords(brandRaw).split(" ").filter(Boolean);
  const yearLike = (token: string): boolean => /^(?:19|20)\d{2}$/.test(token);
  const dropConsecutiveDuplicates = (tokens: string[]): string[] => {
    const out: string[] = [];
    for (const token of tokens) {
      if (out[out.length - 1] === token) continue;
      out.push(token);
    }
    return out;
  };

  if (
    brandWords.length > 0 &&
    titleWords.length > brandWords.length &&
    brandWords.every((word, idx) => titleWords[idx] === word)
  ) {
    return dropConsecutiveDuplicates(titleWords.slice(brandWords.length).filter((token) => !yearLike(token)))
      .join(" ")
      .toUpperCase();
  }

  return dropConsecutiveDuplicates(titleWords.filter((token) => !yearLike(token)))
    .join(" ")
    .toUpperCase();
}

function parseBrandModel(
  titleRaw: string,
  brandRaw: string,
  imageAltRaw: string
): { brand: string; model: string } {
  const title = normalizeSpace(titleRaw);
  const imageAlt = normalizeSpace(imageAltRaw);

  const titleModel = normalizeSpace(title.split(/\s+-\s+/)[0] ?? title);
  const altParts = imageAlt.split(/\s+-\s+/).map((part) => normalizeSpace(part)).filter(Boolean);
  const brandFromAlt = altParts[0] ?? "";
  const modelFromAlt = altParts.slice(1).join(" - ");
  const inferredBrand = inferBrandFromTitle(titleModel);
  const modelFromTitle = buildModelFromTitle(titleModel, normalizeSpace(brandRaw || brandFromAlt || inferredBrand));
  const modelTokenHint = normalizeSpace(modelFromTitle.split(" ")[0] ?? "");
  const inferredBrandFromModel = inferBrandFromModelToken(modelTokenHint);
  const brand =
    normalizeSpace(brandRaw || brandFromAlt || inferredBrand || inferredBrandFromModel).toUpperCase() ||
    "UNKNOWN";
  const model = normalizeSpace(modelFromTitle || modelFromAlt).toUpperCase() || "SEM MODELO";
  return { brand, model };
}

function parseTotalResults(raw: string): number | null {
  const normalized = normalizeSpace(raw);
  const match = normalized.match(/([\d.]+)\s+resultados?\s+encontrados/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1].replace(/\./g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSearchFragment(
  html: string,
  classification: VipClassification,
  log: (msg: string) => void
): SearchFragmentParseResult {
  const $ = load(html);
  const vehicles: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  const pushVehicleFromCard = (
    url: string,
    listingRawText: string,
    statusRaw: string | null,
    imageUrl: string,
    imageAltRaw: string
  ): void => {
    const listing = parseListingText(listingRawText, statusRaw);
    if (!listing.titleRaw || !looksLikeVehicleListingText(listingRawText)) {
      return;
    }

    const brandHint = inferBrandFromListingText(listingRawText);
    const { brand, model } = parseBrandModel(listing.titleRaw, brandHint, imageAltRaw);
    const year = parseYear(listing.titleRaw);
    const priceInfo = parsePrice(listingRawText);
    const fallbackDescription = listing.description || normalizeSpace(statusRaw).slice(0, 240);

    vehicles.push({
      source: "vipleiloes",
      brand,
      model,
      year,
      damage: buildVipDamageLabel(classification, listingRawText, statusRaw),
      price: priceInfo.price,
      priceRaw: priceInfo.priceRaw,
      imageUrls: imageUrl ? [imageUrl] : [],
      description: fallbackDescription,
      url,
      auctionDate: listing.auctionDate,
      lot: listing.lot,
      km: listing.km,
      yard: listing.yard
    });
  };

  $(".card.card-anuncio, .card-anuncio").each((_index, element) => {
    const card = $(element);
    const bodyAnchor =
      card.find("a.anc-body[href*='/evento/anuncio/']").first().length > 0
        ? card.find("a.anc-body[href*='/evento/anuncio/']").first()
        : card.find("a[href*='/evento/anuncio/'], a[href*='/Veiculos/DetalharVeiculo/'], a[href*='/veiculos/detalharveiculo/']").first();

    const href = bodyAnchor.attr("href") ?? "";
    const url = toAbsoluteUrl(href);
    if (!url || seenUrls.has(url)) return;
    seenUrls.add(url);

    const listingRawText = normalizeSpace(bodyAnchor.text() || card.text());
    const status =
      normalizeSpace(card.find(".situacao").first().text()) ||
      extractVipStatusText(card.text()) ||
      null;
    const imageUrl = pickFirstImageUrl(
      (attr) => card.find(".crd-image img").first().attr(attr),
      (attr) => bodyAnchor.find("img").first().attr(attr),
      (attr) => card.find("img").first().attr(attr),
      (attr) => card.find(".crd-image").first().attr(attr),
      (attr) => card.find("[style*='background']").first().attr(attr)
    );
    const imageAlt = normalizeSpace(
      card.find(".crd-image img").first().attr("alt") ??
        bodyAnchor.find("img").first().attr("alt") ??
        card.find("img").first().attr("alt") ??
        ""
    );

    pushVehicleFromCard(url, listingRawText, status, imageUrl, imageAlt);
  });

  // Fallback para layouts novos da VIP (cards sem classes legadas).
  $("a[href]").each((_index, element) => {
    const anchor = $(element);
    const hrefRaw = anchor.attr("href") ?? "";
    const href = toAbsoluteUrl(hrefRaw);
    if (!href || seenUrls.has(href)) return;

    const isDetailUrl =
      /\/Veiculos\/DetalharVeiculo\//i.test(href) ||
      /\/evento\/anuncio\//i.test(href);
    const anchorText = normalizeSpace(anchor.text());
    if (!isDetailUrl && !looksLikeVehicleListingText(anchorText)) {
      return;
    }

    const container =
      anchor.closest(".card").length > 0
        ? anchor.closest(".card")
        : anchor.closest("article, li, .item, .swiper-slide, .col");

    const mergedText = normalizeSpace(`${anchorText} ${container.text()}`);
    if (!looksLikeVehicleListingText(mergedText)) {
      return;
    }

    const imageUrl = pickFirstImageUrl(
      (attr) => container.find("img").first().attr(attr),
      (attr) => anchor.find("img").first().attr(attr),
      (attr) => container.find("[style*='background']").first().attr(attr)
    );
    const imageAlt = normalizeSpace(
      container.find("img").first().attr("alt") ??
        anchor.find("img").first().attr("alt") ??
        ""
    );
    const statusText = extractVipStatusText(container.text());

    seenUrls.add(href);
    pushVehicleFromCard(href, mergedText, statusText, imageUrl, imageAlt);
  });

  const activePageText =
    normalizeSpace($("#CurrentPage").attr("value")) ||
    normalizeSpace($(".pagination .page-item.active .page-link").first().text());
  const activePageParsed = Number.parseInt(activePageText, 10);
  const currentPage = Number.isFinite(activePageParsed) ? activePageParsed : null;

  let nextAjaxUrl =
    $(".page-item.page-go:not(.disabled) a.page-link[aria-label='Next']").first().attr("data-ajax-url") ??
    "";
  if (!nextAjaxUrl) {
    const candidates = $(".pagination a.page-link[data-ajax-url]")
      .toArray()
      .map((item) => ($(item).attr("data-ajax-url") ?? "").replace(/&amp;/g, "&").trim())
      .filter((url) => /pageNumber=\d+/i.test(url))
      .map((url) => ({
        url,
        pageNumber: Number.parseInt(url.match(/pageNumber=(\d+)/i)?.[1] ?? "", 10)
      }))
      .filter((item) => Number.isFinite(item.pageNumber));

    const nextCandidate = candidates
      .filter((item) => currentPage == null || item.pageNumber > currentPage)
      .sort((a, b) => a.pageNumber - b.pageNumber)[0];

    nextAjaxUrl = nextCandidate?.url ?? "";
  }
  nextAjaxUrl = ensureClassificationQuery(nextAjaxUrl.replace(/&amp;/g, "&").trim(), classification);
  if (nextAjaxUrl && !/handler=pesquisar/i.test(nextAjaxUrl)) {
    const onclickText =
      $(".page-item.page-go:not(.disabled) a.page-link[aria-label='Next']").first().attr("onclick") ??
      "";
    const onclickUrl = onclickText.match(/['"]([^'"]*handler=pesquisar[^'"]*)['"]/i)?.[1] ?? "";
    nextAjaxUrl = onclickUrl ? ensureClassificationQuery(onclickUrl.replace(/&amp;/g, "&"), classification) : "";
  }

  const totalResults = parseTotalResults($("#resultadosEncontrados").first().text());

  log(
    `[vipleiloes][${classification.name}] Página ${currentPage ?? "?"}: ${vehicles.length} lote(s) extraído(s).`
  );

  return {
    vehicles,
    nextAjaxUrl: nextAjaxUrl || null,
    currentPage,
    totalResults
  };
}

async function collectFromCurrentPageHtml(
  page: Page,
  all: AuctionVehicle[],
  seenUrls: Set<string>,
  classification: VipClassification,
  log: (msg: string) => void
): Promise<{ added: number; parsed: SearchFragmentParseResult }> {
  const html = await page.content();
  const parsed = parseSearchFragment(html, classification, log);
  let added = 0;

  for (const vehicle of parsed.vehicles) {
    if (seenUrls.has(vehicle.url)) continue;
    seenUrls.add(vehicle.url);
    all.push(vehicle);
    added += 1;
  }

  return { added, parsed };
}

async function clickLoadMoreIfAvailable(page: Page): Promise<boolean> {
  const loadMore = page.locator("button:has-text('Exibir Mais'), a:has-text('Exibir Mais')").first();
  const visible = await loadMore.isVisible().catch(() => false);
  if (!visible) return false;

  await loadMore.click({ timeout: 8_000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 12_000 }).catch(() => undefined);
  await page.waitForTimeout(1_200);
  return true;
}

function looksLikeCloudflareChallenge(html: string): boolean {
  const marker = html.toLowerCase();
  return (
    marker.includes("just a moment") ||
    marker.includes("performing security verification") ||
    marker.includes("enable javascript and cookies to continue") ||
    marker.includes("cdn-cgi/challenge-platform")
  );
}

function isHtmlDocument(raw: string): boolean {
  return /<html[\s>]/i.test(raw) && /<body[\s>]/i.test(raw);
}

function looksLikeVipListingPage(rawHtml: string): boolean {
  const html = rawHtml.toLowerCase();
  return (
    html.includes("detalharveiculo") ||
    html.includes("card-anuncio") ||
    html.includes("resultadosencontrados") ||
    html.includes("filtro.classificacao") ||
    html.includes("formpost")
  );
}

async function detectVipProtection(page: Page): Promise<string | null> {
  const html = await page.content().catch(() => "");
  const text = (await page.textContent("body").catch(() => "")) ?? "";
  const marker = `${html}\n${text}`.toLowerCase();

  if (
    marker.includes("just a moment") ||
    marker.includes("performing security verification") ||
    marker.includes("enable javascript and cookies to continue") ||
    marker.includes("cdn-cgi/challenge-platform")
  ) {
    return "cloudflare";
  }

  return null;
}

async function detectVipProtectionWithRetry(
  page: Page,
  log: (msg: string) => void
): Promise<string | null> {
  let reason = await detectVipProtection(page);
  if (!reason) return null;

  log("[vipleiloes] Desafio anti-bot detectado, aguardando validação automática...");
  await page.waitForTimeout(6_000);
  await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
  await page.waitForTimeout(2_000);

  reason = await detectVipProtection(page);
  return reason;
}

async function fetchSearchPartial(
  page: Page,
  ajaxUrl: string,
  classification: VipClassification
): Promise<PartialFetchResult> {
  return page.evaluate(async ({ ajaxUrlInput, defaultPath, classificationName }) => {
    try {
      const form = document.getElementById("formPost");
      if (!(form instanceof HTMLFormElement)) {
        return {
          ok: false,
          status: 0,
          requestUrl: ajaxUrlInput || defaultPath,
          html: "",
          error: "form_not_found"
        };
      }

      const requestUrlRaw = new URL(ajaxUrlInput || defaultPath, window.location.origin);
      requestUrlRaw.searchParams.set("classificacao", classificationName);
      if (!requestUrlRaw.searchParams.get("handler")) {
        requestUrlRaw.searchParams.set("handler", "pesquisar");
      }
      const requestUrl = requestUrlRaw.toString();
      const requestParsed = new URL(requestUrl);
      const pageNumber = requestParsed.searchParams.get("pageNumber")?.trim() ?? "";

      const body = new URLSearchParams();
      const formData = new FormData(form);
      formData.forEach((value, key) => {
        if (typeof value === "string") {
          body.append(key, value);
        }
      });

      const normalize = (value: string) =>
        value
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "")
          .trim();

      const classificacaoSelect = form.querySelector(
        'select[name="Filtro.Classificacao"]'
      ) as HTMLSelectElement | null;
      const selectedClassificationOption = classificacaoSelect
        ? Array.from(classificacaoSelect.options).find(
            (option) => {
              const optionKey = normalize(option.textContent ?? "");
              const targetKey = normalize(classificationName);
              return Boolean(optionKey && targetKey) && (optionKey.includes(targetKey) || targetKey.includes(optionKey));
            }
          ) ?? null
        : null;
      const classificationValue = (selectedClassificationOption?.value ?? classificationName).trim() || classificationName;

      if (classificacaoSelect) {
        classificacaoSelect.value = classificationValue;
      }

      body.set("Filtro.Classificacao", classificationValue);
      body.set("Filtro.SelecaoVeiculos", "true");
      body.set("Filtro.SelecaoOutros", "false");
      if (pageNumber) {
        body.set("CurrentPage", pageNumber);
        body.set("Filtro.CurrentPage", pageNumber);
      }
      if (!body.get("Filtro.OrdenarPor")) {
        body.set("Filtro.OrdenarPor", "DataInicio");
      }

      const response = await fetch(requestUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "X-Requested-With": "XMLHttpRequest"
        },
        body: body.toString(),
        credentials: "same-origin"
      });

      const html = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        requestUrl: response.url || requestUrl,
        html
      };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        requestUrl: ajaxUrlInput || defaultPath,
        html: "",
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }, {
    ajaxUrlInput: ajaxUrl,
    defaultPath: buildSearchHandlerPath(classification),
    classificationName: classification.name
  });
}

export async function scrapeVipLeiloes(
  _filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const maxPages = parseMaxPagesFromEnv();
  const headless = options?.headless ?? true;
  const browser = await chromium.launch(buildPlaywrightLaunchOptions(headless));
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    locale: "pt-BR"
  });
  const page = await context.newPage();

  const all: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  try {
    log(`[vipleiloes] Iniciando (${DEFAULT_CLASSIFICATIONS.map((item) => item.name).join(", ")})...`);

    for (const classification of DEFAULT_CLASSIFICATIONS) {
    const classificationStartCount = all.length;
    const visitedAjaxUrls = new Set<string>();
    log(`[vipleiloes][${classification.name}] Iniciando classificação...`);
    const startCandidates = [buildStartUrl(classification), ...START_URL_FALLBACKS];
    let selectedStartUrl = "";
    let selectedLooksReady = false;

    for (const candidate of startCandidates) {
      log(`[vipleiloes][${classification.name}] Abrindo URL inicial candidata: ${candidate}`);
      await page.goto(candidate, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
      await page.waitForTimeout(1_500);
      log(`[vipleiloes][${classification.name}] URL carregada: ${page.url()}`);

      const protection = await detectVipProtectionWithRetry(page, log);
      if (protection) {
        log(
          "[vipleiloes] Bloqueio anti-bot persistente. " +
            "Abra manualmente o site com o perfil configurado e tente novamente."
        );
        return [];
      }

      selectedStartUrl = page.url();
      const html = await page.content().catch(() => "");
      selectedLooksReady =
        looksLikeVipListingPage(html) &&
        !/\/canal(?:\/|$|\?)/i.test(selectedStartUrl);
      if (selectedLooksReady) {
        break;
      }
    }

    if (!selectedLooksReady) {
      log(
        `[vipleiloes][${classification.name}] Nenhuma URL inicial confirmou listagem claramente. ` +
          `Prosseguindo com fallback a partir de ${selectedStartUrl || page.url()}.`
      );
    }

    const firstDomCollection = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
    if (firstDomCollection.added > 0) {
      log(`[vipleiloes][${classification.name}] Coleta inicial no DOM: +${firstDomCollection.added}, acumulado=${all.length}.`);
    }

    let ajaxUrl: string | null =
      firstDomCollection.parsed.nextAjaxUrl != null
        ? ensureClassificationQuery(firstDomCollection.parsed.nextAjaxUrl, classification)
        : buildSearchHandlerPath(classification);
    let pageAttempt = 0;
    let loggedTotal = false;

    while (pageAttempt < maxPages) {
      if (!ajaxUrl) {
        const clicked = await clickLoadMoreIfAvailable(page);
        if (!clicked) {
          log("[vipleiloes] Sem próxima página e sem botão 'Exibir Mais'. Encerrando.");
          break;
        }

        const domAfterClick = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
        if (!loggedTotal && domAfterClick.parsed.totalResults != null) {
          loggedTotal = true;
          log(`[vipleiloes][${classification.name}] ${domAfterClick.parsed.totalResults} resultado(s) reportado(s) no filtro ${classification.name}.`);
        }
        log(
          `[vipleiloes][${classification.name}] Após 'Exibir Mais': +${domAfterClick.added} novo(s), acumulado=${all.length}.`
        );
        ajaxUrl = domAfterClick.parsed.nextAjaxUrl
          ? ensureClassificationQuery(domAfterClick.parsed.nextAjaxUrl, classification)
          : null;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const normalizedAjaxUrl = ensureClassificationQuery(ajaxUrl.replace(/&amp;/g, "&"), classification);
      if (visitedAjaxUrls.has(normalizedAjaxUrl)) {
        log(`[vipleiloes] Loop de paginação detectado em ${normalizedAjaxUrl}. Encerrando.`);
        break;
      }
      visitedAjaxUrls.add(normalizedAjaxUrl);
      pageAttempt += 1;

      log(`[vipleiloes][${classification.name}] Coletando página ${pageAttempt}/${maxPages} (${normalizedAjaxUrl})...`);
      let partial = await fetchSearchPartial(page, normalizedAjaxUrl, classification);

      if (
        partial.ok &&
        isHtmlDocument(partial.html) &&
        !partial.html.includes("card-anuncio") &&
        looksLikeCloudflareChallenge(partial.html)
      ) {
        log("[vipleiloes] Resposta de challenge detectada no AJAX. Recarregando sessão...");
        await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
        partial = await fetchSearchPartial(page, normalizedAjaxUrl, classification);
      }

      if (!partial.ok) {
        const reason = partial.error ? ` (${partial.error})` : "";
        log(`[vipleiloes][${classification.name}] Falha ao buscar parcial: HTTP ${partial.status}${reason}. Tentando fallback via DOM.`);

        const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
        if (!loggedTotal && domFallback.parsed.totalResults != null) {
          loggedTotal = true;
          log(`[vipleiloes][${classification.name}] ${domFallback.parsed.totalResults} resultado(s) reportado(s) no filtro ${classification.name}.`);
        }
        log(`[vipleiloes][${classification.name}] Fallback DOM: +${domFallback.added} novo(s), acumulado=${all.length}.`);
        ajaxUrl = domFallback.parsed.nextAjaxUrl
          ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification)
          : null;

        if (!ajaxUrl) {
          const clicked = await clickLoadMoreIfAvailable(page);
          if (!clicked) break;
          const domAfterClick = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
          log(
            `[vipleiloes][${classification.name}] Após 'Exibir Mais' (fallback): +${domAfterClick.added} novo(s), acumulado=${all.length}.`
          );
          ajaxUrl = domAfterClick.parsed.nextAjaxUrl
            ? ensureClassificationQuery(domAfterClick.parsed.nextAjaxUrl, classification)
            : null;
        }
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      if (looksLikeCloudflareChallenge(partial.html)) {
        log(`[vipleiloes][${classification.name}] Challenge anti-bot retornado no endpoint de pesquisa. Tentando fallback via DOM.`);
        const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
        log(`[vipleiloes][${classification.name}] Fallback DOM (challenge): +${domFallback.added} novo(s), acumulado=${all.length}.`);
        ajaxUrl = domFallback.parsed.nextAjaxUrl
          ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification)
          : null;
        if (!ajaxUrl) break;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      if (isHtmlDocument(partial.html) && !partial.html.includes("card-anuncio")) {
        log(
          `[vipleiloes][${classification.name}] Endpoint retornou HTML completo inesperado (sem cards). Tentando fallback via DOM.`
        );
        const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
        log(`[vipleiloes][${classification.name}] Fallback DOM (HTML completo): +${domFallback.added} novo(s), acumulado=${all.length}.`);
        ajaxUrl = domFallback.parsed.nextAjaxUrl
          ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification)
          : null;
        if (!ajaxUrl) break;
        await sleep(REQUEST_DELAY_MS);
        continue;
      }

      const parsed = parseSearchFragment(partial.html, classification, log);
      if (!loggedTotal && parsed.totalResults != null) {
        loggedTotal = true;
        log(`[vipleiloes][${classification.name}] ${parsed.totalResults} resultado(s) reportado(s) no filtro ${classification.name}.`);
      }

      let added = 0;
      for (const vehicle of parsed.vehicles) {
        if (seenUrls.has(vehicle.url)) continue;
        seenUrls.add(vehicle.url);
        all.push(vehicle);
        added += 1;
      }

      log(
        `[vipleiloes][${classification.name}] Página ${parsed.currentPage ?? pageAttempt}: +${added} novo(s), acumulado=${all.length}.`
      );

      const nextUrl = parsed.nextAjaxUrl?.replace(/&amp;/g, "&").trim() ?? "";
      ajaxUrl = nextUrl ? ensureClassificationQuery(nextUrl, classification) : null;

      if (!ajaxUrl && added === 0) {
        const domFallback = await collectFromCurrentPageHtml(page, all, seenUrls, classification, log);
        if (domFallback.added > 0) {
          log(
            `[vipleiloes][${classification.name}] Revalidação DOM após parcial vazia: +${domFallback.added} novo(s), acumulado=${all.length}.`
          );
        }
        ajaxUrl = domFallback.parsed.nextAjaxUrl
          ? ensureClassificationQuery(domFallback.parsed.nextAjaxUrl, classification)
          : null;
      }

      await sleep(REQUEST_DELAY_MS);
    }

    if (pageAttempt >= maxPages && ajaxUrl) {
      log(
        `[vipleiloes][${classification.name}] Limite de ${maxPages} página(s) atingido; ` +
          "a categoria pode ter mais lotes. Aumente VIPLEILOES_MAX_PAGES se necessário."
      );
    }

    log(
      `[vipleiloes][${classification.name}] Classificação concluída: +${
        all.length - classificationStartCount
      } novo(s), acumulado=${all.length}.`
    );
    await sleep(REQUEST_DELAY_MS);
    }
  } catch (error) {
    log(`[vipleiloes] Erro: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  } finally {
    await context.close();
    await browser.close();
  }

  log(`[vipleiloes] Total: ${all.length} veículo(s).`);
  return all;
}
