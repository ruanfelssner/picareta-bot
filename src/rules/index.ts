import { genericRuleFactory } from "./generic-rule.js";
import { autoPartsRuleFactory } from "./auto-parts-rule.js";
import { wheelsRuleFactory } from "./wheels-rule.js";
import type { SemanticRuntime } from "./types.js";

const RULES = [wheelsRuleFactory, autoPartsRuleFactory, genericRuleFactory];

export function createSemanticRuntime(tokens: string[]): SemanticRuntime {
  for (const rule of RULES) {
    if (rule.supports(tokens)) {
      return rule.create(tokens);
    }
  }

  return genericRuleFactory.create(tokens);
}

export type { RelevanceLevel, SemanticAssessment, SemanticRuntime } from "./types.js";
