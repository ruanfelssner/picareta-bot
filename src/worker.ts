import dotenv from "dotenv";
import { hostname } from "node:os";
import {
  claimNextAnyPendingCommand,
  getMongoDataConfigFromEnv,
  getMongoQueueConfigFromEnv,
  isMarketplaceCommandCancelRequested,
  markMarketplaceCommandCancelled,
  markMarketplaceCommandDone,
  markMarketplaceCommandFailed,
  touchMarketplaceWorkerHeartbeat
} from "./integrations/mongo.js";
import { getZApiConfigFromEnv, sendTextMessageToZApi } from "./integrations/zapi.js";
import { executeSearchRun } from "./search-runner.js";
import { parseBoolean, parsePositiveInt, sleep } from "./utils.js";
import { runAuctionSearch } from "./commands/auction-search.js";
import { handleConfigUpdate } from "./commands/config-update.js";
import { handleContactSearch } from "./commands/contact-search.js";
import { handleContactInsert } from "./commands/contact-insert.js";
import { handleFipeLookup } from "./commands/fipe-lookup.js";
import {
  parseCronSchedule,
  parseAuctionGroupPhone,
  startDailyAuctionScheduler
} from "./scheduler/daily-auction.js";

dotenv.config();

const DEFAULT_POLL_SECONDS = 8;
const DEFAULT_HEARTBEAT_SECONDS = 20;
const CANCEL_CHECK_INTERVAL_MS = 5_000;
const MONGO_ERROR_BACKOFF_MS = 15_000;

function buildPrefixedLogger(prefix: string) {
  return (message: string) => {
    console.log(`${prefix} ${message}`);
  };
}

function createCancelChecker(mongoUriEnabled: boolean, commandId: string) {
  let lastCheckAt = 0;
  let cached = false;

  return async (
    mongoConfig: ReturnType<typeof getMongoQueueConfigFromEnv>
  ): Promise<boolean> => {
    if (!mongoUriEnabled || cached) {
      return cached;
    }

    const now = Date.now();
    if (now - lastCheckAt < CANCEL_CHECK_INTERVAL_MS) {
      return cached;
    }

    lastCheckAt = now;
    cached = await isMarketplaceCommandCancelRequested(mongoConfig, commandId);
    return cached;
  };
}

async function notifyGroupText(
  zApiConfig: ReturnType<typeof getZApiConfigFromEnv>,
  groupPhone: string,
  message: string,
  logger: (message: string) => void
): Promise<void> {
  if (!zApiConfig.enabled) {
    return;
  }

  const sent = await sendTextMessageToZApi(zApiConfig, {
    phone: groupPhone,
    message
  });

  if (!sent.ok) {
    logger(`Z-API status: falha ao enviar mensagem de status (${sent.reason ?? "erro desconhecido"}).`);
  }
}

async function processSearchCommand(
  command: NonNullable<Awaited<ReturnType<typeof claimNextAnyPendingCommand>>>,
  options: ProcessCommandOptions,
  logger: (msg: string) => void
): Promise<void> {
  if (!command.commandArg) {
    await markMarketplaceCommandFailed(
      options.queueMongoConfig,
      command.id,
      "Comando SEARCH sem argumento.",
      { reason: "missing_command_arg" }
    );
    logger("Finalizado com falha: comando sem argumento.");
    return;
  }

  await notifyGroupText(
    options.zApiConfig,
    command.groupPhone,
    `🔎 Busca iniciada por "${command.commandArg}".`,
    logger
  );

  const shouldCancelWithCache = createCancelChecker(options.queueMongoConfig.enabled, command.id);
  const shouldCancel = async () => shouldCancelWithCache(options.queueMongoConfig);

  const startedAt = Date.now();
  const run = await executeSearchRun({
    searchTerm: command.commandArg,
    maxScrolls: options.maxScrolls,
    headless: options.headless,
    profilePath: options.profilePath,
    outputPath: options.outputPath,
    mongoConfig: options.dataMongoConfig,
    zApiConfig: options.zApiConfig,
    zApiPhoneOverride: command.groupPhone,
    shouldCancel,
    log: logger
  });

  if (await shouldCancel()) {
    await markMarketplaceCommandCancelled(options.queueMongoConfig, command.id, {
      searchTerm: command.commandArg,
      effectiveSearchTerm: run.effectiveSearchTerm,
      groupPhone: command.groupPhone,
      totalResults: run.results.length,
      runId: run.runId,
      durationMs: Date.now() - startedAt
    });
    logger("Execução cancelada após finalização da busca.");
    await notifyGroupText(
      options.zApiConfig,
      command.groupPhone,
      `⏹️ Busca cancelada para "${command.commandArg}".`,
      logger
    );
    return;
  }

  await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
    searchTerm: command.commandArg,
    effectiveSearchTerm: run.effectiveSearchTerm,
    conditionMode: run.conditionMode,
    groupPhone: command.groupPhone,
    totalResults: run.results.length,
    runId: run.runId,
    semanticRuleName: run.semanticRuleName,
    zApiDispatchStats: run.dispatchStats,
    zApiDispatchErrors: run.dispatchLogs.filter((item) => item.status === "error").length,
    durationMs: Date.now() - startedAt
  });

  logger(`Busca finalizada com sucesso. ${run.results.length} anúncio(s).`);
  await notifyGroupText(
    options.zApiConfig,
    command.groupPhone,
    `✅ Busca finalizada para "${run.effectiveSearchTerm}". ${run.results.length} anúncio(s) encontrados.`,
    logger
  );
}

