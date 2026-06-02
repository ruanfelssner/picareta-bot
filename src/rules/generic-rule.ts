import type { SemanticAssessment, SemanticRuleFactory, SemanticRuntime } from "./types.js";

function assessGeneric(
  requiredTokens: string[],
  matchedTokensCount: number,
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

  const totalRequired = requiredTokens.length;
  if (totalRequired > 0 && matchedTokensCount >= totalRequired) {
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

export const genericRuleFactory: SemanticRuleFactory = {
  name: "generic",
  supports: () => true,
  create: (tokens): SemanticRuntime => {
    const requiredTokens = [...tokens];
    const excludeTokens: string[] = [];

    return {
      ruleName: "generic",
      requiredTokens,
      excludeTokens,
      assess: (_text, matchedTokensCount) =>
        assessGeneric(requiredTokens, matchedTokensCount, false)
    };
  }
};
