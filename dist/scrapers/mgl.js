import { chromium } from "playwright";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";
const BASE_URL = "https://www.mgl.com.br";
const SEARCH_ENDPOINT_PATH = "/apiplugin/GetBusca";
const CATEGORY_FILTERS = [88, 108];
const PAGE_SIZE = 48;
const REQUEST_DELAY_MS = 350;
const DEFAULT_MAX_PAGES = 8;
const HARD_MAX_PAGES = 80;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DIRECT_HEADERS = {
    "User-Agent": USER_AGENT,
    Accept: "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
    "Content-Type": "application/json; charset=UTF-8",
    "X-Requested-With": "XMLHttpRequest",
    Referer: `${BASE_URL}/`,
    Origin: BASE_URL
};
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function parseMaxPagesFromEnv() {
    const raw = Number.parseInt((process.env.MGL_MAX_PAGES ?? "").trim(), 10);
    if (!Number.isFinite(raw) || raw < 1) {
        return DEFAULT_MAX_PAGES;
    }
    return Math.max(1, Math.min(HARD_MAX_PAGES, raw));
}
function parseManualChallengeWaitMs() {
    const raw = Number.parseInt((process.env.MGL_MANUAL_CHALLENGE_SECONDS ?? "").trim(), 10);
    if (!Number.isFinite(raw) || raw < 1) {
        return 45_000;
    }
    return Math.max(5_000, Math.min(10 * 60_000, raw * 1_000));
}
function parsePersistentProfileDir() {
    const raw = (process.env.MGL_USER_DATA_DIR ?? "").trim();
    return raw.length > 0 ? raw : null;
}
function normalizeSpace(raw) {
    return (raw ?? "").replace(/\s+/g, " ").trim();
}
function normalizeAlpha(raw) {
    return normalizeSpace(raw)
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase();
}
function looksLikeCloudflareChallenge(raw) {
    const marker = raw.toLowerCase();
    return (marker.includes("attention required") ||
        marker.includes("just a moment") ||
        marker.includes("performing security verification") ||
        marker.includes("enable javascript and cookies to continue") ||
        marker.includes("cdn-cgi/challenge-platform"));
}
function buildSearchUrl(pageNumber) {
    const query = CATEGORY_FILTERS.map((value) => `FiltroCategorias=${encodeURIComponent(String(value))}`).join("&");
    return `${BASE_URL}${SEARCH_ENDPOINT_PATH}/${pageNumber}/1/0?${query}`;
}
function buildRequestBody(pageNumber) {
    return {
        RangeValores: 0,
        Scopo: 0,
        IgnoreScopo: 0,
        OrientacaoBusca: 0,
        Mapa: "",
        Busca: "",
        ID_Categoria: 0,
        ID_Modelo: 48,
        ID_Estado: 0,
        ID_Cidade: 0,
        Bairro: "",
        ID_Regiao: 0,
        ValorMinSelecionado: 0,
        ValorMaxSelecionado: 0,
        CFGs: "",
        Pagina: pageNumber,
        sInL: "",
        Ordem: 5,
        QtdPorPagina: PAGE_SIZE,
        SubStatus: [],
        ID_Leiloes_Status: [],
        PaginaIndex: pageNumber,
        BuscaProcesso: "",
        NomesPartes: "",
        CodLeilao: "",
        TiposLeiloes: [],
        PracaAtual: 0,
        DataAbertura: "",
        DataEncerramento: "",
        CamposDinamicos: [
            { NomeFiltro: "QtdPorPagina", Valor: PAGE_SIZE },
            { NomeFiltro: "Ordem", Valor: 5 }
        ],
        Filtro: {}
    };
}
async function fetchPageDirect(pageNumber, log) {
    const url = buildSearchUrl(pageNumber);
    try {
        const response = await fetch(url, {
            method: "POST",
            headers: DIRECT_HEADERS,
            body: JSON.stringify(buildRequestBody(pageNumber))
        });
        const raw = await response.text();
        return {
            ok: response.ok,
            status: response.status,
            contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
            raw
        };
    }
    catch (error) {
        log(`[mgl] Erro HTTP direto página ${pageNumber}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}
function tryParseResponse(raw) {
    const normalized = raw.trim();
    // Alguns backends prefixam payload JSON com anti-JSON-hijacking.
    const maybePrefixed = normalized.startsWith(")]}',")
        ? normalized.slice(5).trim()
        : normalized;
    try {
        const parsed = JSON.parse(maybePrefixed);
        if (!parsed || typeof parsed !== "object")
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function parseTotalPages(payload) {
    const pages = Array.isArray(payload.Paginacao?.Paginas) ? payload.Paginacao?.Paginas ?? [] : [];
    const max = pages
        .map((item) => Number(item?.Pagina ?? 0))
        .filter((value) => Number.isFinite(value) && value > 0)
        .reduce((acc, value) => (value > acc ? value : acc), 1);
    if (max > 1)
        return max;
    const count = Array.isArray(payload.Lotes) ? payload.Lotes.length : 0;
    if (count >= PAGE_SIZE)
        return 2;
    return 1;
}
function parseMoney(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return null;
    return Math.round(numeric);
}
function formatMoneyRaw(value) {
    if (value == null)
        return null;
    return `R$ ${value.toLocaleString("pt-BR")}`;
}
function toAbsoluteLotUrl(value) {
    const raw = normalizeSpace(value);
    if (!raw)
        return "";
    if (raw.startsWith("http://") || raw.startsWith("https://"))
        return raw;
    const cleaned = raw.startsWith("/") ? raw.slice(1) : raw;
    return `${BASE_URL}/${cleaned}`;
}
function toImageUrl(fileName) {
    const raw = normalizeSpace(fileName);
    if (!raw)
        return "";
    if (raw.startsWith("http://") || raw.startsWith("https://"))
        return raw;
    return `${BASE_URL}/imagens-center/279x202/${raw}`;
}
function parseYear(raw) {
    const modelYearMatch = raw.match(/\b((?:19|20)\d{2})\s*\/\s*(?:19|20)?\d{2}\b/);
    if (modelYearMatch) {
        return Number.parseInt(modelYearMatch[1], 10);
    }
    const years = [...raw.matchAll(/\b((?:19|20)\d{2})\b/g)];
    if (years.length === 0)
        return null;
    const parsed = Number.parseInt(years[0]?.[1] ?? "", 10);
    return Number.isFinite(parsed) ? parsed : null;
}
const BRAND_ALIASES = {
    VW: "VOLKSWAGEN",
    VOLKS: "VOLKSWAGEN",
    CHEV: "CHEVROLET",
    GM: "CHEVROLET",
    "M BENZ": "MERCEDES-BENZ",
    "MERCEDES BENZ": "MERCEDES-BENZ"
};
function normalizeBrandToken(raw) {
    const cleaned = normalizeAlpha(raw)
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    return BRAND_ALIASES[cleaned] ?? cleaned;
}
function cleanupVehicleTitle(raw) {
    const normalized = normalizeSpace(raw);
    if (!normalized)
        return "";
    const parts = normalized.split(/\s+-\s+/).map((part) => normalizeSpace(part)).filter(Boolean);
    if (parts.length <= 1)
        return normalized;
    const head = parts[0] ?? "";
    const hasCityUfPrefix = /\/[A-Z]{2}$/i.test(head) || /\b[A-Z]{2}\/[A-Z]{2}\b/.test(head);
    const candidate = hasCityUfPrefix ? parts.slice(1).join(" - ") : normalized;
    return candidate
        .replace(/\s+-\s+[A-Z]{1,5}\d{2,8}\s*$/i, "")
        .replace(/\s+-\s+LOTE\s*\d+.*$/i, "")
        .replace(/\s{2,}/g, " ")
        .trim();
}
function parseBrandModelFromTitle(rawTitle) {
    const cleaned = cleanupVehicleTitle(rawTitle)
        .replace(/[.,]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    if (!cleaned) {
        return { brand: "UNKNOWN", model: "SEM MODELO" };
    }
    const tokens = cleaned.split(" ").filter(Boolean);
    if (tokens.length === 0) {
        return { brand: "UNKNOWN", model: cleaned.toUpperCase() || "SEM MODELO" };
    }
    const first = normalizeBrandToken(tokens[0]);
    const second = normalizeBrandToken(tokens[1] ?? "");
    const dual = normalizeBrandToken(`${tokens[0]} ${tokens[1] ?? ""}`);
    if (BRAND_ALIASES[dual] || (first === "MERCEDES" && second === "BENZ")) {
        const brand = BRAND_ALIASES[dual] ?? "MERCEDES-BENZ";
        const model = tokens.slice(2).join(" ").trim();
        return {
            brand,
            model: (model || cleaned).toUpperCase()
        };
    }
    const model = tokens.slice(1).join(" ").trim();
    return {
        brand: first || "UNKNOWN",
        model: (model || cleaned).toUpperCase()
    };
}
function parseDateTime(raw) {
    const text = normalizeSpace(raw);
    if (!text)
        return null;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime()))
        return null;
    if (parsed.getFullYear() <= 1901)
        return null;
    return parsed;
}
function pickAuctionDate(rt) {
    if (!rt)
        return null;
    return (parseDateTime(rt.DataHoraEncerramentoPrimeiraPraca ?? null) ??
        parseDateTime(rt.DataHoraAberturaPrimeiraPraca ?? null));
}
function pickImageUrls(lot) {
    const photos = Array.isArray(lot.Fotos) ? lot.Fotos : [];
    const urls = [];
    for (const photo of photos) {
        const url = toImageUrl(photo?.Foto ?? null);
        if (!url)
            continue;
        if (!urls.includes(url))
            urls.push(url);
    }
    return urls;
}
function pickPrice(lot, rt) {
    const currentBid = parseMoney(rt?.ValorLanceAtual ?? null);
    if (currentBid != null) {
        return {
            price: currentBid,
            priceRaw: formatMoneyRaw(currentBid),
            priceLabel: "Lance atual"
        };
    }
    const directSale = parseMoney(lot.ValorVendaDireta ?? null);
    if (directSale != null) {
        return {
            price: directSale,
            priceRaw: formatMoneyRaw(directSale),
            priceLabel: "Venda direta"
        };
    }
    const initialBid = parseMoney(rt?.ValorMinimoLancePrimeiraPraca ?? null) ??
        parseMoney(lot.ValorInicialPrimeiraPraca ?? null);
    if (initialBid != null) {
        return {
            price: initialBid,
            priceRaw: formatMoneyRaw(initialBid),
            priceLabel: "Lance inicial"
        };
    }
    return { price: null, priceRaw: null, priceLabel: null };
}
function normalizeYard(lot) {
    const cityUf = [normalizeSpace(lot.Cidade), normalizeSpace(lot.UF)].filter(Boolean).join("/");
    const addressParts = [
        normalizeSpace(lot.Lote_Endereco),
        normalizeSpace(lot.Lote_Numero),
        normalizeSpace(lot.Lote_Bairro)
    ].filter(Boolean);
    const address = addressParts.join(" ").replace(/\s+,/g, ",").replace(/,{2,}/g, ",").trim();
    const composed = [cityUf, address].filter(Boolean).join(" · ");
    return composed || null;
}
function parseLots(payload, log) {
    const lots = Array.isArray(payload.Lotes) ? payload.Lotes : [];
    const out = [];
    for (const lot of lots) {
        const url = toAbsoluteLotUrl(lot.URLlote ?? null);
        if (!url)
            continue;
        const titleRaw = normalizeSpace(lot.Lote);
        if (!titleRaw)
            continue;
        const rt = Array.isArray(lot.GetLoteRealTime) && lot.GetLoteRealTime.length > 0
            ? (lot.GetLoteRealTime[0] ?? null)
            : null;
        const { brand, model } = parseBrandModelFromTitle(titleRaw);
        const year = parseYear(titleRaw);
        const priceInfo = pickPrice(lot, rt);
        const appraisal = parseMoney(lot.ValorAvaliacao ?? null);
        const appraisalRaw = formatMoneyRaw(appraisal);
        const imageUrls = pickImageUrls(lot);
        const yard = normalizeYard(lot);
        const status = normalizeSpace(rt?.Lote_SubStatus_Label) || normalizeSpace(rt?.StatusLote);
        const descriptionParts = [
            titleRaw,
            lot.LoteNumero ? `Lote: ${normalizeSpace(lot.LoteNumero)}` : null,
            status || null,
            yard,
            appraisalRaw ? `Avaliação: ${appraisalRaw}` : null
        ].filter(Boolean);
        out.push({
            source: "mgl",
            brand: brand || "UNKNOWN",
            model: model || "SEM MODELO",
            year,
            damage: null,
            price: priceInfo.price,
            priceRaw: priceInfo.priceRaw,
            priceLabel: priceInfo.priceLabel,
            imageUrls,
            description: descriptionParts.join(" · ").slice(0, 260),
            url,
            auctionDate: pickAuctionDate(rt),
            lot: normalizeSpace(lot.LoteNumero) || undefined,
            yard,
            appraisal,
            appraisalRaw,
            fipe: null,
            fipeRaw: null
        });
    }
    log(`[mgl] ${out.length} lote(s) convertido(s) nesta página.`);
    return out;
}
async function fetchPageFromBrowser(page, pageNumber) {
    const endpointUrl = `${BASE_URL}${SEARCH_ENDPOINT_PATH}/${pageNumber}/1/0?${CATEGORY_FILTERS.map((value) => `FiltroCategorias=${value}`).join("&")}`;
    const requestBody = buildRequestBody(pageNumber);
    return page.evaluate(async ({ endpointUrlInput, bodyInput }) => {
        const readCookie = (name) => {
            const prefix = `${name}=`;
            const cookie = document.cookie
                .split(";")
                .map((part) => part.trim())
                .find((part) => part.startsWith(prefix));
            if (!cookie)
                return "";
            const rawValue = cookie.slice(prefix.length);
            try {
                return decodeURIComponent(rawValue);
            }
            catch {
                return rawValue;
            }
        };
        const rvtFromInput = document.querySelector('input[name="__rvt"]')?.value ??
            document.querySelector('input[name="__RequestVerificationToken"]')?.value ??
            "";
        const rvtFromMeta = document.querySelector('meta[name="__rvt"]')?.getAttribute("content") ??
            document.querySelector('meta[name="__RequestVerificationToken"]')?.getAttribute("content") ??
            "";
        const xsrfFromCookie = readCookie("XSRF-TOKEN");
        const rvtToken = String(window.__rvt ??
            rvtFromInput ??
            rvtFromMeta ??
            xsrfFromCookie).trim();
        const headers = {
            method: "POST",
            Accept: "application/json, text/javascript, */*; q=0.01",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Requested-With": "XMLHttpRequest"
        };
        if (rvtToken) {
            headers.__rvt = rvtToken;
            headers["X-XSRF-TOKEN"] = rvtToken;
        }
        const response = await fetch(endpointUrlInput, {
            method: "POST",
            headers,
            credentials: "include",
            body: JSON.stringify(bodyInput)
        });
        return {
            ok: response.ok,
            status: response.status,
            contentType: (response.headers.get("content-type") ?? "").toLowerCase(),
            raw: await response.text()
        };
    }, {
        endpointUrlInput: endpointUrl,
        bodyInput: requestBody
    });
}
function isJsonEndpointResponse(response) {
    return response.contentType.includes("application/json") && tryParseResponse(response.raw) != null;
}
function looksLikeBlockedResponse(response) {
    if (isJsonEndpointResponse(response))
        return false;
    return looksLikeCloudflareChallenge(response.raw);
}
async function fetchPageFromBrowserWithRetry(page, pageNumber, log, attempts = 3) {
    let lastResponse = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const response = await fetchPageFromBrowser(page, pageNumber);
        lastResponse = response;
        if (isJsonEndpointResponse(response)) {
            return response;
        }
        if (looksLikeBlockedResponse(response)) {
            log(`[mgl] Página ${pageNumber} via navegador bloqueada (tentativa ${attempt}/${attempts}).`);
            await page.waitForTimeout(2_500);
            continue;
        }
        if (!response.ok) {
            log(`[mgl] Página ${pageNumber} via navegador retornou HTTP ${response.status} (tentativa ${attempt}/${attempts}).`);
            await page.waitForTimeout(1_250);
            continue;
        }
        // Resposta inesperada (HTTP 200 sem JSON válido).
        const snippet = normalizeSpace(response.raw).slice(0, 160);
        log(`[mgl] Página ${pageNumber} via navegador sem JSON válido (tentativa ${attempt}/${attempts})` +
            (snippet ? ` | trecho: ${snippet}` : ""));
        await page.waitForTimeout(1_250);
    }
    if (lastResponse)
        return lastResponse;
    throw new Error(`falha ao carregar página ${pageNumber} via navegador`);
}
async function pageLooksBlocked(page) {
    const html = await page.content().catch(() => "");
    if (!html)
        return false;
    return looksLikeCloudflareChallenge(html);
}
async function scrapeViaBrowser(maxPages, headless, log) {
    const launchOptions = buildPlaywrightLaunchOptions(headless);
    const persistentProfileDir = parsePersistentProfileDir();
    const manualChallengeWaitMs = parseManualChallengeWaitMs();
    let context = null;
    let browser = null;
    try {
        if (persistentProfileDir) {
            log(`[mgl] Usando perfil persistente do navegador: ${persistentProfileDir}`);
            context = await chromium.launchPersistentContext(persistentProfileDir, {
                ...launchOptions,
                userAgent: USER_AGENT,
                locale: "pt-BR"
            });
        }
        else {
            browser = await chromium.launch(launchOptions);
            context = await browser.newContext({
                userAgent: USER_AGENT,
                locale: "pt-BR"
            });
        }
        const page = context.pages()[0] ?? await context.newPage();
        log("[mgl] Abrindo sessão navegador para contornar proteção...");
        await page.goto(`${BASE_URL}/`, {
            waitUntil: "domcontentloaded",
            timeout: 90_000
        });
        await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => undefined);
        await page.waitForTimeout(6_000);
        // Garante inicialização do mesmo contexto da tela de busca.
        await page.goto(`${BASE_URL}/comprar/`, {
            waitUntil: "domcontentloaded",
            timeout: 90_000
        });
        await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
        if (await pageLooksBlocked(page)) {
            if (!headless) {
                const seconds = Math.round(manualChallengeWaitMs / 1000);
                log(`[mgl] Desafio anti-bot detectado. Aguardando resolução manual por até ${seconds}s...`);
                await page.bringToFront().catch(() => undefined);
                await page.waitForTimeout(manualChallengeWaitMs);
            }
            else {
                log("[mgl] Desafio anti-bot detectado. Tentando validação automática...");
                await page.waitForTimeout(8_000);
            }
            await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 }).catch(() => undefined);
            await page.waitForLoadState("networkidle", { timeout: 25_000 }).catch(() => undefined);
            await page.waitForTimeout(2_000);
            if (await pageLooksBlocked(page)) {
                throw new Error("Cloudflare ainda bloqueando após tentativa de validação. " +
                    "Use HEADLESS=false e, se possível, configure MGL_USER_DATA_DIR para reaproveitar sessão.");
            }
        }
        const all = [];
        const seenUrls = new Set();
        let totalPagesDetected = 1;
        const first = await fetchPageFromBrowserWithRetry(page, 1, log);
        const firstParsed = tryParseResponse(first.raw);
        if (!first.ok || !firstParsed) {
            if (looksLikeBlockedResponse(first)) {
                throw new Error("challenge anti-bot persistente na página 1 via navegador");
            }
            throw new Error(`falha na página 1 via navegador (HTTP ${first.status})`);
        }
        const firstVehicles = parseLots(firstParsed, log);
        for (const vehicle of firstVehicles) {
            if (seenUrls.has(vehicle.url))
                continue;
            seenUrls.add(vehicle.url);
            all.push(vehicle);
        }
        totalPagesDetected = parseTotalPages(firstParsed);
        const totalPagesToRead = Math.max(1, Math.min(totalPagesDetected, maxPages));
        log(`[mgl] Página(s) via navegador: total=${totalPagesDetected} | limite=${maxPages} | varrendo=${totalPagesToRead}.`);
        for (let pageNumber = 2; pageNumber <= totalPagesToRead; pageNumber += 1) {
            const response = await fetchPageFromBrowserWithRetry(page, pageNumber, log);
            const parsed = tryParseResponse(response.raw);
            if (!response.ok || !parsed) {
                if (looksLikeBlockedResponse(response)) {
                    log(`[mgl] Falha página ${pageNumber} via navegador: challenge anti-bot persistente.`);
                }
                else {
                    log(`[mgl] Falha página ${pageNumber} via navegador: HTTP ${response.status}.`);
                }
                continue;
            }
            const vehicles = parseLots(parsed, log);
            for (const vehicle of vehicles) {
                if (seenUrls.has(vehicle.url))
                    continue;
                seenUrls.add(vehicle.url);
                all.push(vehicle);
            }
            await sleep(REQUEST_DELAY_MS);
        }
        return all;
    }
    finally {
        await context?.close().catch(() => undefined);
        if (browser) {
            await browser.close().catch(() => undefined);
        }
    }
}
export async function scrapeMgl(_filters, options) {
    const log = options?.log ?? console.log;
    const headless = options?.headless ?? true;
    const maxPages = parseMaxPagesFromEnv();
    log("[mgl] Iniciando...");
    const firstDirect = await fetchPageDirect(1, log);
    if (firstDirect &&
        firstDirect.ok &&
        firstDirect.contentType.includes("application/json")) {
        const parsedFirst = tryParseResponse(firstDirect.raw);
        if (parsedFirst) {
            const all = [];
            const seenUrls = new Set();
            const firstVehicles = parseLots(parsedFirst, log);
            for (const vehicle of firstVehicles) {
                if (seenUrls.has(vehicle.url))
                    continue;
                seenUrls.add(vehicle.url);
                all.push(vehicle);
            }
            const totalPagesDetected = parseTotalPages(parsedFirst);
            const totalPagesToRead = Math.max(1, Math.min(totalPagesDetected, maxPages));
            log(`[mgl] Página(s) via HTTP: total=${totalPagesDetected} | limite=${maxPages} | varrendo=${totalPagesToRead}.`);
            for (let pageNumber = 2; pageNumber <= totalPagesToRead; pageNumber += 1) {
                const response = await fetchPageDirect(pageNumber, log);
                if (!response)
                    continue;
                const parsed = tryParseResponse(response.raw);
                if (!response.ok || !parsed) {
                    log(`[mgl] Falha página ${pageNumber} via HTTP: HTTP ${response.status}.`);
                    continue;
                }
                const vehicles = parseLots(parsed, log);
                for (const vehicle of vehicles) {
                    if (seenUrls.has(vehicle.url))
                        continue;
                    seenUrls.add(vehicle.url);
                    all.push(vehicle);
                }
                await sleep(REQUEST_DELAY_MS);
            }
            log(`[mgl] Total via HTTP: ${all.length} veículo(s).`);
            return all;
        }
    }
    const directFailureReason = firstDirect
        ? looksLikeCloudflareChallenge(firstDirect.raw)
            ? "challenge anti-bot detectado"
            : `HTTP ${firstDirect.status}`
        : "falha de rede";
    log(`[mgl] HTTP direto indisponível (${directFailureReason}). Tentando navegador...`);
    try {
        const vehicles = await scrapeViaBrowser(maxPages, headless, log);
        log(`[mgl] Total via navegador: ${vehicles.length} veículo(s).`);
        return vehicles;
    }
    catch (error) {
        log(`[mgl] Falha no fallback navegador: ${error instanceof Error ? error.message : String(error)}`);
        return [];
    }
}