async function processAuctionSearchCommand(
  command: NonNullable<Awaited<ReturnType<typeof claimNextAnyPendingCommand>>>,
  options: ProcessCommandOptions,
  logger: (msg: string) => void
): Promise<void> {
  const startedAt = Date.now();

  const result = await runAuctionSearch({
    groupPhone: command.groupPhone,
    dataMongoConfig: options.dataMongoConfig,
    zApiConfig: options.zApiConfig,
    headless: options.headless,
    log: logger
  });

  await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
    groupPhone: command.groupPhone,
    totalResults: result.total,
    bySource: result.bySource,
    sourceFailures: result.sourceFailures,
    durationMs: Date.now() - startedAt
  });

  logger(`Busca de leilão finalizada. ${result.total} veículo(s).`);
}

async function processFipeLookupCommand(
  command: NonNullable<Awaited<ReturnType<typeof claimNextAnyPendingCommand>>>,
  options: ProcessCommandOptions,
  logger: (msg: string) => void
): Promise<void> {
  if (!command.commandArg) {
    const msg = "❌ Informe a placa. Ex: */buscar-fipe ABC1234*";
    await notifyGroupText(options.zApiConfig, command.groupPhone, msg, logger);
    await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
      reason: "missing_plate"
    });
    return;
  }

  await handleFipeLookup(command.commandArg, command.groupPhone, options.zApiConfig, {
    headless: options.headless,
    log: logger
  });

  await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
    plate: command.commandArg
  });
  logger(`Consulta FIPE concluída: ${command.commandArg}`);
}

async function processContactSearchCommand(
  command: NonNullable<Awaited<ReturnType<typeof claimNextAnyPendingCommand>>>,
  options: ProcessCommandOptions,
  logger: (msg: string) => void
): Promise<void> {
  const message = await handleContactSearch(command.commandArg, options.dataMongoConfig);
  await notifyGroupText(options.zApiConfig, command.groupPhone, message, logger);
  await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
    category: command.commandArg
  });
  logger(`Busca de contatos concluída.`);
}

async function processContactInsertCommand(
  command: NonNullable<Awaited<ReturnType<typeof claimNextAnyPendingCommand>>>,
  options: ProcessCommandOptions,
  logger: (msg: string) => void
): Promise<void> {
  // senderPhone vem em metadata se disponível
  const senderPhone = (command as { senderPhone?: string }).senderPhone ?? command.groupPhone;

  const result = await handleContactInsert(
    command.commandArg,
    senderPhone,
    options.dataMongoConfig
  );

  await notifyGroupText(options.zApiConfig, command.groupPhone, result.message, logger);
  await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
    ok: result.ok,
    showTemplate: result.showTemplate
  });
  logger(`Inserção de contato concluída.`);
}

async function processConfigUpdateCommand(
  command: NonNullable<Awaited<ReturnType<typeof claimNextAnyPendingCommand>>>,
  options: ProcessCommandOptions,
  logger: (msg: string) => void
): Promise<void> {
  const result = await handleConfigUpdate(command.commandArg, options.dataMongoConfig);
  await notifyGroupText(options.zApiConfig, command.groupPhone, result.message, logger);
  await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
    ok: result.ok,
    arg: command.commandArg
  });
  logger(`Atualização de configuração concluída.`);
}

type ProcessCommandOptions = {
  maxScrolls: number;
  headless: boolean;
  profilePath: string;
  outputPath: string;
  queueMongoConfig: ReturnType<typeof getMongoQueueConfigFromEnv>;
  dataMongoConfig: ReturnType<typeof getMongoDataConfigFromEnv>;
  zApiConfig: ReturnType<typeof getZApiConfigFromEnv>;
  workerId: string;
  setHeartbeatState: (input: {
    status: "IDLE" | "RUNNING";
    commandId?: string | null;
    groupPhone?: string | null;
    searchTerm?: string | null;
    commandCreatedAt?: Date | null;
    immediate?: boolean;
  }) => Promise<void>;
};

