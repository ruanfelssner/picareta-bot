const CITY_HINTS = [
  "Curitiba",
  "Maringá",
  "Maringa",
  "Londrina",
  "Ponta Grossa",
  "Joinville",
  "Florianópolis",
  "Florianopolis",
  "São Paulo",
  "Sao Paulo"
];

const STATE_UF = ["PR", "SC", "SP", "RS"];
const MATCH_STOPWORDS = new Set([
  "de",
  "do",
  "da",
  "dos",
  "das",
  "e",
  "a",
  "o",
  "as",
  "os",
  "para",
  "com",
  "sem",
  "na",
  "no",
  "nas",
  "nos",
  "em",
  "um",
  "uma"
]);

const TOKEN_ALIASES: Record<string, string> = {
  rodas: "roda",
  pneus: "pneu",
  furos: "furo"
};

const GENERIC_MARKETPLACE_TITLES = new Set([
  "gratis",
  "gratuito",
  "gratuita",
  "free",
  "doacao",
  "doacoes"
]);

function normalizeForMatch(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function canonicalizeToken(token: string): string {
  return TOKEN_ALIASES[token] ?? token;
}

function isFuzzyComparableToken(token: string): boolean {
  return token.length >= 5 && /^[a-z]+$/i.test(token);
}

function hasMaxDistanceOne(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;

  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }

    edits += 1;
    if (edits > 1) return false;

    if (la > lb) {
      i += 1;
    } else if (lb > la) {
      j += 1;
    } else {
      i += 1;
      j += 1;
    }
  }

  if (i < la || j < lb) edits += 1;
  return edits <= 1;
}

function hasFuzzyTokenMatch(token: string, textTokens: string[]): boolean {
  if (!isFuzzyComparableToken(token)) {
    return false;
  }

  for (const candidate of textTokens) {
    if (!isFuzzyComparableToken(candidate)) continue;
    if (candidate[0] !== token[0]) continue;
    if (hasMaxDistanceOne(token, candidate)) {
      return true;
    }
  }

  return false;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPriceLine(line: string): boolean {
  return /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/i.test(line);
}

export function looksLikeLocationLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed || isPriceLine(trimmed)) {
    return false;
  }

  const normalized = normalizeForMatch(trimmed);
  const hasKnownCity = CITY_HINTS.some((city) =>
    normalized.includes(normalizeForMatch(city))
  );

  if (hasKnownCity) {
    return trimmed.length <= 60;
  }

  const hasUf = /\b(PR|SC|SP|RS)\b/i.test(trimmed);
  if (!hasUf) {
    return false;
  }

  const isCityUfPattern =
    /[A-Za-zÀ-ÿ'\-\s]{3,}\s*[-,]\s*(PR|SC|SP|RS)\b/i.test(trimmed) ||
    /^(PR|SC|SP|RS)$/i.test(trimmed);

  if (!isCityUfPattern) {
    return false;
  }

  return trimmed.length <= 60;
}

export function normalizeText(text: string): string {
  return text
    .replace(/\u00A0/g, " ")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function extractPrice(text: string): string | null {
  const normalized = normalizeText(text);
  const match = normalized.match(/R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{2})?/i);
  return match ? match[0].replace(/\s+/g, " ").trim() : null;
}

export function parsePriceToCents(priceRaw: string | null | undefined): number | null {
  if (!priceRaw) {
    return null;
  }

  const match = priceRaw.match(/R\$\s?(\d{1,3}(?:\.\d{3})*(?:,\d{2})?)/i);
  if (!match) {
    return null;
  }

  const numericPart = match[1];
  const normalized = numericPart.replace(/\./g, "").replace(",", ".");
  const value = Number.parseFloat(normalized);
  if (Number.isNaN(value) || value < 0) {
    return null;
  }

  return Math.round(value * 100);
}

export function formatCentsToBrl(cents: number | null | undefined): string | null {
  if (cents == null || !Number.isFinite(cents) || cents < 0) {
    return null;
  }

  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL"
  }).format(cents / 100);
}

