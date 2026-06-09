import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";

const BASE_URL = "https://www.claudiokussleiloes.com.br";
const JSON_URL = `${BASE_URL}/json_edital.php`;
const DISCOVERY_URL = `${BASE_URL}/proximos-leiloes`;
const FALLBACK_DISCOVERY_URL = `${BASE_URL}/`;
const CLAUDIO_KUSS_DEFAULT_YARD = "Curitiba - PR";

const DEFAULT_MAX_PAGES_PER_AUCTION = 40;
const DEFAULT_MAX_AUCTIONS = 4;
const PAGE_DELAY_MS = 120;
const CLAUDIO_KUSS_LOTEADO_MODE = "N";

type ClaudioKussLot = {
  seq?: string;
  lote?: string;
  bem?: string;
  comb?: string;
  ano?: string;
  usuario?: string;
  valor?: string;
  foto?: string;
  linkVideo?: string;
};

type ClaudioKussMeta = {
  qtde?: number | string;
  qtdePag?: number | string;
};

type ClaudioKussAuctionRef = {
  leilaoId: number;
  auctionDate: Date | null;
  auctionDateRaw: string | null;
};

const BRAND_ALIASES: Record<string, string> = {
  VW: "VOLKSWAGEN",
  VOLKS: "VOLKSWAGEN",
  CHEV: "CHEVROLET",
  GM: "CHEVROLET",
  MERCEDES: "MERCEDES-BENZ",
  "M BENZ": "MERCEDES-BENZ"
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeBrand(raw: string): string {
  const normalized = normalizeText(raw).replace(/[./]/g, " ").replace(/\s+/g, " ").trim();
  return BRAND_ALIASES[normalized] ?? normalized;
}

function parseLeilaoIdsFromEnv(): number[] {
  const raw = (process.env.CLAUDIO_KUSS_LEILAO_IDS ?? "").trim();
  if (!raw) {
    return [];
  }

  return Array.from(
    new Set(
      raw
        .split(",")
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  );
}

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  if (!value || !value.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

function parseDatePtBr(raw: string): Date | null {
  const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const year = Number.parseInt(match[3], 10);
  if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year)) return null;

  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return null;
  }
  return parsed;
}

function extractAuctionRefsFromHtml(html: string): ClaudioKussAuctionRef[] {
  const seen = new Map<number, ClaudioKussAuctionRef>();
  const linkRegex = /relacao-(?:foto|lista)\/(\d{2,6})/gi;

  for (const match of html.matchAll(linkRegex)) {
    const idRaw = match[1];
    const leilaoId = Number.parseInt(idRaw, 10);
    if (!Number.isFinite(leilaoId) || leilaoId <= 0) {
      continue;
    }

    const matchIndex = match.index ?? 0;
    const contextStart = Math.max(0, matchIndex - 550);
    const contextEnd = Math.min(html.length, matchIndex + 180);
    const context = html.slice(contextStart, contextEnd);
    const dateMatch = [...context.matchAll(/\b(\d{2}\/\d{2}\/\d{4})\b/g)].at(-1)?.[1] ?? null;
    const parsedDate = dateMatch ? parseDatePtBr(dateMatch) : null;

    const current = seen.get(leilaoId);
    if (!current) {
      seen.set(leilaoId, {
        leilaoId,
        auctionDate: parsedDate,
        auctionDateRaw: dateMatch
      });
      continue;
    }

    if (!current.auctionDate && parsedDate) {
      current.auctionDate = parsedDate;
      current.auctionDateRaw = dateMatch;
    }
  }

  return [...seen.values()].sort((a, b) => {
    const aTs = a.auctionDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const bTs = b.auctionDate?.getTime() ?? Number.MAX_SAFE_INTEGER;
    if (aTs !== bTs) return aTs - bTs;
    return a.leilaoId - b.leilaoId;
  });
}

async function fetchAuctionRefsFromPage(
  url: string,
  log: (message: string) => void
): Promise<ClaudioKussAuctionRef[]> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    });

    if (!response.ok) {
      log(`[claudio-kuss] Falha ao carregar ${url} (HTTP ${response.status}).`);
      return [];
    }

    const html = await response.text();
    return extractAuctionRefsFromHtml(html);
  } catch (error) {
    log(
      `[claudio-kuss] Erro ao carregar ${url}: ${error instanceof Error ? error.message : String(error)}`
    );
    return [];
  }
}

