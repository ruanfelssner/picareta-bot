import type { MarketplaceResult } from "../facebook-marketplace.js";
import { parsePriceToCents } from "../utils.js";
import type { LatestSentState } from "./mongo.js";
import {
  sendMediumResultsListToZApi,
  sendResultsToZApi,
  type ZApiConfig,
  type ZApiDispatchLog,
  type ZApiSendInstruction
} from "./zapi.js";

export type LiveNotifier = {
  enqueue: (item: MarketplaceResult) => void;
  flush: () => Promise<void>;
  getLogs: () => ZApiDispatchLog[];
  getStats: () => {
    queued: number;
    sent: number;
    skipped: number;
    failed: number;
    ignored: number;
  };
};

function buildInstructionFromHistory(
  item: MarketplaceResult,
  previous: LatestSentState | undefined
): ZApiSendInstruction | null {
  if (!previous) {
    return {
      item,
      sendReason: "first_time",
      previousPriceRaw: null,
      previousPriceCents: null,
      priceDropCents: null,
      priceDropPercent: null
    };
  }

  const currentPriceCents = parsePriceToCents(item.priceRaw);
  const previousPriceCents = previous.latestPriceCents;

  if (
    currentPriceCents != null &&
    previousPriceCents != null &&
    currentPriceCents < previousPriceCents
  ) {
    const priceDropCents = previousPriceCents - currentPriceCents;
    const priceDropPercent =
      previousPriceCents > 0 ? (priceDropCents / previousPriceCents) * 100 : null;

    return {
      item,
      sendReason: "price_drop",
      previousPriceRaw: previous.latestPriceRaw,
      previousPriceCents,
      priceDropCents,
      priceDropPercent
    };
  }

  return null;
}

export function createLiveNotifier(
  config: ZApiConfig,
  historyByUrl: Map<string, LatestSentState>
): LiveNotifier {
  const logs: ZApiDispatchLog[] = [];
  const queuedUrls = new Set<string>();
  const sentOrProcessedUrls = new Set<string>();
  const pendingMediumInstructions: ZApiSendInstruction[] = [];
  let queue = Promise.resolve();

  let queued = 0;
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  let ignored = 0;

  const processItem = async (item: MarketplaceResult): Promise<void> => {
    if (sentOrProcessedUrls.has(item.url)) {
      ignored += 1;
      return;
    }

    const instruction = buildInstructionFromHistory(item, historyByUrl.get(item.url));
    if (!instruction) {
      sentOrProcessedUrls.add(item.url);
      skipped += 1;
      return;
    }

    if (item.relevanceLevel !== "alta") {
      pendingMediumInstructions.push(instruction);
      return;
    }

    const report = await sendResultsToZApi(config, [instruction]);
    logs.push(...report.logs);
    sent += report.sent;
    skipped += report.skipped;
    failed += report.failed;

    if (report.sent > 0) {
      const currentPriceCents = parsePriceToCents(item.priceRaw);
      historyByUrl.set(item.url, {
        latestPriceRaw: item.priceRaw ?? null,
        latestPriceCents: currentPriceCents,
        lastSentAt: new Date()
      });
      sentOrProcessedUrls.add(item.url);
    }
  };

  const enqueue = (item: MarketplaceResult): void => {
    if (queuedUrls.has(item.url) || sentOrProcessedUrls.has(item.url)) {
      ignored += 1;
      return;
    }

    queuedUrls.add(item.url);
    queued += 1;

    queue = queue
      .then(async () => {
        await processItem(item);
      })
      .catch((error) => {
        failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        logs.push({
          url: item.url,
          title: item.titleRaw,
          image: item.image,
          destination: config.phone,
          searchTerm: item.searchTerm,
          priceRaw: item.priceRaw,
          priceCents: parsePriceToCents(item.priceRaw),
          sendReason: null,
          collectedAt: item.collectedAt,
          status: "error",
          reason: message
        });
      });
  };

  return {
    enqueue,
    flush: async () => {
      await queue;

      if (pendingMediumInstructions.length === 0) {
        return;
      }

      const report = await sendMediumResultsListToZApi(config, pendingMediumInstructions);
      logs.push(...report.logs);
      sent += report.sent;
      skipped += report.skipped;
      failed += report.failed;

      if (report.sent > 0) {
        for (const instruction of pendingMediumInstructions) {
          const item = instruction.item;
          const currentPriceCents = parsePriceToCents(item.priceRaw);
          historyByUrl.set(item.url, {
            latestPriceRaw: item.priceRaw ?? null,
            latestPriceCents: currentPriceCents,
            lastSentAt: new Date()
          });
          sentOrProcessedUrls.add(item.url);
        }
      }
    },
    getLogs: () => logs,
    getStats: () => ({
      queued,
      sent,
      skipped,
      failed,
      ignored
    })
  };
}
