import { normalizeSearchText } from "../utils.js";
const PART_KEYWORDS = new Set([
    "coxim",
    "motor",
    "ponta",
    "eixo",
    "manga",
    "cubo",
    "rolamento",
    "amortecedor",
    "mola",
    "bandeja",
    "terminal",
    "pivô",
    "pivo",
    "bieleta",
    "radiador",
    "intercooler",
    "coletor",
    "escapamento",
    "downpipe",
    "abafador",
    "catalisador",
    "turbo",
    "bico",
    "injeção",
    "injecao",
    "embreagem",
    "pastilha",
    "disco",
    "pinça",
    "pinca",
    "suporte",
    "peça",
    "peca"
]);
const STRONG_PART_KEYWORDS = new Set([
    "coxim",
    "ponta",
    "eixo",
    "manga",
    "cubo",
    "rolamento",
    "amortecedor",
    "bandeja",
    "terminal",
    "pivo",
    "pivô",
    "downpipe",
    "abafador",
    "escapamento",
    "catalisador",
    "pastilha",
    "disco",
    "pinça",
    "pinca",
    "suporte",
    "peça",
    "peca"
]);
const VEHICLE_SALE_HINTS = [
    /\bfinanciamos\b/i,
    /\bentrada\b/i,
    /\bparcelas?\b/i,
    /\bkm\b/i,
    /\bcombust[ií]vel\b/i,
    /\bc[âa]mbio\b/i,
    /\bdire[çc][aã]o\b/i,
    /\bar condicionado\b/i,
    /\bmultim[ií]dia\b/i,
    /\bve[ií]culo\b/i,
    /\búnico dono\b/i,
    /\bano\b[:\s]/i,
    /\bvalor do ve[ií]culo\b/i
];
function isYearToken(token) {
    return /^(19|20)\d{2}$/.test(token);
}
function countRegexHits(text, patterns) {
    let hits = 0;
    for (const pattern of patterns) {
        if (pattern.test(text))
            hits += 1;
    }
    return hits;
}
function extractPartSignals(normalized) {
    const tokens = new Set(normalized.split(/\s+/).filter(Boolean));
    let hits = 0;
    for (const keyword of PART_KEYWORDS) {
        if (tokens.has(keyword))
            hits += 1;
    }
    return hits;
}
function lineMentionsAnyModel(line, modelTokens) {
    return modelTokens.some((token) => line.includes(token));
}
function lineIncludesYear(line, year) {
    if (new RegExp(`\\b${year}\\b`).test(line))
        return true;
    const rangeMatch = line.match(/\b(19|20)\d{2}\s*(?:a|até|-)\s*(19|20)\d{2}\b/i);
    if (rangeMatch) {
        const start = Number.parseInt(rangeMatch[0].match(/(19|20)\d{2}/)?.[0] || "", 10);
        const end = Number.parseInt(rangeMatch[0].match(/(?:a|até|-)\s*((19|20)\d{2})/i)?.[1] || "", 10);
        if (!Number.isNaN(start) && !Number.isNaN(end)) {
            return year >= Math.min(start, end) && year <= Math.max(start, end);
        }
    }
    const onwardMatch = line.match(/\b(19|20)\d{2}\s*(?:em diante|pra cima|ou superior)\b/i);
    if (onwardMatch) {
        const start = Number.parseInt(onwardMatch[0].match(/(19|20)\d{2}/)?.[0] || "", 10);
        if (!Number.isNaN(start)) {
            return year >= start;
        }
    }
    return false;
}
function hasYearModelCoherenceIssue(text, intent) {
    if (!intent.yearToken || intent.modelTokens.length === 0) {
        return false;
    }
    const targetYear = Number.parseInt(intent.yearToken, 10);
    if (Number.isNaN(targetYear))
        return false;
    const lines = text
        .split("\n")
        .map((line) => normalizeSearchText(line))
        .map((line) => line.trim())
        .filter(Boolean);
    const modelLines = lines.filter((line) => lineMentionsAnyModel(line, intent.modelTokens));
    if (modelLines.length === 0)
        return false;
    const hasCoherentLine = modelLines.some((line) => lineIncludesYear(line, targetYear));
    if (hasCoherentLine)
        return false;
    const hasYearElsewhere = lines.some((line) => lineIncludesYear(line, targetYear));
    return hasYearElsewhere;
}
function buildIntent(tokens) {
    const yearToken = tokens.find(isYearToken) ?? null;
    const modelTokens = tokens.filter((token) => !PART_KEYWORDS.has(token) &&
        !isYearToken(token) &&
        !/^\d+$/.test(token) &&
        token.length >= 3);
    const strongCardTokens = tokens.filter((token) => STRONG_PART_KEYWORDS.has(token));
    const cardRequiredAnyTokens = strongCardTokens.length > 0 ? strongCardTokens : tokens;
    return {
        yearToken,
        modelTokens,
        cardRequiredAnyTokens
    };
}
function assessAutoParts(text, matchedTokensCount, requiredTokensCount, intent) {
    const normalized = normalizeSearchText(text);
    const vehicleHints = countRegexHits(text, VEHICLE_SALE_HINTS);
    const partSignals = extractPartSignals(normalized);
    const looksLikeVehicleSale = vehicleHints >= 4 && partSignals <= 2;
    if (looksLikeVehicleSale) {
        return {
            relevanceLevel: "descartar",
            relevanceScore: 0,
            shouldOpenDetail: false,
            reason: "Sinais de anúncio de veículo completo"
        };
    }
    const coherenceIssue = hasYearModelCoherenceIssue(text, intent);
    if (coherenceIssue && matchedTokensCount >= Math.max(1, requiredTokensCount - 1)) {
        return {
            relevanceLevel: "media",
            relevanceScore: 0.58,
            shouldOpenDetail: true,
            reason: "Ano/modelo parecem desalinhados na descrição"
        };
    }
    if (requiredTokensCount > 0 && matchedTokensCount >= requiredTokensCount) {
        return {
            relevanceLevel: "alta",
            relevanceScore: 1,
            shouldOpenDetail: false,
            reason: "Todos os tokens obrigatórios no card"
        };
    }
    if (matchedTokensCount > 0) {
        return {
            relevanceLevel: "media",
            relevanceScore: 0.65,
            shouldOpenDetail: true,
            reason: "Match parcial de tokens"
        };
    }
    return {
        relevanceLevel: "baixa",
        relevanceScore: 0.2,
        shouldOpenDetail: false,
        reason: "Sem match relevante no card"
    };
}
export const autoPartsRuleFactory = {
    name: "auto_parts",
    supports: (tokens) => tokens.some((token) => PART_KEYWORDS.has(token)),
    create: (tokens) => {
        const requiredTokens = [...tokens];
        const intent = buildIntent(requiredTokens);
        return {
            ruleName: "auto_parts",
            requiredTokens,
            excludeTokens: [],
            cardRequiredAnyTokens: intent.cardRequiredAnyTokens,
            cardMinMatchedTokens: 1,
            assess: (text, matchedTokensCount) => assessAutoParts(text, matchedTokensCount, requiredTokens.length, intent)
        };
    }
};
