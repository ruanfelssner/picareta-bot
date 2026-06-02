import { load } from "cheerio";
const BASE_URL = "https://www.leiloesjudiciais.com.br";
const LIST_URL = `${BASE_URL}/veiculos/carros`;
const REQUEST_DELAY_MS = 300;
const DEFAULT_MAX_PAGES = 6;
const HARD_MAX_PAGES = 40;
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};
const BRAND_ALIASES = {
    VW: "VOLKSWAGEN",
    VOLKS: "VOLKSWAGEN",
    CHEV: "CHEVROLET",
    GM: "CHEVROLET",
    "M BENZ": "MERCEDES-BENZ",
    "MERCEDES BENZ": "MERCEDES-BENZ"
};
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseMaxPagesFromEnv() {
    const raw = Number.parseInt((process.env.LEILOESJUDICIAIS_MAX_PAGES ?? "").trim(), 10);
    if (!Number.isFinite(raw) || raw < 1) {
        return DEFAULT_MAX_PAGES;
    }
    return Math.max(1, Math.min(HARD_MAX_PAGES, raw));
}
function toAbsoluteUrl(value) {
    const text = (value ?? "").trim();
    if (!text)
        return "";
    if (text.startsWith("http://") || text.startsWith("https://"))
        return text;
    if (text.startsWith("//"))
        return `https:${text}`;
    if (text.startsWith("/"))
        return `${BASE_URL}${text}`;
    return `${BASE_URL}/${text}`;
}
function normalizeBrandToken(raw) {
    const cleaned = raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return BRAND_ALIASES[cleaned] ?? cleaned;
}
function parseBrandModelFromTitle(titleRaw) {
    const normalized = titleRaw
        .replace(/\s+/g, " ")
        .replace(/^I\//i, "")
        .replace(/^IMP\//i, "")
        .trim();
    const mainChunk = normalized.split(/\s+-\s+/)[0]?.trim() ?? normalized;
    const cleanedMain = mainChunk
        .replace(/\bM\.?\s*BENZ\b/gi, "MERCEDES-BENZ")
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleanedMain) {
        return { brand: "UNKNOWN", model: "SEM MODELO" };
    }
    if (cleanedMain.includes("/")) {
        const [rawBrand, rawModel] = cleanedMain.split("/", 2);
        const brand = normalizeBrandToken(rawBrand);
        const model = (rawModel?.trim() || cleanedMain).toUpperCase();
        return {
            brand: brand || "UNKNOWN",
            model
        };
    }
    const tokens = cleanedMain.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) {
        return { brand: "UNKNOWN", model: cleanedMain.toUpperCase() || "SEM MODELO" };
    }
    const first = normalizeBrandToken(tokens[0]);
    const second = normalizeBrandToken(tokens[1] ?? "");
    const dual = normalizeBrandToken(`${tokens[0]} ${tokens[1] ?? ""}`);
    if (BRAND_ALIASES[dual] || (first === "MERCEDES" && second === "BENZ")) {
        const brand = BRAND_ALIASES[dual] ?? "MERCEDES-BENZ";
        const model = (tokens.slice(2).join(" ") || cleanedMain).toUpperCase();
        return { brand, model };
    }
    return {
        brand: first || "UNKNOWN",
        model: (tokens.slice(1).join(" ") || cleanedMain).toUpperCase()
    };
}
function parseMoney(raw) {
    const value = raw.replace(/\s+/g, " ").trim();
    const match = value.match(/R\$\s*([\d.]+(?:,\d{1,2})?)/i);
    if (!match)
        return { value: null, text: null };
    const numeric = match[1];
    const parsed = Number.parseFloat(numeric.replace(/\./g, "").replace(",", "."));
    return {
        value: Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null,
        text: `R$ ${numeric}`
    };
}
function parseYear(raw) {
    const modelYearMatch = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:\d{2,4})\b/);
    if (modelYearMatch) {
        return Number.parseInt(modelYearMatch[1], 10);
    }
    const years = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)];
    if (years.length === 0)
        return null;
    const parsed = Number.parseInt(years[0]?.[1] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
}
function parseDatePtBr(raw) {
    const text = (raw ?? "").trim();
    if (!text)
        return null;
    const match = text.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (!match)
        return null;
    const day = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const year = Number.parseInt(match[3], 10);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(year))
        return null;
    const parsed = new Date(year, month - 1, day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}
