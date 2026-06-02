import { load } from "cheerio";
const BASE = "https://www.favaretoleiloes.com.br";
const LEILOES_URL = "https://www.favaretoleiloes.com.br/leiloes/";
const API_URL = `${BASE}/classes/json_lance.php`;
const HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "pt-BR,pt;q=0.9",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};
async function fetchHtml(url, log) {
    try {
        const res = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
            log(`[favareto] HTTP ${res.status} em ${url}`);
            return null;
        }
        return res.text();
    }
    catch (err) {
        log(`[favareto] Erro em ${url}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}
async function fetchLotDetails(editalId, seq) {
    try {
        const res = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": `${BASE}/lance/${editalId}/${seq}/`,
                "User-Agent": HEADERS["User-Agent"],
                "X-Requested-With": "XMLHttpRequest"
            },
            body: `ordem=${seq}&leilao=${editalId}`
        });
        if (!res.ok)
            return null;
        return res.json();
    }
    catch {
        return null;
    }
}
async function fetchLotHistory(editalId, seq, lotDate) {
    try {
        const params = new URLSearchParams({
            seq: String(seq),
            data: String(editalId),
            dataleilao: String(lotDate ?? "")
        });
        const res = await fetch(`${BASE}/classes/json_historico.php`, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
                "Referer": `${BASE}/lance/${editalId}/${seq}/`,
                "User-Agent": HEADERS["User-Agent"],
                "X-Requested-With": "XMLHttpRequest"
            },
            body: params.toString()
        });
        if (!res.ok)
            return null;
        return res.json();
    }
    catch {
        return null;
    }
}
function parseEditalId(url) {
    const m = url.match(/\/edital\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}
function parseYear(text) {
    const m = text.match(/\b(20\d{2})\/(?:20\d{2})\b/);
    return m ? parseInt(m[1], 10) : null;
}
function parsePrice(rawValue) {
    if (rawValue == null)
        return null;
    let raw = String(rawValue).trim();
    if (!raw)
        return null;
    raw = raw.replace(/\u00a0/g, " ").replace(/R\$\s*/gi, "").trim();
    if (!raw)
        return null;
    if (raw.includes(",") && raw.includes(".")) {
        // "38.400,00"
        raw = raw.replace(/\./g, "").replace(",", ".");
    }
    else if (raw.includes(",")) {
        // "38400,00"
        raw = raw.replace(",", ".");
    }
    else {
        // "38.400" (milhar) vs "38400.00" (decimal)
        const dots = (raw.match(/\./g) ?? []).length;
        if (dots > 1) {
            raw = raw.replace(/\./g, "");
        }
        else if (dots === 1) {
            const [left, right] = raw.split(".");
            if ((right?.length ?? 0) === 3) {
                raw = `${left}${right}`;
            }
        }
    }
    raw = raw.replace(/[^\d.-]/g, "");
    if (!raw)
        return null;
    const numeric = Number.parseFloat(raw);
    if (!Number.isFinite(numeric) || numeric <= 0)
        return null;
    return Math.round(numeric);
}
function pickLotPrice(lot, history, editalBidRaw) {
    const fromHistory = parsePrice(history?.top_lance) ??
        parsePrice(history?.lance_atual) ??
        parsePrice(history?.of1);
    if (fromHistory != null) {
        return {
            price: fromHistory,
            priceRaw: `R$ ${fromHistory.toLocaleString("pt-BR")}`,
            priceLabel: "Último lance"
        };
    }
    const fromEdital = parsePrice(editalBidRaw);
    if (fromEdital != null) {
        return {
            price: fromEdital,
            priceRaw: `R$ ${fromEdital.toLocaleString("pt-BR")}`,
            priceLabel: "Lance atual"
        };
    }
    const fromMinimo = parsePrice(lot.minimo);
    if (fromMinimo != null) {
        return {
            price: fromMinimo,
            priceRaw: `R$ ${fromMinimo.toLocaleString("pt-BR")}`,
            priceLabel: "Lance inicial"
        };
    }
    return { price: null, priceRaw: null, priceLabel: null };
}
function buildImageUrls(lot) {
    const urls = [];
    const count = Math.min(lot.qtde ?? 0, 4);
    const keys = ["foto0", "foto1", "foto2", "foto3", "foto4", "foto5", "foto6", "foto7", "foto8"];
    for (let i = 0; i < count; i++) {
        const fname = lot[keys[i]];
        if (fname)
            urls.push(`${lot.path_foto}${fname}`);
    }
    return urls;
}
function parseAuctionDate(data) {
    // "13/05/2026" or "13/05/26"
    const m = data.match(/(\d{2})\/(\d{2})\/(\d{2,4})/);
    if (!m)
        return null;
    const y = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
    return new Date(y, parseInt(m[2], 10) - 1, parseInt(m[1], 10));
}
function normalizeSpace(raw) {
    return (raw ?? "").replace(/\s+/g, " ").trim();
}
function normalizeYardToken(raw) {
    return normalizeSpace(raw)
        .replace(/\s*\/\s*/g, "/")
        .replace(/\s*-\s*/g, " - ")
        .trim();
}
function extractFavaretoYardFromText(raw) {
    const text = normalizeSpace(raw);
    if (!text)
        return null;
    const transferMatch = text.match(/Transferid[oa]\s+em\s*:?\s*([A-Za-zÀ-ÿ0-9 .()/-]+?)(?=\s*(?:\||·|Lote|Data|Leil[aã]o|$))/i) ??
        text.match(/P[aá]tio\s*:?\s*([A-Za-zÀ-ÿ0-9 .()/-]+?)(?=\s*(?:\||·|Lote|Data|Leil[aã]o|$))/i);
    if (transferMatch?.[1]) {
        return normalizeYardToken(transferMatch[1]);
    }
    const cityUfMatch = text.match(/\b([A-Za-zÀ-ÿ ]{2,})\s*[-/]\s*([A-Z]{2})\b/);
    if (cityUfMatch) {
        return normalizeYardToken(`${cityUfMatch[1]} - ${cityUfMatch[2]}`);
    }
    return null;
}
function extractFavaretoYard(lot, row) {
    const fromObs = extractFavaretoYardFromText(lot.obs);
    if (fromObs)
        return fromObs;
    const fromVehicle = extractFavaretoYardFromText(lot.veiculo);
    if (fromVehicle)
        return fromVehicle;
    const fromBem = extractFavaretoYardFromText(lot.bem);
    if (fromBem)
        return fromBem;
    const fromRow = extractFavaretoYardFromText(row.descRaw);
    if (fromRow)
        return fromRow;
    // Favareto opera com pátio base em Curitiba/PR; mantém filtro geográfico consistente.
    return "Curitiba - PR";
}
function parseEditalRows(html, editalId) {
    const $ = load(html);
    const rows = [];
    $("table tr").each((_i, tr) => {
        const cells = $(tr).find("td");
        if (cells.length < 2)
            return;
        // Extrai seq do onclick da célula com "Ver Lote"
        const onclick = $(tr).find("a[onclick]").attr("onclick") ?? "";
        const seqM = onclick.match(/tela_lance\(\s*\d+\s*,\s*(\d+)\s*\)/);
        if (!seqM)
            return;
        const seq = parseInt(seqM[1], 10);
        const descRaw = $(cells[1]).text().trim();
        if (!descRaw)
            return;
        const slashIdx = descRaw.indexOf("/");
        const brandRaw = (slashIdx > -1 ? descRaw.slice(0, slashIdx) : descRaw.split(" ")[0]).trim().toUpperCase();
        const bidRaw = normalizeSpace($(cells[6]).text() ?? "");
        const editalBidRaw = bidRaw && !/\*{2,}/.test(bidRaw) ? bidRaw : null;
        rows.push({ editalId, seq, descRaw, brandRaw, editalBidRaw });
    });
    return rows;
}
export async function scrapeFavareto(filters, options) {
    const log = options?.log ?? console.log;
    log("[favareto] Buscando lista de leilões...");
    const leiloesHtml = await fetchHtml(LEILOES_URL, log);
    if (!leiloesHtml) {
        log("[favareto] Falha ao carregar página de leilões.");
        return [];
    }
    // Extrai links de editais (relativos: "edital/1619")
    const $ = load(leiloesHtml);
    const editalUrls = [];
    $("a").each((_i, el) => {
        const href = $(el).attr("href") ?? "";
        if (/edital\/\d+/i.test(href) && !href.startsWith("javascript")) {
            const abs = href.startsWith("http") ? href : `${BASE}/${href.replace(/^\//, "")}`;
            if (!editalUrls.includes(abs))
                editalUrls.push(abs);
        }
    });
    if (editalUrls.length === 0) {
        log("[favareto] Nenhum edital encontrado.");
        return [];
    }
    log(`[favareto] ${editalUrls.length} edital(is): ${editalUrls.join(", ")}`);
    const allResults = [];
    const seenKeys = new Set();
    for (const editalUrl of editalUrls.slice(0, 3)) {
        const editalId = parseEditalId(editalUrl);
        if (!editalId)
            continue;
        const editalHtml = await fetchHtml(editalUrl, log);
        if (!editalHtml)
            continue;
        const rows = parseEditalRows(editalHtml, editalId);
        log(`[favareto] edital ${editalId}: ${rows.length} lote(s) total.`);
        const matching = rows;
        log(`[favareto] edital ${editalId}: ${matching.length} lote(s) com marca filtrada.`);
        for (const row of matching) {
            const lot = await fetchLotDetails(row.editalId, row.seq);
            if (!lot)
                continue;
            const history = await fetchLotHistory(row.editalId, row.seq, lot.data);
            const year = parseYear(lot.ano);
            const priceInfo = pickLotPrice(lot, history, row.editalBidRaw);
            // Marca/modelo do JSON da API (mais completo que o edital)
            const slashIdx = lot.veiculo.indexOf("/");
            const brandApiRaw = slashIdx > -1 ? lot.veiculo.slice(0, slashIdx).trim().toUpperCase() : row.brandRaw;
            const modelApiRaw = slashIdx > -1 ? lot.veiculo.slice(slashIdx + 1).trim() : lot.veiculo;
            const matchedBrand = brandApiRaw || row.brandRaw || null;
            const matchedModel = modelApiRaw;
            const imageUrls = buildImageUrls(lot);
            const kmRaw = lot.km ? String(lot.km).replace(/\D/g, "") : null;
            const kmFormatted = kmRaw ? Number(kmRaw).toLocaleString("pt-BR") : null;
            const desc = [lot.obs || null]
                .filter(Boolean)
                .join(" ")
                .slice(0, 200);
            const yard = extractFavaretoYard(lot, row);
            const lotUrl = `${BASE}/lance/${row.editalId}/${row.seq}/`;
            const key = `${matchedBrand ?? "UNKNOWN"}|${lot.bem}|${row.editalId}`;
            if (seenKeys.has(key))
                continue;
            seenKeys.add(key);
            allResults.push({
                source: "favareto",
                brand: (matchedBrand ?? "UNKNOWN").trim() || "UNKNOWN",
                model: matchedModel,
                year,
                damage: null,
                price: priceInfo.price,
                priceRaw: priceInfo.priceRaw,
                priceLabel: priceInfo.priceLabel,
                imageUrls,
                description: desc,
                url: lotUrl,
                auctionDate: parseAuctionDate(lot.data),
                km: kmFormatted,
                color: lot.cor || null,
                yard
            });
            // Pausa entre chamadas à API
            await new Promise((r) => setTimeout(r, 200));
        }
    }
    log(`[favareto] Total: ${allResults.length} veículo(s).`);
    return allResults;
}