async function discoverAuctions(log: (message: string) => void): Promise<ClaudioKussAuctionRef[]> {
  const primary = await fetchAuctionRefsFromPage(DISCOVERY_URL, log);
  if (primary.length > 0) return primary;

  log("[claudio-kuss] Nenhum leilão em /proximos-leiloes, tentando página inicial.");
  return fetchAuctionRefsFromPage(FALLBACK_DISCOVERY_URL, log);
}

async function fetchAuctionDateFromRelationPage(
  leilaoId: number,
  log: (message: string) => void
): Promise<Date | null> {
  try {
    const response = await fetch(`${BASE_URL}/relacao-foto/${leilaoId}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    });

    if (!response.ok) {
      log(`[claudio-kuss] leilão ${leilaoId}: falha ao buscar data (HTTP ${response.status}).`);
      return null;
    }

    const html = await response.text();
    const scopedDate =
      html.match(/data_lateral_fixo_leilao[\s\S]{0,1500}?(\d{2}\/\d{2}\/\d{4})/i)?.[1] ?? null;
    if (scopedDate) {
      return parseDatePtBr(scopedDate);
    }

    const firstDate = html.match(/\b(\d{2}\/\d{2}\/\d{4})\b/)?.[1] ?? null;
    return firstDate ? parseDatePtBr(firstDate) : null;
  } catch (error) {
    log(
      `[claudio-kuss] leilão ${leilaoId}: erro ao buscar data (${error instanceof Error ? error.message : String(error)}).`
    );
    return null;
  }
}

async function fetchLeilaoMeta(leilaoId: number, log: (message: string) => void): Promise<ClaudioKussMeta | null> {
  try {
    const body = new URLSearchParams({
      op: "Q",
      leilaoID: String(leilaoId),
      pesq: ""
    });

    const response = await fetch(JSON_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE_URL}/relacao-foto/${leilaoId}`,
        Origin: BASE_URL
      },
      body: body.toString()
    });

    if (!response.ok) {
      log(`[claudio-kuss] leilão ${leilaoId}: meta HTTP ${response.status}.`);
      return null;
    }

    return (await response.json()) as ClaudioKussMeta;
  } catch (error) {
    log(
      `[claudio-kuss] leilão ${leilaoId}: erro ao carregar meta (${error instanceof Error ? error.message : String(error)}).`
    );
    return null;
  }
}

