import {
  runMarketplaceSearch,
  type MarketplaceResult,
  type MarketplaceSearchConfig,
  type TermMatchConfig
} from "./facebook-marketplace.js";
import {
  type MongoConfig,
  loadLatestSentStateByDestination,
  persistRunToMongo,
  persistZApiDispatchesToMongo
} from "./integrations/mongo.js";
import { createLiveNotifier } from "./integrations/live-notifier.js";
import { type ZApiConfig, type ZApiDispatchLog } from "./integrations/zapi.js";
import { createSemanticRuntime } from "./rules/index.js";
import { tokenizeSearchTerm } from "./utils.js";

export const DEFAULT_SEARCH_CONFIG: MarketplaceSearchConfig = {
  locationId: "113048332042619"
};

export const DEFAULT_MATCH_BEHAVIOR = {
  requireTermMatch: true,
  enrichItemDetails: true,
  maxDetailPages: 20,
  minMatchedTokensForDetailOpen: 1,
  requireAllTokens: true,
  minRequiredRatio: 1,
  maxFallbackResults: 15
};

export type ExecuteSearchRunInput = {
  searchTerm: string;
  maxScrolls: number;
  headless: boolean;
  profilePath: string;
  outputPath: string;
  mongoConfig: MongoConfig;
  zApiConfig: ZApiConfig;
  zApiPhoneOverride?: string | null;
  shouldCancel?: () => boolean | Promise<boolean>;
  log?: (message: string) => void;
};

export type ExecuteSearchRunResult = {
  results: MarketplaceResult[];
  collectedCandidates: MarketplaceResult[];
  runId: string | null;
  semanticRuleName: string;
  conditionMode: "ambos" | "novo" | "usado";
  effectiveSearchTerm: string;
  dispatchLogs: ZApiDispatchLog[];
  dispatchStats: {
    queued: number;
    sent: number;
    skipped: number;
    failed: number;
    ignored: number;
  } | null;
};

type ParsedConditionDirective = {
  conditionMode: "ambos" | "novo" | "usado";
  effectiveSearchTerm: string;
  itemConditionOverride?: string;
};

function parseConditionDirective(searchTerm: string): ParsedConditionDirective {
  const rawTokens = searchTerm
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);

  const normalizeToken = (value: string) =>
    value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();

  const newMarkers = new Set(["novo", "nova", "novos", "novas"]);
  const usedMarkers = new Set([
    "usado",
    "usada",
    "usados",
    "usadas",
    "seminovo",
    "seminova",
    "seminovos",
    "seminovas",
    "semi-novo",
    "semi-nova",
    "semi-novos",
    "semi-novas"
  ]);

  let hasNew = false;
  let hasUsed = false;
  const effectiveTokens: string[] = [];

  for (let index = 0; index < rawTokens.length; index += 1) {
    const token = rawTokens[index];
    const normalized = normalizeToken(token);

    const nextToken = rawTokens[index + 1];
    const normalizedNext = nextToken ? normalizeToken(nextToken) : "";
    const isSemiNovoPair =
      normalized === "semi" &&
      ["novo", "nova", "novos", "novas"].includes(normalizedNext);
    if (isSemiNovoPair) {
      hasUsed = true;
      index += 1;
      continue;
    }

    if (newMarkers.has(normalized)) {
      hasNew = true;
      continue;
    }
    if (usedMarkers.has(normalized)) {
      hasUsed = true;
      continue;
    }
    effectiveTokens.push(token);
  }

  const effectiveSearchTerm = effectiveTokens.join(" ").trim() || searchTerm.trim();

  if (hasNew && !hasUsed) {
    return {
      conditionMode: "novo",
      effectiveSearchTerm,
      itemConditionOverride: "new"
    };
  }

  if (hasUsed && !hasNew) {
    return {
      conditionMode: "usado",
      effectiveSearchTerm,
      itemConditionOverride: "used_like_new,used_good,used_fair"
    };
  }

  return {
    conditionMode: "ambos",
    effectiveSearchTerm
  };
}

function resolveZApiConfig(baseConfig: ZApiConfig, destinationOverride?: string | null): ZApiConfig {
  const destination = destinationOverride?.trim() || baseConfig.phone;
  const hasCredentials = Boolean(
    baseConfig.instanceId && baseConfig.token && baseConfig.clientToken && destination
  );

  return {
    ...baseConfig,
    phone: destination,
    enabled: baseConfig.enabled && hasCredentials
  };
}

