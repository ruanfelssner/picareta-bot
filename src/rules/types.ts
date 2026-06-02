export type RelevanceLevel = "alta" | "media" | "baixa" | "descartar";

export type SemanticAssessment = {
  relevanceLevel: RelevanceLevel;
  relevanceScore: number;
  shouldOpenDetail: boolean;
  reason: string;
};

export type SemanticRuntime = {
  ruleName: string;
  requiredTokens: string[];
  excludeTokens: string[];
  cardRequiredAnyTokens?: string[];
  cardMinMatchedTokens?: number;
  assess: (text: string, matchedTokensCount: number) => SemanticAssessment;
};

export type SemanticRuleFactory = {
  name: string;
  supports: (tokens: string[]) => boolean;
  create: (tokens: string[]) => SemanticRuntime;
};
