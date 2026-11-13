import type { AuctionVehicle } from "../formatters/auction-card.js";
import type { MongoConfig } from "../integrations/mongo.js";
import type { ZApiConfig } from "../integrations/zapi.js";
import {
  finishLocalFallbackJob,
  touchLocalFallbackJob,
  type ClaimedLocalFallbackJob
} from "../integrations/local-scraping-fallback.js";
import { runAuctionSearch } from "./auction-search.js";

const TOUCH_INTERVAL_MS = 15_000;

/**
 * Executa no worker local (rede residencial) uma fonte que falhou no Docker.
 * Não ingere no Picareta: devolve os veículos pelo Mongo e o serviço cloud,
 * que acompanha o run, faz a ingestão com as credenciais dele.
 */
export async function runLocalFallbackJob(
  job: ClaimedLocalFallbackJob,
  options: {
    dataMongoConfig: MongoConfig;
    zApiConfig: ZApiConfig;
    headless: boolean;
    workerId: string;
    log: (message: string) => void;
  }
): Promise<void> {
  const { dataMongoConfig, workerId, log } = options;
  let message: string | null = `${job.label}: coleta iniciada no worker local.`;
  let found = 0;
  let vehicles: AuctionVehicle[] = [];
  let complete = false;
  let error: string | null = null;

  log(`${job.label} falhou no Docker (${job.cloudError || "sem detalhe"}). Coletando localmente (run ${job.runId})...`);
  const touch = () =>
    touchLocalFallbackJob(dataMongoConfig, job.id, workerId, { message, found }).catch((touchError: unknown) => {
      log(`Falha ao atualizar progresso: ${touchError instanceof Error ? touchError.message : String(touchError)}`);
    });
  await touch();
  const timer = setInterval(() => void touch(), TOUCH_INTERVAL_MS);

  try {
    const result = await runAuctionSearch({
      groupPhone: "__local_fallback__",
      dataMongoConfig,
      zApiConfig: { ...options.zApiConfig, enabled: false },
      headless: options.headless,
      sources: [job.source],
      onSourceProgress: (event) => {
        found = event.found;
        if (event.status === "error") error = event.error ?? error;
      },
      onSourceResult: async (sourceResult) => {
        vehicles = sourceResult.vehicles;
        complete = sourceResult.complete;
      },
      log: (line) => {
        log(line);
        message = line;
      }
    });
    if (!complete && !error) error = result.sourceFailures[0]?.reason ?? "coleta local incompleta";
  } catch (runError) {
    complete = false;
    error = runError instanceof Error ? runError.message : String(runError);
  } finally {
    clearInterval(timer);
  }

  const accepted = await finishLocalFallbackJob(dataMongoConfig, job.id, workerId, { vehicles, complete, error });
  if (!accepted) {
    log(`${job.label}: o serviço cloud já havia encerrado a espera; resultado local descartado.`);
    return;
  }
  log(
    complete
      ? `${job.label}: ${vehicles.length} veículo(s) devolvidos ao serviço cloud.`
      : `${job.label}: falhou também no worker local (${error}). ${vehicles.length} parcial(is) devolvido(s).`
  );
}
