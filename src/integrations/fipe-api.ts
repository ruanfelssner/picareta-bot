import { parsePriceToCents } from "../utils.js";

export type FipeApiConfig = {
  enabled: boolean;
  baseUrl: string;
  vehicleType: "cars" | "motorcycles" | "trucks";
  subscriptionToken: string;
  reference: number | null;
  timeoutMs: number;
};

type FipeBrand = {
  code: string;
  name: string;
};

type FipeModel = {
  code: string;
  name: string;
};

type FipeYear = {
  code: string;
  name: string;
};

type FipeReference = {
  code: string | number;
  month?: string;
};

type FipePriceResponse = {
  price?: string;
  brand?: string;
  model?: string;
  modelYear?: number;
  fuel?: string;
  codeFipe?: string;
  referenceMonth?: string;
};

export type FipeLookupInput = {
  brand: string;
  model: string;
  year: number;
};

export type FipeLookupSuggestion = {
  code: string;
  name: string;
  score?: number;
};

export type FipeLookupSuggestions = {
  kind: "brand" | "model" | "year";
  items: FipeLookupSuggestion[];
  brandMatched?: string;
  modelMatched?: string;
};

export type FipeLookupResult =
  | {
      ok: true;
      data: {
        price: number | null;
        priceRaw: string | null;
        codeFipe: string | null;
        referenceMonth: string | null;
        modelYear: number | null;
        fuel: string | null;
        brandMatched: string;
        modelMatched: string;
        yearCodeMatched: string;
      };
    }
  | {
      ok: false;
      reason: string;
      suggestions?: FipeLookupSuggestions;
    };

function normalizeForMatch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeLookupText(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,;])/g, "$1")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tokenize(value: string): string[] {
  return normalizeForMatch(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 || token === "T");
}

function getTokenAliases(token: string): string[] {
  const normalized = normalizeForMatch(token);
  const aliases: Record<string, string[]> = {
    CL: ["COMF", "COMFORT", "COMFORTLINE"],
    COMF: ["CL", "COMFORT", "COMFORTLINE"],
    COMFORT: ["CL", "COMF", "COMFORTLINE"],
    COMFORTLINE: ["CL", "COMF", "COMFORT"],
    HL: ["HIGH", "HIGHLINE"],
    HIGH: ["HL", "HIGHLINE"],
    HIGHLINE: ["HL", "HIGH"],
    ALLSPACE: ["ALLSPAC"],
    ALLSPAC: ["ALLSPACE"],
    TSI: ["TSI"],
    TFSI: ["TFSI"]
  };
  return aliases[normalized] ?? [];
}

function buildTokenMatchScore(targetToken: string, candidateToken: string): number {
  if (targetToken === candidateToken) return 1;

  const targetAliases = getTokenAliases(targetToken);
  const candidateAliases = getTokenAliases(candidateToken);
  if (targetAliases.includes(candidateToken) || candidateAliases.includes(targetToken)) return 0.9;

  if (
    targetToken.length >= 3 &&
    candidateToken.length >= 3 &&
    (candidateToken.startsWith(targetToken) || targetToken.startsWith(candidateToken))
  ) {
    return 0.72;
  }

  if (
    targetToken.length >= 3 &&
    candidateToken.length >= 3 &&
    (candidateToken.includes(targetToken) || targetToken.includes(candidateToken))
  ) {
    return 0.45;
  }

  return 0;
}

function buildStringSimilarityScore(targetRaw: string, candidateRaw: string): number {
  const target = normalizeForMatch(targetRaw);
  const candidate = normalizeForMatch(candidateRaw);
  if (!target || !candidate) return 0;

  if (target === candidate) return 10_000;
  if (candidate.startsWith(target)) return 8_000 - (candidate.length - target.length);
  if (candidate.includes(target)) return 7_000 - (candidate.length - target.length);
  if (target.startsWith(candidate)) return 6_000 - (target.length - candidate.length);

  const targetTokens = tokenize(target);
  const candidateTokens = tokenize(candidate);
  if (targetTokens.length === 0 || candidateTokens.length === 0) return 0;

  let common = 0;
  let orderedHits = 0;
  for (const [targetIndex, token] of targetTokens.entries()) {
    let bestTokenScore = 0;
    for (const candidateToken of candidateTokens) {
      bestTokenScore = Math.max(bestTokenScore, buildTokenMatchScore(token, candidateToken));
    }
    common += bestTokenScore;

    const candidateAtSamePosition = candidateTokens[targetIndex];
    if (candidateAtSamePosition && buildTokenMatchScore(token, candidateAtSamePosition) >= 0.7) {
      orderedHits += 1;
    }
  }

  const coverage = common / Math.max(1, targetTokens.length);
  const precision = common / Math.max(1, candidateTokens.length);
  const compactTarget = target.replace(/\s+/g, "");
  const compactCandidate = candidate.replace(/\s+/g, "");
  const compactBonus =
    compactTarget.length >= 3 && compactCandidate.includes(compactTarget)
      ? 0.15
      : 0;
  const orderedBonus = targetTokens.length > 0 ? Math.min(0.18, (orderedHits / targetTokens.length) * 0.18) : 0;
  const score = coverage * 0.78 + precision * 0.16 + compactBonus + orderedBonus;
  return Math.round(score * 1_000);
}