async function fetchLeilaoPage(
  leilaoId: number,
  page: number,
  log: (message: string) => void,
  search = ""
): Promise<ClaudioKussLot[]> {
  try {
    const body = new URLSearchParams({
      leilaoID: String(leilaoId),
      op: "P",
      pag: String(page),
      loteado: CLAUDIO_KUSS_LOTEADO_MODE,
      pesq: search
    });

    const response = await fetch(JSON_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${BASE_URL}/relacao-foto/${leilaoId}`,
        Origin: BASE_URL
      },
      body: body.toString()
    });

    if (!response.ok) {
      log(`[claudio-kuss] leilão ${leilaoId} página ${page}: HTTP ${response.status}.`);
      return [];
    }

    const data = (await response.json()) as unknown;
    if (!Array.isArray(data)) {
      return [];
    }

    return data as ClaudioKussLot[];
  } catch (error) {
    log(
      `[claudio-kuss] leilão ${leilaoId} página ${page}: erro (${error instanceof Error ? error.message : String(error)}).`
    );
    return [];
  }
}

export function parseClaudioKussLotUrl(rawUrl: string): {
  leilaoId: number;
  seq: string | null;
  lotNumber: string | null;
  canonicalUrl: string;
} | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const match = path.match(/^\/lance\/(\d{2,6})(?:\/(\d+))?(?:\/(\d+))?$/i);
  if (!match) return null;

  const leilaoId = Number.parseInt(match[1], 10);
  if (!Number.isFinite(leilaoId) || leilaoId <= 0) return null;

  const second = match[2] ?? null;
  const third = match[3] ?? null;
  const seq = third && third !== "0" ? third : null;
  const lotNumber = second && second !== "0" && !third ? second : null;

  return {
    leilaoId,
    seq,
    lotNumber,
    canonicalUrl: seq
      ? `${BASE_URL}/lance/${leilaoId}/0/${seq}`
      : lotNumber
        ? `${BASE_URL}/lance/${leilaoId}/${lotNumber}`
        : `${BASE_URL}/lance/${leilaoId}`
  };
}

function parsePrice(value: string | undefined): { price: number | null; priceRaw: string | null } {
  const raw = (value ?? "").trim();
  if (!raw) {
    return { price: null, priceRaw: null };
  }

  const numericPart = raw.split(",")[0]?.replace(/\./g, "").replace(/[^\d]/g, "") ?? "";
  const asNumber = Number.parseInt(numericPart, 10);

  return {
    price: Number.isFinite(asNumber) ? asNumber : null,
    priceRaw: `R$ ${raw}`
  };
}

function parseYear(value: string | undefined): number | null {
  const raw = (value ?? "").trim();
  if (!raw) {
    return null;
  }

  const match = raw.match(/(\d{2,4})\s*\/\s*\d{2,4}/);
  if (!match) {
    return null;
  }

  const first = Number.parseInt(match[1], 10);
  if (!Number.isFinite(first)) {
    return null;
  }

  if (first >= 1900) {
    return first;
  }

  return 2000 + first;
}

function buildVehicleFromLot(
  lot: ClaudioKussLot,
  leilaoId: number,
  auctionDate: Date | null,
  page: number,
  indexInPage: number
): AuctionVehicle | null {
  const bem = (lot.bem ?? "").trim();
  if (!bem) {
    return null;
  }

  const [brandRawPart, ...modelParts] = bem.split("/");
  const brandRaw = (brandRawPart ?? "").trim();
  const modelRaw = modelParts.join("/").trim() || bem;

  const matchedBrand = normalizeBrand(brandRaw) || null;

  const year = parseYear(lot.ano);

  const { price, priceRaw } = parsePrice(lot.valor);
  const matchedModel = modelRaw;

  const seqRaw = (lot.seq ?? "").trim();
  const lotNumberRaw = (lot.lote ?? "").trim();
  const seq = seqRaw && seqRaw !== "0" ? seqRaw : "";
  const lotNumber = lotNumberRaw && lotNumberRaw !== "0" ? lotNumberRaw : "";
  const fallbackId = `p${page}-i${indexInPage + 1}`;
  const lotId = lotNumber || seq || fallbackId;
  const lotUrl = seq
    ? `${BASE_URL}/lance/${leilaoId}/0/${seq}`
    : lotNumber
      ? `${BASE_URL}/lance/${leilaoId}/${lotNumber}`
      : `${BASE_URL}/relacao-foto/${leilaoId}#${fallbackId}`;
  const image = (lot.foto ?? "").trim();

  const descriptionParts = [
    lot.comb ? `Comb.: ${lot.comb.trim()}` : null,
    lot.usuario ? `Último lance: ${lot.usuario.trim()}` : null
  ].filter(Boolean);

  return {
    source: "claudio-kuss",
    brand: (matchedBrand ?? "UNKNOWN").trim() || "UNKNOWN",
    model: matchedModel,
    year,
    damage: null,
    price,
    priceRaw,
    imageUrls: image ? [image] : [],
    description: descriptionParts.join(" | "),
    url: lotUrl,
    auctionDate,
    lot: lotNumber || lotId,
    yard: CLAUDIO_KUSS_DEFAULT_YARD
  };
}

function findClaudioKussLotByParsedUrl(
  lots: ClaudioKussLot[],
  parsed: NonNullable<ReturnType<typeof parseClaudioKussLotUrl>>
): { lot: ClaudioKussLot; index: number } | null {
  for (let index = 0; index < lots.length; index += 1) {
    const lot = lots[index];
    const seq = String(lot.seq ?? "").trim();
    const lotNumber = String(lot.lote ?? "").trim();
    if (parsed.seq && seq === parsed.seq) {
      return { lot, index };
    }
    if (parsed.lotNumber && lotNumber === parsed.lotNumber) {
      return { lot, index };
    }
  }

  return null;
}

export async function fetchClaudioKussVehicleByUrl(
  url: string,
  options?: { log?: (message: string) => void }
): Promise<AuctionVehicle | null> {
  const log = options?.log ?? console.log;
  const parsed = parseClaudioKussLotUrl(url);
  if (!parsed) return null;

  const searchTerm = parsed.seq ?? parsed.lotNumber ?? "";
  if (!searchTerm) return null;

  log(`[claudio-kuss] Buscando lote por URL: leilao=${parsed.leilaoId} termo=${searchTerm}`);

  const auctionDate = await fetchAuctionDateFromRelationPage(parsed.leilaoId, log);
  const lots = await fetchLeilaoPage(parsed.leilaoId, 1, log, searchTerm);
  const found = findClaudioKussLotByParsedUrl(lots, parsed);
  if (!found) return null;

  return buildVehicleFromLot(found.lot, parsed.leilaoId, auctionDate, 1, found.index);
}

export async function scrapeClaudioKuss(
  filters: AuctionFilters,
  options?: { headless?: boolean; log?: (message: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const maxPagesPerAuction = parsePositiveIntEnv(
    process.env.CLAUDIO_KUSS_MAX_PAGES,
    DEFAULT_MAX_PAGES_PER_AUCTION
  );
  const maxAuctions = parsePositiveIntEnv(
    process.env.CLAUDIO_KUSS_MAX_AUCTIONS,
    DEFAULT_MAX_AUCTIONS
  );

  const envIds = parseLeilaoIdsFromEnv();
  let auctionRefs: ClaudioKussAuctionRef[] = [];

  if (envIds.length > 0) {
    auctionRefs = envIds.map((leilaoId) => ({
      leilaoId,
      auctionDate: null,
      auctionDateRaw: null
    }));
  } else {
    auctionRefs = await discoverAuctions(log);
  }

  const selectedAuctions = auctionRefs.slice(0, maxAuctions);

  if (selectedAuctions.length === 0) {
    log("[claudio-kuss] Nenhum leilão encontrado para scraping.");
    return [];
  }

  for (const auction of selectedAuctions) {
    if (!auction.auctionDate) {
      auction.auctionDate = await fetchAuctionDateFromRelationPage(auction.leilaoId, log);
      auction.auctionDateRaw = auction.auctionDate
        ? `${String(auction.auctionDate.getDate()).padStart(2, "0")}/${String(
            auction.auctionDate.getMonth() + 1
          ).padStart(2, "0")}/${auction.auctionDate.getFullYear()}`
        : null;
    }
  }

  log(
    `[claudio-kuss] Leilões alvo: ${selectedAuctions
      .map((item) => `${item.leilaoId}${item.auctionDateRaw ? ` (${item.auctionDateRaw})` : ""}`)
      .join(", ")}.`
  );

  const results: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  for (const auction of selectedAuctions) {
    const leilaoId = auction.leilaoId;
    const meta = await fetchLeilaoMeta(leilaoId, log);
    const metaPages = Number.parseInt(String(meta?.qtdePag ?? ""), 10);
    const totalPages = Number.isFinite(metaPages) && metaPages > 0 ? metaPages : maxPagesPerAuction;
    const pageLimit = Math.min(totalPages, maxPagesPerAuction);

    log(`[claudio-kuss] leilão ${leilaoId}: varrendo ${pageLimit} página(s).`);

    for (let page = 1; page <= pageLimit; page += 1) {
      const lots = await fetchLeilaoPage(leilaoId, page, log);
      if (lots.length === 0) {
        if (page === 1) {
          log(`[claudio-kuss] leilão ${leilaoId}: sem lotes retornados.`);
        }
        break;
      }

      for (let lotIndex = 0; lotIndex < lots.length; lotIndex += 1) {
        const lot = lots[lotIndex];
        const vehicle = buildVehicleFromLot(lot, leilaoId, auction.auctionDate, page, lotIndex);
        if (!vehicle) {
          continue;
        }
        if (seenUrls.has(vehicle.url)) {
          continue;
        }

        seenUrls.add(vehicle.url);
        results.push(vehicle);
      }

      await sleep(PAGE_DELAY_MS);
    }
  }

  log(`[claudio-kuss] Total: ${results.length} veículo(s) após filtros.`);
  return results;
}
