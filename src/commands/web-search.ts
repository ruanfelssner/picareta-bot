import type { MongoConfig } from "../integrations/mongo.js";
import {
  openWebSearchSession,
  type ClaimedWebSearch
} from "../integrations/marketplace-web-search.js";
import { getZApiConfigFromEnv } from "../integrations/zapi.js";
import { executeSearchRun } from "../search-runner.js";
import type { MarketplaceSearchConfig } from "../facebook-marketplace.js";
import {
  MARKETPLACE_ITEM_CONDITION_PARAM,
  type MarketplaceSearchOptions
} from "../../shared/utils/marketplace-search-options.js";

export type RunWebSearchOptions = {
  maxScrolls: number;
  headless: boolean;
  profilePath: string;
  outputPath: string;
  dataMongoConfig: MongoConfig;
  log: (message: string) => void;
};

/** Converte as opções gravadas no job em overrides da URL de busca; campos ausentes mantêm o padrão do bot. */
export function toSearchConfigOverride(options: MarketplaceSearchOptions | null): MarketplaceSearchConfig | null {
  if (!options) return null;
  const config: MarketplaceSearchConfig = {};
  if (options.locationId) config.locationId = options.locationId;
  if (options.radiusKm != null) config.radiusKm = options.radiusKm;
  if (options.minPrice != null) config.minPrice = options.minPrice;
  if (options.maxPrice != null) config.maxPrice = options.maxPrice;
  if (options.condition) config.itemCondition = MARKETPLACE_ITEM_CONDITION_PARAM[options.condition];
  return Object.keys(config).length > 0 ? config : null;
}

function isCancellationError(message: string): boolean {
  return /cancelad[ao]/i.test(message);
}

/**
 * Executa uma busca pedida pela tela web: os termos rodam em sequência no mesmo perfil do Playwright
 * e cada prévia/lista final é gravada no documento da busca para a tela acompanhar por polling.
 * Não publica no WhatsApp.
 */
export async function runWebSearchJob(job: ClaimedWebSearch, options: RunWebSearchOptions): Promise<void> {
  const session = await openWebSearchSession(options.dataMongoConfig, job.id);
  const logger = options.log;
  const searchConfigOverride = toSearchConfigOverride(job.options);

  try {
    session.log(`Worker iniciou a busca (${job.terms.length} termo(s)).`);

    const archivedUrls = await session.loadArchivedUrls().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      session.log(`Arquivados: falha ao carregar (${message}). Buscando sem filtro.`);
      return new Set<string>();
    });
    if (archivedUrls.size > 0) {
      session.log(`Arquivados: ${archivedUrls.size} anúncio(s) serão ignorados.`);
    }

    let cancelled = false;
    let succeeded = 0;
    let lastError: string | null = null;

    for (const [index, term] of job.terms.entries()) {
      if (await session.isCancelRequested()) {
        cancelled = true;
        break;
      }

      await session.startTerm(index);
      logger(`Termo ${index + 1}/${job.terms.length}: "${term}"`);

      try {
        const run = await executeSearchRun({
          searchTerm: term,
          maxScrolls: options.maxScrolls,
          headless: options.headless,
          profilePath: options.profilePath,
          outputPath: options.outputPath,
          mongoConfig: options.dataMongoConfig,
          zApiConfig: { ...getZApiConfigFromEnv(), enabled: false },
          shouldCancel: () => session.isCancelRequested(),
          log: (message) => {
            session.log(message, term);
            logger(`[${term}] ${message}`);
          },
          onPreliminaryResult: (item) => session.preview(term, item),
          excludeUrls: archivedUrls,
          searchConfigOverride
        });

        if (await session.isCancelRequested()) {
          await session.failTerm(index, "CANCELLED", "Busca cancelada.");
          cancelled = true;
          break;
        }

        await session.finishTerm(index, term, run.results);
        session.log(`Busca finalizada: ${run.results.length} resultado(s).`, term);
        succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isCancellationError(message)) {
          await session.failTerm(index, "CANCELLED", message);
          cancelled = true;
          break;
        }

        // Falha em um termo não impede os próximos.
        lastError = message;
        await session.failTerm(index, "FAILED", message);
        session.log(`Falha: ${message}`, term);
        logger(`[${term}] falha: ${message}`);
      }
    }

    if (cancelled) {
      await session.cancelPendingTerms();
      await session.finish("CANCELLED");
      logger("Busca web cancelada.");
      return;
    }

    if (succeeded === 0 && lastError) {
      await session.finish("FAILED", lastError);
      logger(`Busca web falhou: ${lastError}`);
      return;
    }

    await session.finish("DONE");
    logger(`Busca web concluída (${succeeded}/${job.terms.length} termo(s)).`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await session.finish("FAILED", message).catch(() => undefined);
    logger(`Busca web com falha: ${message}`);
  } finally {
    await session.close().catch(() => undefined);
  }
}