function removeAuctionMetadataParentheses(value: string): string {
  const brazilStateCodes = new Set([
    "AC",
    "AL",
    "AP",
    "AM",
    "BA",
    "CE",
    "DF",
    "ES",
    "GO",
    "MA",
    "MT",
    "MS",
    "MG",
    "PA",
    "PB",
    "PR",
    "PE",
    "PI",
    "RJ",
    "RN",
    "RS",
    "RO",
    "RR",
    "SC",
    "SP",
    "SE",
    "TO"
  ]);

  return value.replace(/\(([^)]*)\)/g, (full, inner: string) => {
    const normalized = normalizeForMatch(inner);
    if (!normalized) return " ";
    if (brazilStateCodes.has(normalized)) return " ";
    if (/\b(?:REF|REFERENCIA|PLACA|CHASSI|RENAVAM|KM|PATIO|LOTE|LEILAO)\b/.test(normalized)) {
      return " ";
    }
    return full;
  });
}

function stripAuctionMetadataFromModel(value: string, year: number): string {
  let text = removeAuctionMetadataParentheses(normalizeLookupText(value));
  const yearPattern = "(?:19|20)\\d{2}";

  text = text
    .replace(new RegExp(`\\b${yearPattern}\\s*/\\s*${yearPattern}\\b`, "gi"), " ")
    .replace(/\bANO(?:\/MODELO|\s+MODELO)?\s*[:.-]?\s*(?:19|20)\d{2}(?:\s*\/\s*(?:19|20)\d{2})?/gi, " ");

  if (Number.isFinite(year) && year > 0) {
    text = text.replace(new RegExp(`\\b${escapeRegExp(String(Math.floor(year)))}\\b`, "g"), " ");
  }

  text = text
    .replace(/\b(?:PLACA\s+FINAL|FINAL\s+(?:DE|DA)\s+PLACA|FINAL\s+PLACA|PLACA)\b.*$/i, " ")
    .replace(/\b(?:REF\.?|REFERENCIA|REFERÊNCIA)\b.*$/i, " ")
    .replace(
      /\b(?:CHASSI|RENAVAM|SINISTRO|SUCATA|DUT|IPVA|LICENCIAMENTO|ALIENACAO|ALIENAÇÃO|OBS\.?|OBSERVACAO|OBSERVAÇÃO)\b.*$/i,
      " "
    );

  return normalizeLookupText(text.replace(/\s*[,;]\s*$/g, ""));
}

function uniqueModelQueries(queries: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const query of queries) {
    const cleaned = normalizeLookupText(query);
    const key = normalizeForMatch(cleaned);
    if (!cleaned || !key || seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }

  return result;
}

