import { chromium } from "playwright";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";
const SEARCH_URL = "https://www.sodresantoro.com.br/veiculos/lotes?lot_category=carros";
const API_URL = "https://www.sodresantoro.com.br/api/search-lots";
const LOT_BASE = "https://leilao.sodresantoro.com.br/leilao";
function buildPayload(options) {
    const filterClauses = [];
    if (options.includeLocationCategoryFilter) {
        filterClauses.push({ terms: { lot_category: ["carros"] } });
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
        from: 0,
        size: 200,
        sort: [
            { lot_status_id_order: { order: "asc" } },
            { auction_date_init: { order: "asc" } }
        ]
    };
}
function parsePrice(bidActual) {
    const n = parseFloat(bidActual);
    return isNaN(n) || n <= 0 ? null : Math.round(n);
}
function parseDate(dateStr) {
    const m = dateStr?.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m)
        return null;
    return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}
function capitalize(s) {
    if (!s)
        return s;
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
function normalizeSpace(raw) {
    return (raw ?? "").replace(/\s+/g, " ").trim();
}
function extractYardFromDescription(raw) {
    const text = normalizeSpace(raw);
    if (!text)
        return null;
    const match = text.match(/(?:Local(?:iza(?:ção|cao)\s+do\s+lote| do lote)?|P[aá]tio)\s*:\s*([A-Za-zÀ-ÿ0-9 .,/()-]+?)(?=\s+(?:Lance|Leil[aã]o|Situa[cç][aã]o|Status)\b|$)/i);
    return match?.[1]?.trim() || null;
}
function extractSodreYard(item) {
    const dynamic = item;
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
        if (typeof value !== "string")
            continue;
        const cleaned = normalizeSpace(value);
        if (cleaned)
            return cleaned;
    }
    const city = normalizeSpace(typeof dynamic.lot_city === "string" ? dynamic.lot_city : "");
    const state = normalizeSpace(typeof dynamic.lot_state === "string" ? dynamic.lot_state : "");
    if (city && state && !city.toUpperCase().includes(state.toUpperCase())) {
        return `${city} - ${state}`;
    }
    return extractYardFromDescription(item.lot_description);
}
export async function scrapeSodre(filters, options) {
    const log = options?.log ?? console.log;
    log("[sodre] Iniciando (fetch via browser)...");
    const headless = options?.headless ?? true;
    const browser = await chromium.launch(buildPlaywrightLaunchOptions(headless));
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        locale: "pt-BR"
    });
    const page = await context.newPage();
    let items = [];
    try {
        // Carrega a página para obter cookies de sessão (WAF bypass)
        await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
        log("[sodre] Sessão estabelecida. Chamando API...");
        // Executa o fetch de dentro do browser (usa cookies da sessão automaticamente)
        const fetchSearch = async (payload) => page.evaluate(async ({ url, body }) => {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body)
            });
            if (!res.ok)
                return { error: res.status, results: [] };
            return res.json();
        }, { url: API_URL, body: payload });
        let result = await fetchSearch(buildPayload({ includeLocationCategoryFilter: true }));
        if (result.error) {
            log(`[sodre] API retornou erro: HTTP ${result.error}`);
            return [];
        }
        items = result.results ?? [];
        log(`[sodre] ${items.length} lote(s) recebidos (categoria carros).`);
        if (items.length === 0) {
            log("[sodre] Sem lotes no filtro de localização/categoria. Tentando fallback sem filtro fixo...");
            result = await fetchSearch(buildPayload({ includeLocationCategoryFilter: false }));
            if (result.error) {
                log(`[sodre] Fallback API erro: HTTP ${result.error}`);
                return [];
            }
            items = result.results ?? [];
            log(`[sodre] ${items.length} lote(s) recebidos no fallback sem filtro fixo.`);
        }
    }
    catch (err) {
        log(`[sodre] Erro: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
    finally {
        await browser.close();
    }
    const results = [];
    const stats = {
        total: items.length,
        accepted: 0
    };
    const brandSample = new Set();
    for (const item of items) {
        const brandRaw = (item.lot_brand ?? "").trim();
        if (brandRaw) {
            if (brandSample.size < 10) {
                brandSample.add(brandRaw);
            }
        }
        const matchedBrand = brandRaw || null;
        const year = item.lot_year_model ?? item.lot_year_manufacture ?? null;
        const price = parsePrice(item.bid_actual);
        const modelRaw = (item.lot_model ?? "").trim();
        const matchedModel = modelRaw;
        const damage = item.lot_sinister?.trim() || null;
        const priceRaw = price !== null ? `R$ ${price.toLocaleString("pt-BR")}` : null;
        const kmNum = typeof item.lot_km === "number" ? item.lot_km : parseInt(String(item.lot_km ?? 0), 10);
        const kmFormatted = kmNum > 0 ? kmNum.toLocaleString("pt-BR") : null;
        log(`[sodre] ${matchedBrand ?? "UNKNOWN"} ${modelRaw} — km=${kmNum} cor=${item.lot_color ?? "?"} preço=${price}`);
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
        results.push({
            source: "sodre",
            brand: (matchedBrand ?? "UNKNOWN").trim() || "UNKNOWN",
            model: matchedModel,
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
            yard
        });
        stats.accepted += 1;
    }
    log(`[sodre] Filtro resumo: total=${stats.total} | aceitos=${stats.accepted}`);
    if (stats.accepted === 0 && brandSample.size > 0) {
        log(`[sodre] Marcas recebidas (amostra): ${[...brandSample].join(", ")}`);
    }
    log(`[sodre] ${results.length} veículo(s) após filtros.`);
    return results;
}
