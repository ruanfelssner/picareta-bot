import { load, type CheerioAPI } from "cheerio";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";

const BASE_URL = "https://www.vardanaleiloes.com.br/vardana";
const INDEX_URL = `${BASE_URL}/index`;
const DETAIL_URL = "https://vardana.com.br/veiculo-detalhes-logado";
const VARDANA_YARD = "Curitiba - PR";
const FALLBACK_AUCTION_IDS = ["1075", "1076"];
const PAGE_DELAY_MS = 500;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

type VardanaAuction = {
  id: string;
  url: string;
};

type OpenWindowCall = {
  auctionId: string;
  lotNumber: string;
  vehicleId: string;
};

type CheerioSelection = ReturnType<CheerioAPI>;

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

function normalizeKey(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function toAbsoluteUrl(raw: string | null | undefined): string | null {
  const value = normalizeSpace(raw);
  if (!value) return null;

  try {
    return new URL(value, `${BASE_URL}/`).toString();
  } catch {
    return null;
  }
}

async function fetchHtml(url: string, log: (message: string) => void): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: HEADERS });
    if (!response.ok) {
      log(`[vardana] HTTP ${response.status} em ${url}`);
      return null;
    }
    return response.text();
  } catch (error) {
    log(`[vardana] Erro ao buscar ${url}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function parseAuctionIdsFromEnv(): string[] {
  const raw = normalizeSpace(process.env.VARDANA_LEILAO_IDS);
  if (!raw) return [];

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of raw.split(",")) {
    const id = item.trim();
    if (!/^\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function buildAuctionUrl(id: string): string {
  return `${BASE_URL}/veiculos.php?lei=${encodeURIComponent(id)}`;
}

function parseAuctionLinksFromIndex(html: string): VardanaAuction[] {
  const $ = load(html);
  const auctions: VardanaAuction[] = [];
  const seen = new Set<string>();

  $('a[href*="veiculos.php?lei="]').each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;

    try {
      const url = new URL(href, `${BASE_URL}/`);
      const id = url.searchParams.get("lei")?.trim() ?? "";
      if (!/^\d+$/.test(id) || seen.has(id)) return;
      seen.add(id);
      auctions.push({ id, url: url.toString() });
    } catch {
      // Ignora links malformados.
    }
  });

  return auctions;
}

async function discoverAuctions(log: (message: string) => void): Promise<VardanaAuction[]> {
  const envIds = parseAuctionIdsFromEnv();
  if (envIds.length > 0) {
    return envIds.map((id) => ({ id, url: buildAuctionUrl(id) }));
  }

  const indexHtml = await fetchHtml(INDEX_URL, log);
  const discovered = indexHtml ? parseAuctionLinksFromIndex(indexHtml) : [];
  if (discovered.length > 0) {
    log(`[vardana] ${discovered.length} leilão(ões) descoberto(s) no índice.`);
    return discovered;
  }

  log(`[vardana] Usando fallback de leilões: ${FALLBACK_AUCTION_IDS.join(", ")}.`);
  return FALLBACK_AUCTION_IDS.map((id) => ({ id, url: buildAuctionUrl(id) }));
}

function parseAuctionDate(html: string): Date | null {
  const $ = load(html);
  const sideDate = normalizeSpace($(".b-items__aside-sell-img h3").first().text());
  const text = sideDate || $.text();
  const match = text.match(/\b(\d{2})\/(\d{2})\/(\d{4})\b/);
  if (!match) return null;

  const day = Number.parseInt(match[1] ?? "", 10);
  const month = Number.parseInt(match[2] ?? "", 10);
  const year = Number.parseInt(match[3] ?? "", 10);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;

  return new Date(year, month - 1, day);
}

function parseOpenWindowCall(raw: string | null | undefined): OpenWindowCall | null {
  const match = normalizeSpace(raw).match(/openWindow\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/i);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return {
    auctionId: match[1],
    lotNumber: match[2],
    vehicleId: match[3]
  };
}

function parseOpenWindowCallFromBox($: CheerioAPI, box: CheerioSelection): OpenWindowCall | null {
  let fallback: OpenWindowCall | null = null;
  let selected: OpenWindowCall | null = null;

  box.find('a[onclick*="openWindow"]').each((_index, element) => {
    const parsed = parseOpenWindowCall($(element).attr("onclick"));
    if (!parsed) return;
    fallback ??= parsed;
    if (parsed.lotNumber !== "0") {
      selected = parsed;
      return false;
    }
  });

  return selected ?? fallback;
}

function buildDetailUrl(call: OpenWindowCall): string {
  const url = new URL(DETAIL_URL);
  url.searchParams.set("lei", call.auctionId);
  url.searchParams.set("_id", call.lotNumber);
  url.searchParams.set("cov", call.vehicleId);
  return url.toString();
}

function parsePrice(raw: string): { price: number | null; priceRaw: string | null } {
  const match = raw.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
  if (!match?.[1]) return { price: null, priceRaw: null };

  const numeric = Number.parseFloat(match[1].replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(numeric) || numeric <= 0) return { price: null, priceRaw: `R$ ${match[1]}` };

  return {
    price: Math.round(numeric),
    priceRaw: `R$ ${match[1]}`
  };
}

function parseTwoDigitYear(value: number): number {
  return value >= 80 ? 1900 + value : 2000 + value;
}

function parseYear(raw: string | null | undefined): number | null {
  const text = normalizeSpace(raw);
  if (!text) return null;

  const full = text.match(/\b((?:19|20)\d{2})\s*\/\s*((?:19|20)\d{2})\b/);
  if (full?.[1]) return Number.parseInt(full[1], 10);

  const short = text.match(/\b(\d{2})\s*\/\s*(\d{2})\b/);
  if (short?.[1]) {
    return parseTwoDigitYear(Number.parseInt(short[1], 10));
  }

  const fallback = text.match(/\b((?:19|20)\d{2})\b/);
  return fallback?.[1] ? Number.parseInt(fallback[1], 10) : null;
}

function parseTitleParts(title: string): { brand: string; model: string } {
  const normalized = normalizeSpace(title).toUpperCase();
  if (!normalized) return { brand: "UNKNOWN", model: "UNKNOWN" };

  const slashIndex = normalized.indexOf("/");
  if (slashIndex > -1) {
    const brandPrefix = normalizeSpace(normalized.slice(0, slashIndex));
    const rest = normalizeSpace(normalized.slice(slashIndex + 1));
    if ((brandPrefix === "I" || brandPrefix === "IMP") && rest) {
      const [brand = "UNKNOWN", ...modelParts] = rest.split(/\s+/);
      return {
        brand,
        model: modelParts.join(" ") || rest
      };
    }

    return {
      brand: brandPrefix || "UNKNOWN",
      model: rest || normalized
    };
  }

  const [brand = "UNKNOWN", ...modelParts] = normalized.split(/\s+/);
  return {
    brand,
    model: modelParts.join(" ") || normalized
  };
}

function extractFields($: CheerioAPI, box: CheerioSelection): Record<string, string> {
  const fields: Record<string, string> = {};

  box.find(".b-items__cars-one-info-title").each((_index, element) => {
    const text = normalizeSpace($(element).text());
    const separator = text.indexOf(":");
    if (separator < 0) return;

    const key = normalizeKey(text.slice(0, separator));
    const value = normalizeSpace(text.slice(separator + 1));
    if (key && value) {
      fields[key] = value;
    }
  });

  return fields;
}

function parseLotLabel(box: CheerioSelection, fallback: string): string {
  const match = normalizeSpace(box.find(".label").first().text()).match(/Lote\s+([0-9]+)/i);
  return match?.[1] ?? fallback;
}

function parseCardTitle(box: CheerioSelection): string | null {
  const fromBold = normalizeNullableText(box.find("h2 a b").first().text());
  if (fromBold) return fromBold;

  const h2Text = normalizeSpace(box.find("h2").first().text()).replace(/^Lote\s+\d+\s*/i, "");
  return normalizeNullableText(h2Text);
}

function parseCardPrice($: CheerioAPI, box: CheerioSelection): { price: number | null; priceRaw: string | null } {
  const fromPriceHeading = normalizeSpace(
    box
      .find("h4")
      .filter((_index, element) => /color\s*:\s*#?ad1924/i.test($(element).attr("style") ?? ""))
      .first()
      .text()
  );
  if (fromPriceHeading) return parsePrice(fromPriceHeading);

  return parsePrice(normalizeSpace(box.text()));
}

function buildDescription(input: {
  auctionId: string;
  auctionDate: Date | null;
  fuel: string | null;
  color: string | null;
  plate: string | null;
  obs: string | null;
}): string {
  const parts = [`Vardana Leilões - Curitiba/PR`, `Leilão ${input.auctionId}`];
  if (input.auctionDate) {
    parts.push(`Data ${input.auctionDate.toLocaleDateString("pt-BR")}`);
  }
  if (input.fuel) parts.push(`Combustível: ${input.fuel}`);
  if (input.color) parts.push(`Cor: ${input.color}`);
  if (input.plate) parts.push(`Placa: ${input.plate}`);
  if (input.obs) parts.push(`Obs: ${input.obs}`);
  return parts.join(" · ");
}

function parseVehiclesFromAuctionPage(
  html: string,
  auction: VardanaAuction,
  log: (message: string) => void
): AuctionVehicle[] {
  const $ = load(html);
  const auctionDate = parseAuctionDate(html);
  const vehicles: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  $(".box_veiculos").each((_index, element) => {
    const box = $(element);
    const call = parseOpenWindowCallFromBox($, box);
    if (!call) return;

    const title = parseCardTitle(box);
    if (!title) return;

    const lot = parseLotLabel(box, call.lotNumber !== "0" ? call.lotNumber : call.vehicleId);
    const detailUrl = buildDetailUrl({ ...call, lotNumber: lot });
    if (seenUrls.has(detailUrl)) return;

    const imageUrl = toAbsoluteUrl(box.find("img[src*='img_leiloes']").first().attr("src"));
    const fields = extractFields($, box);
    const fuel = normalizeNullableText(fields.combustivel);
    const color = normalizeNullableText(fields.cor);
    const plate = normalizeNullableText(fields.placa);
    const obs = normalizeNullableText(fields.obs);
    const year = parseYear(fields.ano);
    const { price, priceRaw } = parseCardPrice($, box);
    const { brand, model } = parseTitleParts(title);

    seenUrls.add(detailUrl);
    vehicles.push({
      source: "vardana",
      brand,
      model,
      year,
      damage: null,
      price,
      priceRaw,
      priceLabel: "Lance sugerido",
      imageUrls: imageUrl ? [imageUrl] : [],
      description: buildDescription({
        auctionId: auction.id,
        auctionDate,
        fuel,
        color,
        plate,
        obs
      }),
      url: detailUrl,
      auctionDate,
      lot,
      color,
      yard: VARDANA_YARD
    });
  });

  log(`[vardana] Leilão ${auction.id}: ${vehicles.length} veículo(s) na relação.`);
  return vehicles;
}

export async function scrapeVardana(
  _filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const allVehicles: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  console.info("[scraper:vardana] iniciando");
  log("[vardana] Iniciando Vardana Leilões.");

  const auctions = await discoverAuctions(log);
  for (let index = 0; index < auctions.length; index += 1) {
    const auction = auctions[index];
    if (!auction) continue;

    log(`[vardana] Buscando leilão ${auction.id}: ${auction.url}`);
    const html = await fetchHtml(auction.url, log);
    if (!html) continue;

    for (const vehicle of parseVehiclesFromAuctionPage(html, auction, log)) {
      if (seenUrls.has(vehicle.url)) continue;
      seenUrls.add(vehicle.url);
      allVehicles.push(vehicle);
    }

    if (index < auctions.length - 1) {
      await sleep(PAGE_DELAY_MS);
    }
  }

  log(`[vardana] Total: ${allVehicles.length} veículo(s).`);
  console.info(`[scraper:vardana] finalizado (${allVehicles.length} veículos)`);
  return allVehicles;
}
