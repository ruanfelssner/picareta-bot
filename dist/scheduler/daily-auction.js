import cron from "node-cron";
import { runAuctionSearch } from "../commands/auction-search.js";
export function startDailyAuctionScheduler(options) {
    const log = options.log ?? console.log;
    const schedule = options.schedule || "0 7 * * *";
    log(`[scheduler] Cron de leilão configurado: "${schedule}" (America/Sao_Paulo)`);
    const task = cron.schedule(schedule, async () => {
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
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            log(`[scheduler] Erro na busca diária: ${message}`);
        }
    }, {
        timezone: "America/Sao_Paulo"
    });
    return task;
}
export function parseCronSchedule(env) {
    const schedule = (env.AUCTION_CRON_SCHEDULE ?? "").trim();
    if (schedule && cron.validate(schedule)) {
        return schedule;
    }
    return "0 7 * * *";
}
export function parseAuctionGroupPhone(env, defaultPhone) {
    const phone = (env.AUCTION_GROUP_PHONE ?? "").trim();
    return phone || defaultPhone;
}
