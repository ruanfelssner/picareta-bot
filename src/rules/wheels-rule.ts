import { normalizeSearchText } from "../utils.js";
import type { SemanticAssessment, SemanticRuleFactory, SemanticRuntime } from "./types.js";

type WheelsIntent = {
  wheelSize: number | null;
  boltPattern: string | null;
};

const COMMON_BOLT_PATTERNS = [
  "4x98",
  "4x100",
  "4x108",
  "4x114",
  "5x98",
  "5x100",
  "5x105",
  "5x108",
  "5x110",
  "5x112",
  "5x114",
  "5x120",
  "6x139"
];

function canonicalizeWheelTokens(tokens: string[]): string[] {
  const set = new Set(tokens);

  for (const token of tokens) {
    const aro = token.match(/^aro(1[3-9]|2[0-2])$/);
    if (aro && set.has(aro[1])) {
      set.delete(token);
    }
  }

  return [...set];
}

function buildCardDescriptorTokens(tokens: string[]): string[] {
  return tokens.filter((token) => {
    if (token === "roda" || token === "rodas") return false;
    if (/^[4-8]x\d{2,3}$/.test(token)) return false;
    if (/^aro(1[3-9]|2[0-2])$/.test(token)) return false;
    if (/^(1[3-9]|2[0-2])$/.test(token)) return false;
    return token.length >= 3;
  });
}

function parseWheelIntent(tokens: string[]): WheelsIntent {
  let wheelSize: number | null = null;
  let boltPattern: string | null = null;

  for (const token of tokens) {
    if (!boltPattern && /^[4-8]x\d{2,3}$/.test(token)) {
      boltPattern = token;
    }

    if (wheelSize == null) {
      const aro = token.match(/^aro(1[3-9]|2[0-2])$/);
      if (aro) {
        wheelSize = Number.parseInt(aro[1], 10);
        continue;
      }

      if (/^(1[3-9]|2[0-2])$/.test(token)) {
        wheelSize = Number.parseInt(token, 10);
      }
    }
  }

  return { wheelSize, boltPattern };
}

function buildWheelExcludes(tokens: string[], intent: WheelsIntent): string[] {
  const requiredSet = new Set(tokens);
  const excludes = new Set<string>();

  if (intent.boltPattern) {
    for (const candidate of COMMON_BOLT_PATTERNS) {
      if (candidate !== intent.boltPattern) {
        excludes.add(candidate);
      }
    }
  }

  if (intent.wheelSize != null) {
    for (let size = 13; size <= 22; size += 1) {
      if (size !== intent.wheelSize) {
        excludes.add(String(size));
        excludes.add(`aro${size}`);
      }
    }
  }

  return [...excludes].filter((token) => !requiredSet.has(token));
}

function extractSizeSignals(normalized: string): number[] {
  const values = new Set<number>();

  for (const match of normalized.matchAll(/\baro\s*(1[3-9]|2[0-2])\b/g)) {
    values.add(Number.parseInt(match[1], 10));
  }

  for (const match of normalized.matchAll(/\baro(1[3-9]|2[0-2])\b/g)) {
    values.add(Number.parseInt(match[1], 10));
  }

  for (const match of normalized.matchAll(/\b(1[3-9]|2[0-2])x\d{1,2}\b/g)) {
    values.add(Number.parseInt(match[1], 10));
  }

  for (const token of normalized.split(/\s+/)) {
    if (/^(1[3-9]|2[0-2])$/.test(token)) {
      values.add(Number.parseInt(token, 10));
    }
  }

  return [...values].sort((a, b) => a - b);
}

function extractBoltSignals(normalized: string): string[] {
  const values = new Set<string>();
  for (const match of normalized.matchAll(/\b([4-8]x\d{2,3})\b/g)) {
    values.add(match[1]);
  }
  return [...values].sort();
}

function extractBoltHoleSignals(normalized: string): number[] {
  const values = new Set<number>();

  for (const match of normalized.matchAll(/\b([4-8])\s*furos?\b/g)) {
    values.add(Number.parseInt(match[1], 10));
  }

  for (const match of normalized.matchAll(/\bfurac(?:ao|a[oõ])\s*([4-8])\b/g)) {
    values.add(Number.parseInt(match[1], 10));
  }

  return [...values].sort((a, b) => a - b);
}

