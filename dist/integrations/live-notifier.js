import { parsePriceToCents } from "../utils.js";
import { sendMediumResultsListToZApi, sendResultsToZApi } from "./zapi.js";
function buildInstructionFromHistory(item, previous) {
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
    if (currentPriceCents != null &&
        previousPriceCents != null &&
        currentPriceCents < previousPriceCents) {
        const priceDropCents = previousPriceCents - currentPriceCents;
        const priceDropPercent = previousPriceCents > 0 ? (priceDropCents / previousPriceCents) * 100 : null;
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
export function createLiveNotifier(config, historyByUrl) {
    const logs = [];
    const queuedUrls = new Set();
    const sentOrProcessedUrls = new Set();
    const pendingMediumInstructions = [];
    let queue = Promise.resolve();
    let queued = 0;
    let sent = 0;
    let skipped = 0;
    let failed = 0;
    let ignored = 0;
    const processItem = async (item) => {
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
    const enqueue = (item) => {
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