export function formatIsoToPtBr(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) {
    return isoDate;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function extractLocation(text: string): string | null {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const lines = normalized.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isPriceLine(trimmed)) {
      continue;
    }

    if (looksLikeLocationLine(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

export function extractTitle(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return "";
  }

  const lines = normalized.split("\n");

  for (const line of lines) {
    const candidate = line.trim();
    if (!candidate) {
      continue;
    }

    if (isPriceLine(candidate)) {
      continue;
    }

    if (looksLikeLocationLine(candidate)) {
      continue;
    }

    if (isGenericMarketplaceTitle(candidate)) {
      continue;
    }

    if (candidate.length >= 3) {
      return candidate;
    }
  }

  const nonPriceFallback = lines.find((line) => {
    const candidate = line.trim();
    return candidate.length > 0 && !isPriceLine(candidate) && !isGenericMarketplaceTitle(candidate);
  });
  if (nonPriceFallback) {
    return nonPriceFallback.trim();
  }
  return "";
}

export function isGenericMarketplaceTitle(title: string | null | undefined): boolean {
  if (!title) {
    return true;
  }

  const normalized = normalizeForMatch(title)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return true;
  }

  if (GENERIC_MARKETPLACE_TITLES.has(normalized)) {
    return true;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  if (tokens.length > 0 && tokens.length <= 2 && tokens.every((token) => GENERIC_MARKETPLACE_TITLES.has(token))) {
    return true;
  }

  return false;
}

export function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value == null || value.trim() === "") {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

export function parsePositiveInt(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 1) {
    return defaultValue;
  }

  return parsed;
}

export function parseNonNegativeInt(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < 0) {
    return defaultValue;
  }

  return parsed;
}