function assessWheels(
  text: string,
  matchedTokensCount: number,
  intent: WheelsIntent,
  hasExcludedTokens: boolean
): SemanticAssessment {
  if (hasExcludedTokens) {
    return {
      relevanceLevel: "descartar",
      relevanceScore: 0,
      shouldOpenDetail: false,
      reason: "Contém termo excluído"
    };
  }

  const normalized = normalizeSearchText(text);
  const sizeValues = extractSizeSignals(normalized);
  const boltValues = extractBoltSignals(normalized);
  const boltHoleValues = extractBoltHoleSignals(normalized);
  const targetHoleCount = intent.boltPattern ? Number.parseInt(intent.boltPattern.split("x")[0], 10) : null;

  const hasSizeInfo = sizeValues.length > 0;
  const hasBoltInfo = boltValues.length > 0;
  const hasBoltHoleInfo = boltHoleValues.length > 0;

  const hasTargetSize = intent.wheelSize != null ? sizeValues.includes(intent.wheelSize) : false;
  const hasTargetBolt = intent.boltPattern != null ? boltValues.includes(intent.boltPattern) : false;
  const hasTargetBoltHoles = targetHoleCount != null ? boltHoleValues.includes(targetHoleCount) : false;

  const hasConflictingSize =
    intent.wheelSize != null && hasSizeInfo && sizeValues.some((value) => value !== intent.wheelSize);
  const hasConflictingBolt =
    intent.boltPattern != null &&
    hasBoltInfo &&
    boltValues.some((value) => value !== intent.boltPattern);
  const hasConflictingBoltHoles =
    targetHoleCount != null &&
    hasBoltHoleInfo &&
    boltHoleValues.some((value) => value !== targetHoleCount);

  if (hasConflictingSize || hasConflictingBolt || hasConflictingBoltHoles) {
    return {
      relevanceLevel: "descartar",
      relevanceScore: 0,
      shouldOpenDetail: false,
      reason: "Conflito de aro/furação"
    };
  }

  const expectsSize = intent.wheelSize != null;
  const expectsBolt = intent.boltPattern != null;

  if (expectsSize && expectsBolt) {
    if (hasTargetSize && hasTargetBolt) {
      return {
        relevanceLevel: "alta",
        relevanceScore: 1,
        shouldOpenDetail: false,
        reason: "Aro e furação casaram no card"
      };
    }

    if (hasTargetSize && hasTargetBoltHoles) {
      return {
        relevanceLevel: "media",
        relevanceScore: 0.78,
        shouldOpenDetail: true,
        reason: "Aro confere e furação parcial (furos)"
      };
    }

    if (hasTargetSize || hasTargetBolt) {
      return {
        relevanceLevel: "media",
        relevanceScore: 0.72,
        shouldOpenDetail: true,
        reason: "Match parcial de aro/furação"
      };
    }

    return {
      relevanceLevel: "baixa",
      relevanceScore: matchedTokensCount > 0 ? 0.45 : 0.2,
      shouldOpenDetail: matchedTokensCount > 0,
      reason: "Sem aro/furação explícitos no card"
    };
  }

  if (expectsSize) {
    if (hasTargetSize) {
      return {
        relevanceLevel: "alta",
        relevanceScore: 1,
        shouldOpenDetail: false,
        reason: "Aro casou no card"
      };
    }

    return {
      relevanceLevel: "baixa",
      relevanceScore: matchedTokensCount > 0 ? 0.45 : 0.2,
      shouldOpenDetail: matchedTokensCount > 0,
      reason: "Aro não explícito no card"
    };
  }

  if (expectsBolt) {
    if (hasTargetBolt) {
      return {
        relevanceLevel: "alta",
        relevanceScore: 1,
        shouldOpenDetail: false,
        reason: "Furação casou no card"
      };
    }

    return {
      relevanceLevel: "baixa",
      relevanceScore: matchedTokensCount > 0 ? 0.45 : 0.2,
      shouldOpenDetail: matchedTokensCount > 0,
      reason: "Furação não explícita no card"
    };
  }

  return {
    relevanceLevel: matchedTokensCount > 0 ? "media" : "baixa",
    relevanceScore: matchedTokensCount > 0 ? 0.65 : 0.2,
    shouldOpenDetail: matchedTokensCount > 0,
    reason: "Busca geral de rodas"
  };
}

export const wheelsRuleFactory: SemanticRuleFactory = {
  name: "wheels",
  supports: (tokens) => {
    const hasBolt = tokens.some((token) => /^[4-8]x\d{2,3}$/.test(token));
    const hasAroPrefixed = tokens.some((token) => /^aro(1[3-9]|2[0-2])$/.test(token));
    const hasWheelKeyword = tokens.some((token) => token === "roda" || token === "rodas");
    const hasSizeNumber = tokens.some((token) => /^(1[3-9]|2[0-2])$/.test(token));

    return hasBolt || hasAroPrefixed || (hasWheelKeyword && hasSizeNumber);
  },
  create: (tokens): SemanticRuntime => {
    const requiredTokens = canonicalizeWheelTokens(tokens);
    const intent = parseWheelIntent(requiredTokens);
    const cardDescriptorTokens = buildCardDescriptorTokens(requiredTokens);
    const excludeTokens = buildWheelExcludes(requiredTokens, intent);
    const excludeSet = new Set(excludeTokens);

    return {
      ruleName: "wheels",
      requiredTokens,
      excludeTokens,
      cardRequiredAnyTokens: cardDescriptorTokens.length > 0 ? cardDescriptorTokens : undefined,
      cardMinMatchedTokens: cardDescriptorTokens.length > 0 ? 1 : undefined,
      assess: (text, matchedTokensCount) => {
        const normalized = normalizeSearchText(text);
        const textTokens = new Set(normalized.split(/\s+/).filter(Boolean));
        const hasExcludedTokens = [...excludeSet].some((token) => textTokens.has(token));
        return assessWheels(text, matchedTokensCount, intent, hasExcludedTokens);
      }
    };
  }
};