function normalizeLabel(raw) {
    return raw
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .trim();
}
function parseTotalPages(html) {
    const pageNumbers = [...html.matchAll(/\/veiculos\/carros\?pagina=(\d+)/gi)]
        .map((match) => Number.parseInt(match[1], 10))
        .filter((value) => Number.isFinite(value) && value > 0);
    if (pageNumbers.length > 0) {
        return Math.max(...pageNumbers);
    }
    const pagerMatch = html.match(/>(\d+)\s*de\s*(\d+)</i);
    if (pagerMatch) {
        const total = Number.parseInt(pagerMatch[2], 10);
        if (Number.isFinite(total) && total > 0) {
            return total;
        }
    }
    return 1;
}
function parseCards(html, log) {
    const $ = load(html);
    const out = [];
    const seen = new Set();
    $("a.card-lote-leilao").each((_i, el) => {
        const anchor = $(el);
        const wrapper = anchor.closest(".base-card");
        if (!wrapper || wrapper.length === 0)
            return;
        const href = anchor.attr("href") ?? "";
        const url = toAbsoluteUrl(href);
        if (!url || seen.has(url))
            return;
        seen.add(url);
        const title = wrapper.find(".card-header span").first().text().replace(/\s+/g, " ").trim();
        if (!title)
            return;
        const lot = wrapper
            .find(".numero-lote")
            .first()
            .text()
            .replace(/\s+/g, " ")
            .replace(/^#/, "")
            .trim() || undefined;
        const status = wrapper.find(".status").first().text().replace(/\s+/g, " ").trim() || null;
        const yard = wrapper.find(".cidade-estado span").first().text().replace(/\s+/g, " ").trim() || null;
        const imageRaw = wrapper.find("img.imagem__lote").first().attr("src") ?? "";
        const imageUrl = toAbsoluteUrl(imageRaw);
        let appraisalValue = null;
        let appraisalText = null;
        let minBidValue = null;
        let minBidText = null;
        let initialBidValue = null;
        let initialBidText = null;
        let currentBidValue = null;
        let currentBidText = null;
        wrapper.find(".label-valor").each((_rowIndex, rowNode) => {
            const row = $(rowNode);
            const spans = row.find("span");
            if (spans.length < 2)
                return;
            const label = normalizeLabel(spans.eq(0).text());
            const valueRaw = spans.eq(1).text();
            const parsed = parseMoney(valueRaw);
            if (!parsed.text)
                return;
            if (label.includes("lance atual")) {
                currentBidValue = parsed.value;
                currentBidText = parsed.text;
            }
            else if (label.includes("lance minimo")) {
                minBidValue = parsed.value;
                minBidText = parsed.text;
            }
            else if (label.includes("lance inicial") ||
                label.includes("primeiro leilao") ||
                label.includes("segundo leilao")) {
                initialBidValue = parsed.value;
                initialBidText = parsed.text;
            }
            else if (label.includes("avaliacao")) {
                appraisalValue = parsed.value;
                appraisalText = parsed.text;
            }
        });
        const finalPriceValue = currentBidValue != null && currentBidValue > 0
            ? currentBidValue
            : minBidValue != null && minBidValue > 0
                ? minBidValue
                : initialBidValue != null && initialBidValue > 0
                    ? initialBidValue
                    : null;
        const finalPriceText = currentBidValue != null && currentBidValue > 0
            ? currentBidText
            : minBidText ?? initialBidText ?? null;
        const finalPriceLabel = currentBidValue != null && currentBidValue > 0
            ? "Lance atual"
            : minBidValue != null && minBidValue > 0
                ? "Lance mínimo"
                : initialBidValue != null && initialBidValue > 0
                    ? "Lance inicial"
                    : "Atual";
        const { brand, model } = parseBrandModelFromTitle(title);
        const dateCandidate = wrapper.text().match(/\b\d{2}\/\d{2}\/\d{4}\b/)?.[0] ?? null;
        const damage = title.match(/\b(sucata|batid[oa]|sinistrad[oa])\b/i)?.[0] ?? null;
        const description = [title, status, yard, appraisalText ? `Avaliação: ${appraisalText}` : null]
            .filter(Boolean)
            .join(" · ")
            .slice(0, 260);
        out.push({
            source: "leiloesjudiciais",
            brand: brand || "UNKNOWN",
            model: model || "SEM MODELO",
            year: parseYear(title),
            damage,
            price: finalPriceValue,
            priceRaw: finalPriceText,
            priceLabel: finalPriceLabel,
            imageUrls: imageUrl ? [imageUrl] : [],
            description,
            url,
            auctionDate: parseDatePtBr(dateCandidate),
            lot,
            yard,
            appraisal: appraisalValue,
            appraisalRaw: appraisalText,
            // Em Leilões Judiciais, "Avaliação" não representa FIPE.
            fipe: null,
            fipeRaw: null
        });
    });
    log(`[leiloesjudiciais] ${out.length} lote(s) extraído(s) nesta página.`);
    return out;
}
async function fetchHtml(url, log) {
    try {
        const response = await fetch(url, { headers: HEADERS });
        if (!response.ok) {
            log(`[leiloesjudiciais] HTTP ${response.status} em ${url}`);
            return null;
        }
        return await response.text();
    }
    catch (error) {
        log(`[leiloesjudiciais] Erro em ${url}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
function buildPageUrl(page) {
    if (page <= 1)
        return LIST_URL;
    const url = new URL(LIST_URL);
    url.searchParams.set("pagina", String(page));
    return url.toString();
}
export async function scrapeLeiloesJudiciais(_filters, options) {
    const log = options?.log ?? console.log;
    const maxPages = parseMaxPagesFromEnv();
    const all = [];
    const seenUrls = new Set();
    log("[leiloesjudiciais] Iniciando...");
    const firstHtml = await fetchHtml(buildPageUrl(1), log);
    if (!firstHtml) {
        log("[leiloesjudiciais] Falha ao carregar página inicial.");
        return [];
    }
    const discoveredPages = parseTotalPages(firstHtml);
    const totalPages = Math.max(1, Math.min(discoveredPages, maxPages));
    log(`[leiloesjudiciais] Página(s): total=${discoveredPages} | limite=${maxPages} | varrendo=${totalPages}.`);
    const firstPageCards = parseCards(firstHtml, log);
    for (const vehicle of firstPageCards) {
        if (seenUrls.has(vehicle.url))
            continue;
        seenUrls.add(vehicle.url);
        all.push(vehicle);
    }
    for (let page = 2; page <= totalPages; page += 1) {
        const pageUrl = buildPageUrl(page);
        log(`[leiloesjudiciais] Página ${page}/${totalPages}: ${pageUrl}`);
        const html = await fetchHtml(pageUrl, log);
        if (!html)
            continue;
        const pageCards = parseCards(html, log);
        for (const vehicle of pageCards) {
            if (seenUrls.has(vehicle.url))
                continue;
            seenUrls.add(vehicle.url);
            all.push(vehicle);
        }
        await sleep(REQUEST_DELAY_MS);
    }
    log(`[leiloesjudiciais] Total: ${all.length} veículo(s).`);
    return all;
}