function buildModelQueryCandidates(modelQuery: string, year: number): string[] {
  const raw = normalizeLookupText(modelQuery);
  const withoutMetadataParentheses = removeAuctionMetadataParentheses(raw);
  const firstCommaSegment = withoutMetadataParentheses.split(/[;,]/, 1)[0] ?? "";
  const strippedFull = stripAuctionMetadataFromModel(withoutMetadataParentheses, year);
  const strippedFirstSegment = stripAuctionMetadataFromModel(firstCommaSegment, year);

  return uniqueModelQueries([
    strippedFirstSegment,
    strippedFull,
    firstCommaSegment,
    withoutMetadataParentheses,
    raw
  ]);
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function buildUrlWithReference(path: string, reference: number | null): string {
  if (reference == null) return path;
  return `${path}${path.includes("?") ? "&" : "?"}reference=${reference}`;
}

function getFriendlyErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function getFipeApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FipeApiConfig {
  const baseUrl = (env.FIPE_API_BASE_URL ?? "https://fipe.parallelum.com.br/api/v2")
    .trim()
    .replace(/\/$/, "");
  const vehicleTypeRaw = (env.FIPE_API_VEHICLE_TYPE ?? "cars").trim().toLowerCase();
  const vehicleType: FipeApiConfig["vehicleType"] =
    vehicleTypeRaw === "motorcycles" || vehicleTypeRaw === "trucks" ? vehicleTypeRaw : "cars";
  const subscriptionToken =
    (env.FIPE_API_TOKEN ?? env.FIPE_SUBSCRIPTION_TOKEN ?? env.X_SUBSCRIPTION_TOKEN ?? "").trim();
  const referenceValue = Number(env.FIPE_API_REFERENCE);
  const reference = Number.isFinite(referenceValue) && referenceValue > 0 ? Math.floor(referenceValue) : null;
  const timeoutMs = parsePositiveInt(env.FIPE_API_TIMEOUT_MS, 15_000);
  const enabled = (env.FIPE_API_ENABLED ?? "true").trim().toLowerCase() !== "false";

  return {
    enabled,
    baseUrl,
    vehicleType,
    subscriptionToken,
    reference,
    timeoutMs
  };
}

const brandCache = new Map<string, Promise<FipeBrand[]>>();
const modelCache = new Map<string, Promise<FipeModel[]>>();
const yearCache = new Map<string, Promise<FipeYear[]>>();
const referenceCache = new Map<string, Promise<number | null>>();

async function fetchFipeJson<T>(config: FipeApiConfig, path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(path, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(config.subscriptionToken
          ? {
              "X-Subscription-Token": config.subscriptionToken,
              Authorization: `Bearer ${config.subscriptionToken}`
            }
          : {})
      },
      signal: controller.signal
    });

    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`Resposta inválida da FIPE (não JSON): ${raw.slice(0, 160)}`);
    }

    if (!response.ok) {
      const errorMessage =
        parsed && typeof parsed === "object" && "error" in parsed
          ? String((parsed as Record<string, unknown>).error ?? "")
          : `HTTP ${response.status}`;
      throw new Error(`FIPE API falhou: ${errorMessage || `HTTP ${response.status}`}`);
    }

    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const errorMessage = String((parsed as Record<string, unknown>).error ?? "erro desconhecido");
      throw new Error(`FIPE API falhou: ${errorMessage}`);
    }

    return parsed as T;
  } catch (error) {
    const message = getFriendlyErrorMessage(error);
    if (/limite de taxa excedido/i.test(message)) {
      if (config.subscriptionToken) {
        throw new Error(
          "Limite de requisições da FIPE atingido. O FIPE_API_TOKEN está configurado, mas a API retornou limite; tente novamente em alguns minutos ou gere um novo token em fipe.online."
        );
      }
      throw new Error("Limite de requisições da FIPE atingido. Defina FIPE_API_TOKEN (token gratuito em fipe.online).");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function rankByName<T extends { code: string; name: string }>(
  items: T[],
  query: string,
  limit = 5
): Array<{ item: T; score: number }> {
  const normalizedQuery = normalizeForMatch(query);
  if (!normalizedQuery || items.length === 0) return [];

  return items
    .map((item) => ({
      item,
      score: buildStringSimilarityScore(normalizedQuery, item.name)
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

function rankByNameAcrossQueries<T extends { code: string; name: string }>(
  items: T[],
  queries: string[],
  limit = 5
): Array<{ item: T; score: number }> {
  const normalizedQueries = uniqueModelQueries(queries).map((query) => normalizeForMatch(query));
  if (normalizedQueries.length === 0 || items.length === 0) return [];

  return items
    .map((item) => {
      const score = normalizedQueries.reduce(
        (best, query) => Math.max(best, buildStringSimilarityScore(query, item.name)),
        0
      );
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));
}

function toLookupSuggestions<T extends { code: string; name: string }>(
  kind: FipeLookupSuggestions["kind"],
  entries: Array<{ item: T; score: number }>,
  extra: Omit<FipeLookupSuggestions, "kind" | "items"> = {}
): FipeLookupSuggestions {
  return {
    kind,
    ...extra,
    items: entries.map(({ item, score }) => ({
      code: String(item.code),
      name: item.name,
      score
    }))
  };
}

function yearSuggestions(
  years: FipeYear[],
  extra: Omit<FipeLookupSuggestions, "kind" | "items"> = {}
): FipeLookupSuggestions {
  return {
    kind: "year",
    ...extra,
    items: years.slice(0, 8).map((item) => ({
      code: String(item.code),
      name: item.name
    }))
  };
}

function pickBestByName<T extends { code: string; name: string }>(
  items: T[],
  query: string,
  minScore = 560
): T | null {
  const scored = rankByName(items, query, 1);

  const best = scored[0];
  if (!best) return null;
  if (best.score < minScore) return null;
  return best.item;
}

async function getBrands(config: FipeApiConfig): Promise<FipeBrand[]> {
  const key = `${config.vehicleType}|${config.reference ?? "latest"}`;
  const cached = brandCache.get(key);
  if (cached) return cached;

  const request = fetchFipeJson<FipeBrand[]>(
    config,
    buildUrlWithReference(`${config.baseUrl}/${config.vehicleType}/brands`, config.reference)
  );
  brandCache.set(key, request);
  return request;
}

async function getLatestReference(config: FipeApiConfig): Promise<number | null> {
  const key = `${config.baseUrl}|latest-reference`;
  const cached = referenceCache.get(key);
  if (cached) return cached;

  const request = fetchFipeJson<FipeReference[]>(config, `${config.baseUrl}/references`).then((references) => {
    if (!Array.isArray(references)) return null;
    for (const item of references) {
      const parsed = Number(item?.code);
      if (Number.isFinite(parsed) && parsed > 0) {
        return Math.floor(parsed);
      }
    }
    return null;
  });
  referenceCache.set(key, request);
  return request;
}

async function resolveFipeReferenceConfig(config: FipeApiConfig): Promise<FipeApiConfig> {
  if (config.reference != null) return config;
  const reference = await getLatestReference(config);
  if (reference == null) return config;
  return {
    ...config,
    reference
  };
}

async function getModels(config: FipeApiConfig, brandCode: string): Promise<FipeModel[]> {
  const key = `${config.vehicleType}|${config.reference ?? "latest"}|${brandCode}`;
  const cached = modelCache.get(key);
  if (cached) return cached;

  const request = fetchFipeJson<FipeModel[]>(
    config,
    buildUrlWithReference(
      `${config.baseUrl}/${config.vehicleType}/brands/${encodeURIComponent(brandCode)}/models`,
      config.reference
    )
  );
  modelCache.set(key, request);
  return request;
}

async function getYears(config: FipeApiConfig, brandCode: string, modelCode: string): Promise<FipeYear[]> {
  const key = `${config.vehicleType}|${config.reference ?? "latest"}|${brandCode}|${modelCode}`;
  const cached = yearCache.get(key);
  if (cached) return cached;

  const request = fetchFipeJson<FipeYear[]>(
    config,
    buildUrlWithReference(
      `${config.baseUrl}/${config.vehicleType}/brands/${encodeURIComponent(brandCode)}/models/${encodeURIComponent(
        modelCode
      )}/years`,
      config.reference
    )
  );
  yearCache.set(key, request);
  return request;
}

function pickYearCode(years: FipeYear[], year: number): FipeYear | null {
  if (!Number.isFinite(year) || year <= 0) return null;
  const yearText = String(Math.floor(year));

  const exactCode = years.find((item) => String(item.code).startsWith(`${yearText}-`));
  if (exactCode) return exactCode;

  const exactName = years.find((item) => new RegExp(`\\b${escapeRegExp(yearText)}\\b`).test(item.name));
  if (exactName) return exactName;

  const sorted = [...years]
    .map((item) => {
      const codeYear = Number(String(item.code).split("-")[0]);
      return {
        item,
        distance: Number.isFinite(codeYear) ? Math.abs(codeYear - year) : Number.MAX_SAFE_INTEGER
      };
    })
    .sort((a, b) => a.distance - b.distance);

  const best = sorted[0];
  if (!best || best.distance > 2) return null;
  return best.item;
}

export async function lookupFipeByBrandModelYear(
  config: FipeApiConfig,
  input: FipeLookupInput
): Promise<FipeLookupResult> {
  if (!config.enabled) {
    return { ok: false, reason: "Integração FIPE desabilitada (FIPE_API_ENABLED=false)." };
  }

  const brandQuery = input.brand.trim();
  const modelQuery = input.model.trim();
  const year = Math.floor(input.year);
  if (!brandQuery || !modelQuery || !Number.isFinite(year) || year <= 0) {
    return {
      ok: false,
      reason: "Dados insuficientes para FIPE. Informe marca, modelo e ano válidos."
    };
  }

  try {
    const effectiveConfig = await resolveFipeReferenceConfig(config);
    const brands = await getBrands(effectiveConfig);
    const brandMatched = pickBestByName(brands, brandQuery);
    if (!brandMatched) {
      return {
        ok: false,
        reason: `Marca não encontrada na FIPE: "${brandQuery}".`,
        suggestions: toLookupSuggestions("brand", rankByName(brands, brandQuery, 5))
      };
    }

    const models = await getModels(effectiveConfig, brandMatched.code);
    const modelQueries = buildModelQueryCandidates(modelQuery, year);
    const rankedModels = rankByNameAcrossQueries(
      models,
      [
        ...modelQueries,
        ...modelQueries.map((query) => `${brandQuery} ${query}`)
      ],
      10
    );
    const bestModel = rankedModels[0] ?? null;
    if (!bestModel || bestModel.score < 620) {
      const cleanQuery = modelQueries[0] ?? modelQuery;
      return {
        ok: false,
        reason:
          cleanQuery && normalizeForMatch(cleanQuery) !== normalizeForMatch(modelQuery)
            ? `Modelo não encontrado na FIPE: "${modelQuery}" (consulta limpa: "${cleanQuery}").`
            : `Modelo não encontrado na FIPE: "${modelQuery}".`,
        suggestions: toLookupSuggestions("model", rankedModels.slice(0, 6), {
          brandMatched: brandMatched.name
        })
      };
    }

    const candidateModels = rankedModels
      .filter((entry) => {
        if (entry.score < 620) return false;
        if (bestModel.score >= 9_000) return entry.score >= 9_000;
        return entry.score >= Math.max(620, bestModel.score - 250);
      })
      .slice(0, 8);

    let modelMatched = bestModel.item;
    let years = await getYears(effectiveConfig, brandMatched.code, modelMatched.code);
    let yearMatched = pickYearCode(years, year);

    if (!yearMatched) {
      for (const candidate of candidateModels) {
        if (candidate.item.code === modelMatched.code) continue;

        const candidateYears = await getYears(effectiveConfig, brandMatched.code, candidate.item.code);
        const candidateYearMatched = pickYearCode(candidateYears, year);
        if (!candidateYearMatched) continue;

        modelMatched = candidate.item;
        years = candidateYears;
        yearMatched = candidateYearMatched;
        break;
      }
    }

    if (!yearMatched) {
      return {
        ok: false,
        reason: `Ano não encontrado na FIPE para "${modelMatched.name}": ${year}.`,
        suggestions: yearSuggestions(years, {
          brandMatched: brandMatched.name,
          modelMatched: modelMatched.name
        })
      };
    }

    const detail = await fetchFipeJson<FipePriceResponse>(
      effectiveConfig,
      buildUrlWithReference(
        `${effectiveConfig.baseUrl}/${effectiveConfig.vehicleType}/brands/${encodeURIComponent(
          brandMatched.code
        )}/models/${encodeURIComponent(modelMatched.code)}/years/${encodeURIComponent(yearMatched.code)}`,
        effectiveConfig.reference
      )
    );

    const priceRaw = typeof detail.price === "string" ? detail.price.trim() : null;
    const priceCents = parsePriceToCents(priceRaw);
    const price = priceCents != null ? Math.round(priceCents / 100) : null;

    return {
      ok: true,
      data: {
        price,
        priceRaw,
        codeFipe: typeof detail.codeFipe === "string" ? detail.codeFipe.trim() : null,
        referenceMonth:
          typeof detail.referenceMonth === "string" ? detail.referenceMonth.trim() : null,
        modelYear:
          typeof detail.modelYear === "number" && Number.isFinite(detail.modelYear)
            ? detail.modelYear
            : null,
        fuel: typeof detail.fuel === "string" ? detail.fuel.trim() : null,
        brandMatched: brandMatched.name,
        modelMatched: modelMatched.name,
        yearCodeMatched: yearMatched.code
      }
    };
  } catch (error) {
    const message = getFriendlyErrorMessage(error);
    return {
      ok: false,
      reason: message || "Falha ao consultar FIPE."
    };
  }
}