async function processOneCommand(
  command: Awaited<ReturnType<typeof claimNextAnyPendingCommand>>,
  options: ProcessCommandOptions
): Promise<void> {
  if (!command) {
    return;
  }

  const prefix = `[cmd ${command.id}]`;
  const logger = buildPrefixedLogger(prefix);
  logger(`Comando capturado: ${command.commandType} "${command.commandArg ?? ""}" para ${command.groupPhone}.`);

  await options.setHeartbeatState({
    status: "RUNNING",
    commandId: command.id,
    groupPhone: command.groupPhone,
    searchTerm: command.commandArg ?? null,
    commandCreatedAt: command.createdAt,
    immediate: true
  });

  try {
    switch (command.commandType) {
      case "SEARCH":
        await processSearchCommand(command, options, logger);
        break;

      case "AUCTION_SEARCH":
        await processAuctionSearchCommand(command, options, logger);
        break;

      case "FIPE_LOOKUP":
        await processFipeLookupCommand(command, options, logger);
        break;

      case "CONTACT_SEARCH":
        await processContactSearchCommand(command, options, logger);
        break;

      case "CONTACT_INSERT":
        await processContactInsertCommand(command, options, logger);
        break;

      case "CONFIG_UPDATE":
        await processConfigUpdateCommand(command, options, logger);
        break;

      case "STOP":
      case "DETAILS":
        await markMarketplaceCommandDone(options.queueMongoConfig, command.id, {
          reason: "noop"
        });
        break;

      default:
        logger(`Tipo de comando desconhecido: ${command.commandType}`);
        await markMarketplaceCommandFailed(
          options.queueMongoConfig,
          command.id,
          `Tipo de comando não suportado: ${command.commandType}`
        );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isCancelled = /cancelad[ao]/i.test(message);

    if (isCancelled) {
      await markMarketplaceCommandCancelled(options.queueMongoConfig, command.id, {
        groupPhone: command.groupPhone,
        reason: message
      });
      logger("Execução cancelada.");
      await notifyGroupText(
        options.zApiConfig,
        command.groupPhone,
        `⏹️ Operação cancelada.`,
        logger
      );
    } else {
      await markMarketplaceCommandFailed(options.queueMongoConfig, command.id, message, {
        groupPhone: command.groupPhone
      });
      logger(`Execução com falha: ${message}`);
      await notifyGroupText(
        options.zApiConfig,
        command.groupPhone,
        `❌ Operação falhou: ${message.slice(0, 100)}`,
        logger
      );
    }
  } finally {
    await options.setHeartbeatState({
      status: "IDLE",
      commandId: null,
      groupPhone: null,
      searchTerm: null,
      commandCreatedAt: null,
      immediate: true
    });
  }
}

async function main(): Promise<void> {
  const maxScrolls = parsePositiveInt(process.env.MAX_SCROLLS, 4);
  const headless = parseBoolean(process.env.HEADLESS, false);
  const profilePath = process.env.PROFILE_PATH?.trim() || "./data/facebook-profile";
  const outputPath = process.env.OUTPUT_PATH?.trim() || "./output/results.json";
  const pollSeconds = parsePositiveInt(process.env.WORKER_POLL_SECONDS, DEFAULT_POLL_SECONDS);
  const heartbeatSeconds = parsePositiveInt(
    process.env.WORKER_HEARTBEAT_SECONDS,
    DEFAULT_HEARTBEAT_SECONDS
  );
  const pollMs = pollSeconds * 1000;
  const heartbeatMs = heartbeatSeconds * 1000;
  const workerId = (process.env.WORKER_ID ?? "").trim() || `bot-anuncios@${hostname()}`;

  const queueMongoConfig = getMongoQueueConfigFromEnv();
  const dataMongoConfig = getMongoDataConfigFromEnv();
  const zApiConfig = getZApiConfigFromEnv();

  if (!queueMongoConfig.enabled) {
    throw new Error(
      "Mongo da fila não configurado. Defina MONGO_QUEUE_URI (ou MONGO_URI) para o worker consumir comandos."
    );
  }

  const auctionCronSchedule = parseCronSchedule(process.env);
  const auctionGroupPhone = parseAuctionGroupPhone(process.env, zApiConfig.phone);

  console.log(`Worker iniciado. Poll: ${pollSeconds}s.`);
  console.log(`Heartbeat worker: ${heartbeatSeconds}s (id=${workerId}).`);
  console.log(`Mongo fila: ${queueMongoConfig.dbName}.`);
  console.log(`Mongo dados: ${dataMongoConfig.enabled ? dataMongoConfig.dbName : "desabilitado"}.`);
  console.log(`Playwright headless: ${headless ? "true" : "false"}.`);
  console.log(`Perfil persistente: ${profilePath}.`);
  console.log(`Z-API: ${zApiConfig.enabled ? "habilitada" : "desabilitada"}.`);
  console.log(`Cron leilão: "${auctionCronSchedule}" → grupo ${auctionGroupPhone || "(não configurado)"}.`);
  console.log("Aguardando comandos em marketplace_commands...");

  // Inicia cron diário de leilão
  const auctionTask = startDailyAuctionScheduler({
    schedule: auctionCronSchedule,
    groupPhone: auctionGroupPhone,
    dataMongoConfig,
    zApiConfig,
    headless,
    log: (msg) => console.log(msg)
  });

  let heartbeatState: {
    status: "IDLE" | "RUNNING";
    commandId: string | null;
    groupPhone: string | null;
    searchTerm: string | null;
    commandCreatedAt: Date | null;
  } = {
    status: "IDLE",
    commandId: null,
    groupPhone: null,
    searchTerm: null,
    commandCreatedAt: null
  };
  let lastHeartbeatAt = 0;

  const pushHeartbeat = async (force = false): Promise<void> => {
    if (!queueMongoConfig.enabled) {
      return;
    }

    const now = Date.now();
    if (!force && now - lastHeartbeatAt < heartbeatMs) {
      return;
    }

    lastHeartbeatAt = now;

    try {
      await touchMarketplaceWorkerHeartbeat(queueMongoConfig, {
        workerId,
        status: heartbeatState.status,
        commandId: heartbeatState.commandId,
        groupPhone: heartbeatState.groupPhone,
        searchTerm: heartbeatState.searchTerm,
        commandCreatedAt: heartbeatState.commandCreatedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Heartbeat: falha ao atualizar status do worker (${message}).`);
    }
  };

  const setHeartbeatState = async (input: {
    status: "IDLE" | "RUNNING";
    commandId?: string | null;
    groupPhone?: string | null;
    searchTerm?: string | null;
    commandCreatedAt?: Date | null;
    immediate?: boolean;
  }): Promise<void> => {
    heartbeatState = {
      status: input.status,
      commandId: input.commandId ?? null,
      groupPhone: input.groupPhone ?? null,
      searchTerm: input.searchTerm ?? null,
      commandCreatedAt: input.commandCreatedAt ?? null
    };
    await pushHeartbeat(Boolean(input.immediate));
  };

  await pushHeartbeat(true);
  const heartbeatTimer = setInterval(() => {
    void pushHeartbeat(false);
  }, heartbeatMs);

  let keepRunning = true;
  process.on("SIGINT", () => {
    keepRunning = false;
    auctionTask.stop();
    console.log("Sinal SIGINT recebido. Encerrando worker...");
  });
  process.on("SIGTERM", () => {
    keepRunning = false;
    auctionTask.stop();
    console.log("Sinal SIGTERM recebido. Encerrando worker...");
  });

  try {
    while (keepRunning) {
      try {
        await setHeartbeatState({ status: "IDLE", immediate: false });

        const command = await claimNextAnyPendingCommand(queueMongoConfig);
        if (!command) {
          await sleep(pollMs);
          continue;
        }

        await processOneCommand(command, {
          maxScrolls,
          headless,
          profilePath,
          outputPath,
          queueMongoConfig,
          dataMongoConfig,
          zApiConfig,
          workerId,
          setHeartbeatState
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const isMongoConnectivityError =
          /ETIMEDOUT|ECONNRESET|ECONNREFUSED|Mongo(Network|ServerSelection)|server selection/i.test(
            message
          );

        if (isMongoConnectivityError) {
          console.error(
            `Mongo indisponível temporariamente (${message}). Tentando novamente em ${Math.round(
              MONGO_ERROR_BACKOFF_MS / 1000
            )}s...`
          );
          await sleep(MONGO_ERROR_BACKOFF_MS);
          continue;
        }

        throw error;
      }
    }
  } finally {
    clearInterval(heartbeatTimer);
    auctionTask.stop();
    await setHeartbeatState({
      status: "IDLE",
      commandId: null,
      groupPhone: null,
      searchTerm: null,
      commandCreatedAt: null,
      immediate: true
    });
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Erro no worker: ${message}`);
  process.exitCode = 1;
});
