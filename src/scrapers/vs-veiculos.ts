import { load } from "cheerio";
import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { AuctionFilters } from "../integrations/mongo.js";

const BASE = "https://www.vsveiculos.com";
const VS_DEFAULT_YARD = "Curitiba - PR";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "pt-BR,pt;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

// /carros/{damage}/{city}/{brand}/{model}/{specs-year}/id-{id}
// ex: /carros/media-monta/pinhais/volkswagen/voyage/1.0-totalflex-2023/id-364722
function parseCardUrl(href: string): {
  brand: string;
  model: string;
  damage: string;
} {
  const parts = href.replace(/^\/carros\//, "").split("/");
  const damage = (parts[0] ?? "").replace(/-/g, " ");
  const brand = (parts[2] ?? "").replace(/-/g, " ");
  const model = (parts[3] ?? "").replace(/-/g, " ");
  return { brand, model, damage };
}

function buildCanonicalVehicleUrl(href: string): string | null {
  const match = href.match(/\/id-(\d+)(?:[/?#]|$)/);
  if (!match) return null;
  return `${BASE}/carros/id-${match[1]}`;
}

function buildPageUrl(page = 1): string {
  const parts = ["tipoveiculo.carros"];

  if (page > 1) {
    parts.push(`pagina.${page}`);
  }

  return `${BASE}/search/${parts.join("/")}`;
}

function parsePriceFromText(text: string): { price: number | null; priceRaw: string | null } {
  // ex: "R$38.500" or "R$ 38.500" or "R$ 38.500,00"
  const match = text.match(/R\$\s*([\d.]+(?:,\d+)?)/);
  if (!match) return { price: null, priceRaw: null };
  const priceRaw = `R$ ${match[1]}`;
  const price = parseInt(match[1].replace(/\./g, "").replace(",", ""), 10);
  return { price: isNaN(price) ? null : price, priceRaw };
}

function parseYearFromText(text: string): number | null {
  // ex: "2023/2023" or "2022/2023" ou "MANUAL2023/2023" (sem espaço)
  const match = text.match(/(20\d{2})\/(20\d{2})/);
  if (match) return parseInt(match[1], 10);
  // fallback: qualquer ano isolado
  const m2 = text.match(/\b(20\d{2})\b/);
  return m2 ? parseInt(m2[1], 10) : null;
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

function parseTotalPages(html: string): number {
  // "Exibindo 1 - 20 de 87" → ceil(87/20) pages
  const match = html.match(/Exibindo\s+\d+\s*-\s*(\d+)\s+de\s+(\d+)/i);
  if (!match) return 1;
  const perPage = parseInt(match[1], 10);
  const total = parseInt(match[2], 10);
  return Math.ceil(total / perPage);
}

function parseCards(html: string, log: (m: string) => void): AuctionVehicle[] {
  const $ = load(html);
  const results: AuctionVehicle[] = [];
  const seen = new Set<string>();

  // Cards são <a> com href /carros/.../id-N
  $('a[href*="/carros/"][href*="/id-"]').each((_i, el) => {
    const card = $(el);
    const href = card.attr("href") ?? "";
    if (!href || seen.has(href)) return;
    seen.add(href);

    const cardUrl = buildCanonicalVehicleUrl(href);
    if (!cardUrl) return;
    const rawText = card.text().replace(/\s+/g, " ").trim();

    if (!rawText) return;

    // Extrai dados do href (mais confiável que o texto para marca/modelo)
    const { brand, model, damage } = parseCardUrl(href);

    // Preço e ano
    const { price, priceRaw } = parsePriceFromText(rawText);
    const year = parseYearFromText(rawText);

    // Imagem: procura <img> dentro do card
    const imgSrc = card.find("img").first().attr("src") ?? "";
    // Às vezes a imagem usa data-src (lazy loading)
    const imgLazy = card.find("img").first().attr("data-src") ?? "";
    const imageUrl = (imgSrc.startsWith("http") ? imgSrc : imgLazy.startsWith("http") ? imgLazy : "").replace(/^\/\//, "https://");

    // Monta descrição limpa — remove "Mais detalhes" e excesso
    const description = rawText.replace(/mais detalhes/gi, "").replace(/\s{2,}/g, " ").trim().slice(0, 250);

    results.push({
      source: "vs-veiculos",
      brand: brand.toUpperCase() || "UNKNOWN",
      model: model.toUpperCase() || rawText.slice(0, 40),
      year,
      damage: damage || null,
      price,
      priceRaw,
      imageUrls: imageUrl ? [imageUrl] : [],
      description,
      url: cardUrl,
      auctionDate: null,
      yard: VS_DEFAULT_YARD
    });
  });

  log(`[vs] ${results.length} card(s) válido(s) nesta página.`);
  return results;
}

export async function scrapeVsVeiculos(
  filters: AuctionFilters,
  options?: { headless?: boolean; log?: (msg: string) => void }
): Promise<AuctionVehicle[]> {
  const log = options?.log ?? console.log;
  const allResults: AuctionVehicle[] = [];
  const seenUrls = new Set<string>();

  // Primeira página
  const firstUrl = buildPageUrl(1);
  log(`[vs] Buscando: ${firstUrl}`);

  const firstHtml = await fetchPage(firstUrl, log);
  if (!firstHtml) {
    log("[vs] Falha ao carregar página 1.");
    return [];
  }

  const totalPages = Math.min(parseTotalPages(firstHtml), 5); // limita 5 páginas
  log(`[vs] ${totalPages} página(s) encontrada(s).`);

  const page1Results = parseCards(firstHtml, log);
  for (const v of page1Results) {
    if (!seenUrls.has(v.url)) {
      seenUrls.add(v.url);
      allResults.push(v);
    }
  }

  // Páginas adicionais
  for (let page = 2; page <= totalPages; page++) {
    const pageUrl = buildPageUrl(page);
    log(`[vs] Página ${page}/${totalPages}: ${pageUrl}`);

    const html = await fetchPage(pageUrl, log);
    if (!html) break;

    const pageResults = parseCards(html, log);
    for (const v of pageResults) {
      if (!seenUrls.has(v.url)) {
        seenUrls.add(v.url);
        allResults.push(v);
      }
    }

    // Pequena pausa para não sobrecarregar o servidor
    await new Promise((r) => setTimeout(r, 800));
  }

  log(`[vs] Total: ${allResults.length} veículo(s) após filtros.`);
  return allResults;
}
