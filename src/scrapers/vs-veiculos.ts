import { load } from "cheerio";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";

const BASE = "https://vsveiculos.com.br";
const VS_DEFAULT_CITY = "Pinhais";
const VS_DEFAULT_STATE = "PR";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

// /carros/{damage}/{city}/{brand}/{model}/{year}/{code}
// ex: /carros/media-monta/pinhais/chevrolet/onix/2016/K54ATUYF5
function parseCardUrl(href: string): {
  brand: string;
  model: string;
  damage: string;
  city: string;
  year: number | null;
} {
  const parts = href.replace(/^\/carros\//, "").split("/");
  const damage = (parts[0] ?? "").replace(/-/g, " ");
  const city = (parts[1] ?? "").replace(/-/g, " ").trim() || VS_DEFAULT_CITY;
  const brand = (parts[2] ?? "").replace(/-/g, " ");
  const model = (parts[3] ?? "").replace(/-/g, " ");
  const yearPart = parseInt(parts[4] ?? "", 10);
  const year = Number.isFinite(yearPart) && yearPart >= 1900 && yearPart <= 2100 ? yearPart : null;
  return { brand, model, damage, city, year };
}

function parseVehicleIdFromHref(href: string): string | null {
  const parts = href.replace(/^\/carros\//, "").replace(/\/$/, "").split("/");
  return parts[parts.length - 1] || null;
}

function buildPageUrl(): string {
  return `${BASE}/estoque`;
}

function parseYearFromText(text: string): number | null {
  const match = text.match(/(20\d{2})\/(20\d{2})/);
  if (match?.[1]) return parseInt(match[1], 10);
  const m2 = text.match(/\b(20\d{2})\b/);
  return m2?.[1] ? parseInt(m2[1], 10) : null;
}

async function fetchPage(url: string, log: (m: string) => void): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) {
      log(`[vs] HTTP ${res.status} em ${url}`);
      return null;
    }
    return res.text();
  } catch (err) {
    log(`[vs] Erro ao buscar ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseMoneyValue(text: string): { value: number | null; raw: string | null } {
  const match = text.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i);
  if (!match?.[1]) return { value: null, raw: null };

  const numericText = match[1];
  const normalized = numericText.includes(",")
    ? numericText.replace(/\./g, "").replace(",", ".")
    : numericText.replace(/\./g, "");
  const value = Number(normalized);

  return {
    value: Number.isFinite(value) && value > 0 ? Math.round(value) : null,
    raw: `R$ ${numericText}`
  };
}

function parseCards(html: string, log: (m: string) => void, availableAt: Date): AuctionVehicle[] {
  const $ = load(html);
  const results: AuctionVehicle[] = [];
  const seen = new Set<string>();

  // Cards são <a class="carro" href="/carros/{damage}/{city}/{brand}/{model}/{year}/{code}">
  $("a.carro[href^=\"/carros/\"]").each((_i, el) => {
    const card = $(el);
    const href = card.attr("href") ?? "";
    if (!href || seen.has(href)) return;
    seen.add(href);

    const vehicleId = parseVehicleIdFromHref(href);
    if (!vehicleId) return;
    const cardUrl = `${BASE}${href}`;
    const rawText = card.text().replace(/\s+/g, " ").trim();

    if (!rawText) return;

    const { brand: brandFromUrl, model: modelFromUrl, damage, city, year: yearFromUrl } = parseCardUrl(href);
    const brand = (card.find(".marca").first().text().trim() || brandFromUrl).toUpperCase();
    const title = card.find("h3").first().text().trim();

    const priceValue = parseMoneyValue(card.find(".preco .por").first().text());
    const fallbackPrice = parseMoneyValue(rawText);
    const price = priceValue.value ?? fallbackPrice.value;
    const priceRaw = priceValue.raw ?? fallbackPrice.raw;
    const fipeValue = parseMoneyValue(card.find(".preco .fipe").first().text());
    const year = yearFromUrl ?? parseYearFromText(rawText);

    const imgSrc = card.find("img").first().attr("src") ?? "";
    const imgLazy = card.find("img").first().attr("data-src") ?? "";
    const imageUrlRaw = imgSrc || imgLazy;
    const imageUrl = imageUrlRaw ? new URL(imageUrlRaw, BASE).toString() : "";

    const description = (title || rawText.replace(/mais detalhes/gi, "")).replace(/\s{2,}/g, " ").trim().slice(0, 250);

    results.push({
      source: "vs-veiculos",
      brand: brand || "UNKNOWN",
      model: (modelFromUrl || title).toUpperCase() || rawText.slice(0, 40),
      year,
      damage: damage || null,
      price,
      priceRaw,
      imageUrls: imageUrl ? [imageUrl] : [],
      description,
      url: cardUrl,
      auctionDate: availableAt,
      lot: vehicleId,
      yard: `${city} - ${VS_DEFAULT_STATE}`,
      city,
      state: VS_DEFAULT_STATE,
      fipe: fipeValue.value,
      fipeRaw: fipeValue.raw
    });
  });

  log(`[vs] ${results.length} card(s) válido(s).`);
  return results;
}

export async function scrapeVsVeiculos(
  filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const availableAt = new Date();

  // O estoque atual da VS não é paginado: /estoque já traz todos os veículos numa única página.
  const url = buildPageUrl();
  log(`[vs] Buscando: ${url}`);

  const html = await fetchPage(url, log);
  if (!html) {
    log("[vs] Falha ao carregar o estoque.");
    return [];
  }

  const results = parseCards(html, log, availableAt);
  log(`[vs] Total: ${results.length} veículo(s) após filtros.`);
  return results;
}