export function normalizeSearchText(text: string): string {
  return normalizeForMatch(text)
    .replace(/(\d)\s*[x×]\s*(\d{2,3})/g, "$1x$2")
    .replace(/(\d)\s*furos?\s*(\d{2,3})/g, "$1x$2")
    .replace(/\baro\s*([1-2]\d)\b/g, "aro$1 $1")
    .replace(/[^a-z0-9x\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenizeSearchTerm(searchTerm: string): string[] {
  const normalized = normalizeSearchText(searchTerm);
  return Array.from(
    new Set(
      normalized
    .split(/\s+/)
    .map((token) => canonicalizeToken(token.trim()))
        .filter((token) => token.length >= 2 && !MATCH_STOPWORDS.has(token))
    )
  );
}

export function parseCsvTerms(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return [];
  }

  const flattened = value
    .split(",")
    .flatMap((chunk) => tokenizeSearchTerm(chunk))
    .filter(Boolean);

  return Array.from(new Set(flattened));
}

export function parseRatio(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === "") {
    return defaultValue;
  }

  const parsed = Number.parseFloat(value);
  if (Number.isNaN(parsed)) {
    return defaultValue;
  }

  if (parsed < 0) {
    return 0;
  }

  if (parsed > 1) {
    return 1;
  }

  return parsed;
}

export type TermMatchInput = {
  requiredTokens: string[];
  excludeTokens: string[];
  minRequiredRatio: number;
  requireAll: boolean;
};

export type TermMatchResult = {
  matchedTokens: string[];
  missingTokens: string[];
  excludedTokens: string[];
  matchScore: number;
  keep: boolean;
};

export function evaluateTermMatch(text: string, input: TermMatchInput): TermMatchResult {
  const tokensInText = new Set(tokenizeSearchTerm(text));
  const tokenCandidates = [...tokensInText];
  const requiredTokens = Array.from(new Set(input.requiredTokens.map((token) => token.toLowerCase())));
  const excludeTokens = Array.from(new Set(input.excludeTokens.map((token) => token.toLowerCase())));

  const matchedTokens = requiredTokens.filter(
    (token) => tokensInText.has(token) || hasFuzzyTokenMatch(token, tokenCandidates)
  );
  const matchedSet = new Set(matchedTokens);
  const missingTokens = requiredTokens.filter((token) => !matchedSet.has(token));
  const excludedTokens = excludeTokens.filter((token) => tokensInText.has(token));

  const denominator = requiredTokens.length;
  const matchScore = denominator === 0 ? 1 : matchedTokens.length / denominator;
  const passesRatio = matchScore >= input.minRequiredRatio;
  const passesAll = input.requireAll ? missingTokens.length === 0 : true;
  const keep = excludedTokens.length === 0 && passesRatio && passesAll;

  return {
    matchedTokens,
    missingTokens,
    excludedTokens,
    matchScore,
    keep
  };
}

export function findMatchedTokens(text: string, tokens: string[]): string[] {
  const evaluation = evaluateTermMatch(text, {
    requiredTokens: tokens,
    excludeTokens: [],
    minRequiredRatio: 0,
    requireAll: false
  });
  return evaluation.matchedTokens;
}

export function shouldKeepByTermMatch(searchTerm: string, matchedTokens: string[]): boolean {
  const tokens = tokenizeSearchTerm(searchTerm);
  if (tokens.length === 0) {
    return true;
  }

  return tokens.every((token) => matchedTokens.includes(token));
}

export function normalizeMarketplaceItemUrl(url: string): string {
  try {
    const parsed = new URL(url, "https://www.facebook.com");
    parsed.search = "";
    parsed.hash = "";

    return parsed.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function looksLikeBlockingVerification(text: string): boolean {
  const normalized = text.toLowerCase();
  return [
    "checkpoint",
    "verificação",
    "verificacao",
    "temporariamente bloqueado",
    "confirme sua identidade",
    "confirm your identity"
  ].some((snippet) => normalized.includes(snippet));
}

export function isLikelyLoginScreen(url: string, text: string, hasLoginInputs: boolean): boolean {
  const normalizedUrl = url.toLowerCase();
  const normalizedText = text.toLowerCase();

  const urlLoginHints =
    normalizedUrl.includes("/login") ||
    normalizedUrl.includes("checkpoint") ||
    normalizedUrl.includes("two_step_verification");

  const textLoginHints =
    normalizedText.includes("entrar") &&
    (normalizedText.includes("email") || normalizedText.includes("senha"));

  return urlLoginHints || hasLoginInputs || textLoginHints;
}

export function containsKnownUf(text: string): boolean {
  return STATE_UF.some((uf) => new RegExp(`\\b${uf}\\b`, "i").test(text));
}

export function extractLocationStateUf(locationRaw: string | null | undefined): string | null {
  if (!locationRaw) {
    return null;
  }

  const normalized = normalizeText(locationRaw);
  if (!normalized || normalized === "-") {
    return null;
  }

  const upper = normalized.toUpperCase();
  const stateMatch = upper.match(/(?:,|-)\s*([A-Z]{2})\b/);
  if (!stateMatch) {
    return null;
  }

  return stateMatch[1] ?? null;
}

export function isLocationInStates(
  locationRaw: string | null | undefined,
  states: string[]
): boolean {
  const uf = extractLocationStateUf(locationRaw);
  if (!uf) {
    return false;
  }

  const normalizedSet = new Set(states.map((state) => state.trim().toUpperCase()));
  return normalizedSet.has(uf);
}

export function isLocationOutsideParana(locationRaw: string | null | undefined): boolean {
  const uf = extractLocationStateUf(locationRaw);
  if (!uf) {
    return false;
  }

  return uf !== "PR";
}

export function extractListingAge(rawText: string): string | null {
  const normalized = normalizeText(rawText);
  if (!normalized) {
    return null;
  }

  const nowMatch = normalized.match(/acabou de ser anunciado/i);
  if (nowMatch) {
    return "agora";
  }

  const announcedAgo = normalized.match(/anunciado\s+(h[aá]\s+[^,\n]+)\s+em\b/i);
  if (announcedAgo?.[1]) {
    return normalizeText(announcedAgo[1]).toLowerCase();
  }

  const announcedYesterday = normalized.match(/anunciado\s+ontem\b/i);
  if (announcedYesterday) {
    return "ontem";
  }

  const announcedToday = normalized.match(/anunciado\s+hoje\b/i);
  if (announcedToday) {
    return "hoje";
  }

  return null;
}

export function stripMarketplaceSuggestionSections(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) {
    return normalized;
  }

  const lines = normalized.split("\n");
  const markerPatterns = [
    /sele[cç][oõ]es de hoje/i,
    /sele[cç][aã]o de hoje/i,
    /selections for you/i,
    /today'?s picks/i,
    /itens semelhantes/i
  ];

  const markerIndex = lines.findIndex((line) =>
    markerPatterns.some((pattern) => pattern.test(line))
  );

  if (markerIndex <= 0) {
    return normalized;
  }

  return lines.slice(0, markerIndex).join("\n").trim();
}

export function isResultSlightlyDistant(input: {
  relevanceLevel: string;
  matchScore: number;
  missingTokens?: string[];
}): boolean {
  if (input.relevanceLevel === "media" || input.relevanceLevel === "baixa") {
    return true;
  }

  if (input.matchScore < 1) {
    return true;
  }

  if ((input.missingTokens ?? []).length > 0) {
    return true;
  }

  return false;
}
