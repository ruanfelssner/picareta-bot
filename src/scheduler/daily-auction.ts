import cron, { type ScheduledTask } from "node-cron";
import type { MongoConfig } from "../integrations/mongo.js";
import type { ZApiConfig } from "../integrations/zapi.js";
import { runAuctionSearch } from "../commands/auction-search.js";

export type DailyAuctionSchedulerOptions = {
  schedule: string;
  groupPhone: string;
  dataMongoConfig: MongoConfig;
  zApiConfig: ZApiConfig;
  headless?: boolean;
  log?: (msg: string) => void;
};

export function startDailyAuctionScheduler(options: DailyAuctionSchedulerOptions): ScheduledTask {
  const log = options.log ?? console.log;
  const schedule = options.schedule || "0 7 * * *";

  log(`[scheduler] Cron de leilão configurado: "${schedule}" (America/Sao_Paulo)`);

  const task = cron.schedule(
    schedule,
    async () => {
      log("[scheduler] Iniciando busca diária de leilões...");
      try {
        const result = await runAuctionSearch({
          groupPhone: options.groupPhone,
          dataMongoConfig: options.dataMongoConfig,
          zApiConfig: options.zApiConfig,
          headless: options.headless ?? true,
          log
        });
        log(`[scheduler] Busca diária concluída: ${result.total} veículo(s).`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`[scheduler] Erro na busca diária: ${message}`);
      }
    },
    {
      timezone: "America/Sao_Paulo"
    }
  );

  return task;
}

export function parseCronSchedule(env: NodeJS.ProcessEnv): string {
  const schedule = (env.AUCTION_CRON_SCHEDULE ?? "").trim();
  if (schedule && cron.validate(schedule)) {
    return schedule;
  }
  return "0 7 * * *";
}

export function parseAuctionGroupPhone(env: NodeJS.ProcessEnv, defaultPhone: string): string {
  const phone = (env.AUCTION_GROUP_PHONE ?? "").trim();
  return phone || defaultPhone;
}