export async function executeSearchRun(input: ExecuteSearchRunInput): Promise<ExecuteSearchRunResult> {
  const logger = input.log ?? (() => undefined);
  const zApiConfig = resolveZApiConfig(input.zApiConfig, input.zApiPhoneOverride);
  const conditionDirective = parseConditionDirective(input.searchTerm);
  const searchTerm = conditionDirective.effectiveSearchTerm;
  const searchConfig: MarketplaceSearchConfig = conditionDirective.itemConditionOverride
    ? {
        ...DEFAULT_SEARCH_CONFIG,
        itemCondition: conditionDirective.itemConditionOverride
      }
    : DEFAULT_SEARCH_CONFIG;

  const baseTokens = tokenizeSearchTerm(searchTerm);
  const semanticRuntime = createSemanticRuntime(baseTokens);

  const matchConfig: TermMatchConfig = {
    requiredTokens: semanticRuntime.requiredTokens,
    excludeTokens: semanticRuntime.excludeTokens,
    minRequiredRatio: DEFAULT_MATCH_BEHAVIOR.minRequiredRatio,
    requireAll: DEFAULT_MATCH_BEHAVIOR.requireAllTokens
  };

  logger(`Termo buscado: ${searchTerm}`);
  if (conditionDirective.conditionMode !== "ambos") {
    logger(`Condição filtrada: ${conditionDirective.conditionMode}.`);
  } else {
    logger("Condição filtrada: ambos (novo + usado).");
  }
  logger(`Scrolls configurados: ${input.maxScrolls}`);
  logger(`Modo headless: ${input.headless ? "true" : "false"}`);
  logger(`Perfil persistente: ${input.profilePath}`);
  logger(`Regra semântica: ${semanticRuntime.ruleName}`);
  logger(`MongoDB: ${input.mongoConfig.enabled ? "habilitado" : "desabilitado"}`);
  logger(`Z-API: ${zApiConfig.enabled ? "habilitada" : "desabilitada"}`);

  let runId: string | null = null;
  let dispatchLogs: ZApiDispatchLog[] = [];
  let dispatchStats: ExecuteSearchRunResult["dispatchStats"] = null;
  let collectedCandidates: MarketplaceResult[] = [];

  let liveNotifier: ReturnType<typeof createLiveNotifier> | null = null;
  if (zApiConfig.enabled) {
    try {
      const historyByUrl = await loadLatestSentStateByDestination(input.mongoConfig, zApiConfig.phone);
      liveNotifier = createLiveNotifier(zApiConfig, historyByUrl);
      logger(
        `Notificação em fila: ativa (histórico carregado de ${historyByUrl.size} anúncio(s) já enviados).`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(
        `Notificação em fila: falha ao carregar histórico (${message}). Continuando sem histórico anterior.`
      );
      liveNotifier = createLiveNotifier(zApiConfig, new Map());
    }
  }

  const results = await runMarketplaceSearch({
    searchTerm,
    maxScrolls: input.maxScrolls,
    headless: input.headless,
    profilePath: input.profilePath,
    requireTermMatch: DEFAULT_MATCH_BEHAVIOR.requireTermMatch,
    enrichItemDetails: DEFAULT_MATCH_BEHAVIOR.enrichItemDetails,
    maxDetailPages: DEFAULT_MATCH_BEHAVIOR.maxDetailPages,
    minMatchedTokensForDetailOpen: DEFAULT_MATCH_BEHAVIOR.minMatchedTokensForDetailOpen,
    maxFallbackResults: DEFAULT_MATCH_BEHAVIOR.maxFallbackResults,
    searchConfig,
    matchConfig,
    semanticRuntime,
    shouldCancel: input.shouldCancel,
    onCollectionComplete: (items) => {
      collectedCandidates = items;
    },
    onUniqueResult: (item) => {
      if (!liveNotifier) return;
      if (item.relevanceLevel === "descartar" || !item.matchApproved) return;
      liveNotifier.enqueue(item);
    }
  });

  const collectedAt = new Date().toISOString();

  if (input.mongoConfig.enabled) {
    try {
      const persistResult = await persistRunToMongo(input.mongoConfig, {
        searchTerm,
        collectedAt,
        outputPath: input.outputPath,
        total: results.length,
        semanticRuleName: semanticRuntime.ruleName,
        results
      });
      runId = persistResult.runId;
      logger(
        `Mongo: execução salva (runId=${persistResult.runId ?? "-"}) e ${persistResult.upsertedListings} anúncio(s) atualizados/inseridos.`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Mongo: falha ao persistir execução (${message}).`);
    }
  }

  if (zApiConfig.enabled && liveNotifier) {
    try {
      for (const item of results) {
        liveNotifier.enqueue(item);
      }

      await liveNotifier.flush();
      dispatchLogs = liveNotifier.getLogs();
      dispatchStats = liveNotifier.getStats();
      logger(
        `Z-API fila: enfileirados ${dispatchStats.queued}, enviados ${dispatchStats.sent}, pulados ${dispatchStats.skipped}, falhas ${dispatchStats.failed}, ignorados ${dispatchStats.ignored}.`
      );

      const firstError = dispatchLogs.find((log) => log.status === "error");
      if (firstError?.reason) {
        logger(`Z-API: primeiro erro -> ${firstError.reason}`);
      }

      if (input.mongoConfig.enabled && dispatchLogs.length > 0) {
        try {
          await persistZApiDispatchesToMongo(input.mongoConfig, {
            runId,
            searchTerm,
            logs: dispatchLogs
          });
          logger("Mongo: logs de envio Z-API salvos.");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger(`Mongo: falha ao salvar logs da Z-API (${message}).`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger(`Z-API: falha ao enviar mensagens (${message}).`);
    }
  }

  return {
    results,
    collectedCandidates,
    runId,
    semanticRuleName: semanticRuntime.ruleName,
    conditionMode: conditionDirective.conditionMode,
    effectiveSearchTerm: searchTerm,
    dispatchLogs,
    dispatchStats
  };
}
