import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { chromium } from "playwright";
import { buildPlaywrightLaunchOptions } from "./playwright-launch.js";
import { extractLocationStateUf, evaluateTermMatch, extractLocation, extractPrice, extractTitle, isGenericMarketplaceTitle, isLikelyLoginScreen, looksLikeBlockingVerification, normalizeMarketplaceItemUrl, normalizeText, randomBetween, stripMarketplaceSuggestionSections, sleep } from "./utils.js";
const MARKETPLACE_URL = "https://www.facebook.com/marketplace";
const MARKETPLACE_CARD_SELECTOR = 'a[href*="/marketplace/item/"]';
function buildMatchInput(matchConfig) {
    return {
        requiredTokens: matchConfig.requiredTokens,
        excludeTokens: matchConfig.excludeTokens,
        minRequiredRatio: matchConfig.minRequiredRatio,
        requireAll: matchConfig.requireAll
    };
}
function applyMatchAndSemantic(result, matchConfig, semanticRuntime) {
    const matchInput = buildMatchInput(matchConfig);
    const mergedEvaluation = evaluateTermMatch(result.rawText, matchInput);
    const cardEvaluation = evaluateTermMatch(result.cardText, matchInput);
    const detailEvaluation = evaluateTermMatch(result.detailText ?? "", matchInput);
    result.cardMatchedTokens = cardEvaluation.matchedTokens;
    result.detailMatchedTokens = detailEvaluation.matchedTokens;
    result.matchedTokens = mergedEvaluation.matchedTokens;
    result.missingTokens = mergedEvaluation.missingTokens;
    result.excludedTokens = mergedEvaluation.excludedTokens;
    const cardWeight = 0.75;
    const detailWeight = 0.25;
    result.matchScore =
        cardEvaluation.matchScore * cardWeight + mergedEvaluation.matchScore * detailWeight;
    // Guardrail: detail text can enrich, but the card still needs to provide a minimal anchor.
    const hasCardAnchor = cardEvaluation.matchedTokens.length > 0;
    result.matchApproved = mergedEvaluation.keep && hasCardAnchor;
    const semantic = semanticRuntime.assess(result.rawText, mergedEvaluation.matchedTokens.length);
    result.relevanceLevel = semantic.relevanceLevel;
    result.relevanceScore = semantic.relevanceScore;
    result.shouldOpenDetail = semantic.shouldOpenDetail;
    result.semanticReason = semantic.reason;
    const locationUf = extractLocationStateUf(result.locationRaw);
    if (result.relevanceLevel === "alta" && locationUf) {
        if (locationUf === "RS") {
            result.relevanceLevel = "baixa";
            result.relevanceScore = Math.min(result.relevanceScore, 0.35);
            result.semanticReason = `${result.semanticReason} | Rebaixado por localização (RS)`;
        }
        else if (locationUf !== "PR") {
            result.relevanceLevel = "media";
            result.relevanceScore = Math.min(result.relevanceScore, 0.65);
            result.semanticReason = `${result.semanticReason} | Rebaixado por localização (${locationUf})`;
        }
    }
    const hasWeakTitle = isGenericMarketplaceTitle(result.titleRaw);
    const hasMissingPrice = !result.priceRaw || result.priceRaw.trim() === "" || result.priceRaw.trim() === "-";
    if (result.relevanceLevel !== "descartar" && (hasWeakTitle || hasMissingPrice)) {
        result.relevanceLevel = "baixa";
        result.relevanceScore = Math.min(result.relevanceScore, 0.35);
        const reasons = [];
        if (hasWeakTitle) {
            reasons.push("título genérico");
        }
        if (hasMissingPrice) {
            reasons.push("preço ausente");
        }
        result.semanticReason = `${result.semanticReason} | Rebaixado por ${reasons.join(" e ")}`;
    }
}
async function readPageText(page) {
    try {
        return await page.locator("body").innerText();
    }
    catch {
        return "";
    }
}
async function hasLoginInputs(page) {
    const emailCount = await page.locator('input[name="email"]').count();
    const passCount = await page.locator('input[name="pass"]').count();
    return emailCount > 0 && passCount > 0;
}
async function detectManualIntervention(page) {
    const [text, hasInputs] = await Promise.all([readPageText(page), hasLoginInputs(page)]);
    const url = page.url();
    if (looksLikeBlockingVerification(text)) {
        return true;
    }
    return isLikelyLoginScreen(url, text, hasInputs);
}
async function detectBlockingVerification(page) {
    const pageText = await readPageText(page);
    const currentUrl = page.url().toLowerCase();
    if (looksLikeBlockingVerification(pageText)) {
        return "Texto de verificação/bloqueio detectado na página.";
    }
    if (currentUrl.includes("checkpoint") || currentUrl.includes("two_step_verification")) {
        return "URL indica checkpoint/verificação.";
    }
    if (pageText.toLowerCase().includes("temporarily blocked")) {
        return "Conta temporariamente bloqueada detectada.";
    }
    return null;
}
async function waitForUserEnter() {
    const rl = createInterface({ input, output });
    try {
        await rl.question("Faça login/verificação manualmente na janela aberta. Depois pressione ENTER no terminal.");
    }
    finally {
        rl.close();
    }
}
async function countMarketplaceCards(page) {
    return page.locator(MARKETPLACE_CARD_SELECTOR).count();
}
async function readCardSnapshot(page) {
    const links = page.locator(MARKETPLACE_CARD_SELECTOR);
    const count = await links.count();
    if (count <= 0) {
        return { count: 0, lastHref: null };
    }
    const lastHref = (await links.nth(count - 1).getAttribute("href").catch(() => null)) ?? null;
    return { count, lastHref };
}
async function advanceMarketplaceFeed(page) {
    const before = await readCardSnapshot(page);
    const links = page.locator(MARKETPLACE_CARD_SELECTOR);
    const executeStep = async (strategy, action) => {
        await action();
        await sleep(randomBetween(900, 1_500));
        const after = await readCardSnapshot(page);
        const movedByCount = after.count > before.count;
        const movedByLastCard = Boolean(after.lastHref && before.lastHref && after.lastHref !== before.lastHref);
        if (movedByCount || movedByLastCard) {
            return {
                strategy,
                moved: true,
                beforeTop: 0,
                afterTop: 0,
                beforeMaxTop: 0,
                afterMaxTop: 0,
                beforeCount: before.count,
                afterCount: after.count
            };
        }
        return null;
    };
    const cardCount = await links.count();
    if (cardCount > 0) {
        const last = links.nth(cardCount - 1);
        const scrolledByCard = await executeStep("last-card-scroll", async () => {
            await last.scrollIntoViewIfNeeded().catch(() => undefined);
        });
        if (scrolledByCard) {
            return scrolledByCard;
        }
    }
    const wheelMove = await executeStep("mouse-wheel", async () => {
        await page.locator("body").first().click({ position: { x: 20, y: 20 }, timeout: 2_000 }).catch(() => undefined);
        await page.locator('div[role="main"]').first().hover({ timeout: 2_000 }).catch(() => undefined);
        await page.mouse.wheel(0, 2200);
    });
    if (wheelMove) {
        return wheelMove;
    }
    const pageDownMove = await executeStep("keyboard-page-down", async () => {
        await page.keyboard.press("PageDown").catch(() => undefined);
    });
    if (pageDownMove) {
        return pageDownMove;
    }
    const endMove = await executeStep("keyboard-end", async () => {
        await page.keyboard.press("End").catch(() => undefined);
    });
    if (endMove) {
        return endMove;
    }
    const finalSnapshot = await readCardSnapshot(page);
    return {
        strategy: "no-progress",
        moved: false,
        beforeTop: 0,
        afterTop: 0,
        beforeMaxTop: 0,
        afterMaxTop: 0,
        beforeCount: before.count,
        afterCount: finalSnapshot.count
    };
}
async function collectVisibleCards(page) {
    const links = page.locator(MARKETPLACE_CARD_SELECTOR);
    const count = await links.count();
    const items = [];
    for (let index = 0; index < count; index += 1) {
        const link = links.nth(index);
        const isVisible = await link.isVisible().catch(() => false);
        if (!isVisible) {
            continue;
        }
        const href = (await link.getAttribute("href")) ?? "";
        if (!href.includes("/marketplace/item/")) {
            continue;
        }
        const rawText = (await link.innerText().catch(() => "")) || "";
        const image = await link
            .locator("img")
            .first()
            .getAttribute("src")
            .catch(() => null);
        items.push({ href, rawText, image });
    }
    return items;
}
function toResult(searchTerm, card, matchConfig, semanticRuntime) {
    const normalizedUrl = normalizeMarketplaceItemUrl(card.href);
    if (!normalizedUrl.includes("/marketplace/item/")) {
        return null;
    }
    const rawText = normalizeText(card.rawText);
    const result = {
        searchTerm,
        titleRaw: extractTitle(rawText),
        priceRaw: extractPrice(rawText),
        locationRaw: extractLocation(rawText),
        url: normalizedUrl,
        image: card.image,
        rawText,
        cardText: rawText,
        detailText: null,
        cardMatchedTokens: [],
        detailMatchedTokens: [],
        matchedTokens: [],
        missingTokens: [],
        excludedTokens: [],
        matchScore: 0,
        matchApproved: false,
        relevanceLevel: "baixa",
        relevanceScore: 0,
        shouldOpenDetail: false,
        semanticReason: "Sem avaliação",
        collectedAt: new Date().toISOString()
    };
    applyMatchAndSemantic(result, matchConfig, semanticRuntime);
    return result;
}
async function openMarketplaceHome(page) {
    try {
        await page.goto(MARKETPLACE_URL, {
            waitUntil: "domcontentloaded",
            timeout: 60_000
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Não foi possível abrir o Facebook Marketplace: ${message}`);
    }
}
function buildSearchUrl(searchTerm, searchConfig) {
    const basePath = searchConfig.locationId?.trim()
        ? `https://www.facebook.com/marketplace/${encodeURIComponent(searchConfig.locationId.trim())}/search`
        : "https://www.facebook.com/marketplace/search";
    const url = new URL(basePath);
    url.searchParams.set("query", searchTerm);
    if (searchConfig.minPrice != null) {
        url.searchParams.set("minPrice", String(searchConfig.minPrice));
    }
    if (searchConfig.maxPrice != null) {
        url.searchParams.set("maxPrice", String(searchConfig.maxPrice));
    }
    if (searchConfig.daysSinceListed != null) {
        url.searchParams.set("daysSinceListed", String(searchConfig.daysSinceListed));
    }
    if (searchConfig.sortBy?.trim()) {
        url.searchParams.set("sortBy", searchConfig.sortBy.trim());
    }
    if (searchConfig.itemCondition?.trim()) {
        url.searchParams.set("itemCondition", searchConfig.itemCondition.trim());
    }
    if (typeof searchConfig.exact === "boolean") {
        url.searchParams.set("exact", searchConfig.exact ? "true" : "false");
    }
    return url.toString();
}
async function openSearchPage(page, searchTerm, searchConfig) {
    const searchUrl = buildSearchUrl(searchTerm, searchConfig);
    await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await sleep(3_000);
}
async function readItemVisibleText(context, itemUrl) {
    const itemPage = await context.newPage();
    try {
        await itemPage.goto(itemUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await sleep(2_000);
        const blockReason = await detectBlockingVerification(itemPage);
        if (blockReason) {
            throw new Error(`Processo interrompido por tela de verificação/bloqueio ao abrir anúncio. Motivo: ${blockReason}`);
        }
        let text = "";
        const mainAreaCount = await itemPage.locator('div[role="main"]').count();
        if (mainAreaCount > 0) {
            text = await itemPage.locator('div[role="main"]').first().innerText().catch(() => "");
        }
        if (!text.trim()) {
            text = await readPageText(itemPage);
        }
        return stripMarketplaceSuggestionSections(text);
    }
    finally {
        await itemPage.close();
    }
}
async function enrichResultsWithItemDetails(context, results, maxDetailPages, matchConfig, minMatchedTokensForDetailOpen, semanticRuntime, shouldCancel) {
    const candidates = results
        .filter((item) => item.relevanceLevel !== "descartar" &&
        item.shouldOpenDetail &&
        item.matchedTokens.length >= minMatchedTokensForDetailOpen)
        .sort((a, b) => {
        const byScore = b.relevanceScore - a.relevanceScore;
        if (byScore !== 0) {
            return byScore;
        }
        return b.matchedTokens.length - a.matchedTokens.length;
    });
    const limit = Math.min(maxDetailPages, candidates.length);
    if (limit <= 0) {
        console.log(`Nenhum anúncio com match mínimo (${minMatchedTokensForDetailOpen}) para abrir detalhe.`);
        return;
    }
    console.log(`Enriquecimento: abrindo até ${limit} anúncio(s) para validar dados visíveis.`);
    for (let index = 0; index < limit; index += 1) {
        if (shouldCancel && (await shouldCancel())) {
            throw new Error("Execução cancelada por solicitação externa.");
        }
        const result = candidates[index];
        console.log(`Processando detalhe ${index + 1}/${limit}: abrindo anúncio e lendo descrição.`);
        const itemText = await readItemVisibleText(context, result.url);
        if (!itemText) {
            continue;
        }
        result.detailText = itemText;
        const merged = normalizeText(`${result.cardText}\n${itemText}`);
        result.rawText = merged;
        const betterTitle = extractTitle(merged);
        if ((!result.titleRaw || /^R\$/.test(result.titleRaw) || isGenericMarketplaceTitle(result.titleRaw)) &&
            betterTitle &&
            !isGenericMarketplaceTitle(betterTitle)) {
            result.titleRaw = betterTitle;
        }
        if (!result.priceRaw) {
            result.priceRaw = extractPrice(merged);
        }
        if (!result.locationRaw) {
            result.locationRaw = extractLocation(merged);
        }
        applyMatchAndSemantic(result, matchConfig, semanticRuntime);
        await sleep(randomBetween(800, 1500));
    }
}
export async function runMarketplaceSearch({ searchTerm, maxScrolls, headless, profilePath, requireTermMatch, enrichItemDetails, maxDetailPages, minMatchedTokensForDetailOpen, maxFallbackResults, searchConfig, matchConfig, semanticRuntime, onUniqueResult, shouldCancel, onCollectionComplete }) {
    let context = null;
    try {
        context = await chromium.launchPersistentContext(profilePath, {
            ...buildPlaywrightLaunchOptions(headless),
            viewport: { width: 1366, height: 768 },
            locale: "pt-BR"
        });
        const page = context.pages()[0] ?? (await context.newPage());
        console.log("Abrindo Facebook Marketplace...");
        await openMarketplaceHome(page);
        const interventionRequired = await detectManualIntervention(page);
        if (interventionRequired) {
            console.log("Status de login: intervenção manual necessária.");
            await waitForUserEnter();
            await sleep(1_000);
            await openMarketplaceHome(page);
        }
        else {
            console.log("Status de login: sessão ativa, sem intervenção manual.");
        }
        const preSearchBlockReason = await detectBlockingVerification(page);
        if (preSearchBlockReason) {
            throw new Error(`Processo interrompido por tela de verificação/bloqueio. Motivo: ${preSearchBlockReason}`);
        }
        console.log("Abrindo tela de busca...");
        await openSearchPage(page, searchTerm, searchConfig);
        const postSearchBlockReason = await detectBlockingVerification(page);
        if (postSearchBlockReason) {
            throw new Error(`Processo interrompido por tela de verificação/bloqueio. Motivo: ${postSearchBlockReason}`);
        }
        const unique = new Map();
        let staleScrolls = 0;
        for (let scrollIndex = 1; scrollIndex <= maxScrolls; scrollIndex += 1) {
            if (shouldCancel && (await shouldCancel())) {
                throw new Error("Execução cancelada por solicitação externa.");
            }
            console.log(`Coleta ${scrollIndex}/${maxScrolls}: lendo cards visíveis na tela.`);
            const beforeUniqueCount = unique.size;
            const cards = await collectVisibleCards(page);
            for (const card of cards) {
                const result = toResult(searchTerm, card, matchConfig, semanticRuntime);
                if (!result) {
                    continue;
                }
                if (!unique.has(result.url)) {
                    unique.set(result.url, result);
                    if (onUniqueResult) {
                        try {
                            onUniqueResult(result);
                        }
                        catch {
                            // noop: callback side-effects must not break scraping
                        }
                    }
                }
            }
            const addedInThisStep = unique.size - beforeUniqueCount;
            console.log(`Coleta ${scrollIndex}/${maxScrolls} concluída: +${addedInThisStep} novo(s), ${unique.size} anúncio(s) únicos.`);
            if (scrollIndex < maxScrolls) {
                const scrollAttempt = await advanceMarketplaceFeed(page);
                if (scrollAttempt.moved) {
                    staleScrolls = 0;
                    console.log(`Scroll ${scrollIndex}/${maxScrolls}: avanço por ${scrollAttempt.strategy} ` +
                        `(cards ${scrollAttempt.beforeCount} -> ${scrollAttempt.afterCount}).`);
                }
                else {
                    staleScrolls += 1;
                    console.log(`Scroll ${scrollIndex}/${maxScrolls}: sem avanço detectado ` +
                        `(tentativa ${staleScrolls}/2, strategy=${scrollAttempt.strategy}).`);
                    if (staleScrolls >= 2) {
                        console.log("Interrompendo coleta antes do limite: feed sem progresso após múltiplas tentativas de scroll.");
                        break;
                    }
                }
            }
            const scrollBlockReason = await detectBlockingVerification(page);
            if (scrollBlockReason) {
                throw new Error(`Processo interrompido por tela de verificação/bloqueio durante o scroll. Motivo: ${scrollBlockReason}`);
            }
        }
        const results = [...unique.values()];
        console.log(`Coleta concluída: ${results.length} anúncio(s) únicos antes do filtro final.`);
        if (enrichItemDetails) {
            await enrichResultsWithItemDetails(context, results, maxDetailPages, matchConfig, minMatchedTokensForDetailOpen, semanticRuntime, shouldCancel);
        }
        if (onCollectionComplete) {
            const snapshot = results.map((item) => ({
                ...item,
                cardMatchedTokens: [...item.cardMatchedTokens],
                detailMatchedTokens: [...item.detailMatchedTokens],
                matchedTokens: [...item.matchedTokens],
                missingTokens: [...item.missingTokens],
                excludedTokens: [...item.excludedTokens]
            }));
            onCollectionComplete(snapshot);
        }
        const hasCardConstraint = (item) => {
            const required = semanticRuntime.cardRequiredAnyTokens;
            if (!required || required.length === 0) {
                return true;
            }
            const cardEval = evaluateTermMatch(item.cardText, {
                requiredTokens: required,
                excludeTokens: [],
                minRequiredRatio: 0,
                requireAll: false
            });
            const minMatches = Math.max(1, semanticRuntime.cardMinMatchedTokens ?? 1);
            return cardEval.matchedTokens.length >= minMatches;
        };
        const strictFiltered = requireTermMatch
            ? results.filter((item) => {
                if (item.relevanceLevel === "descartar") {
                    return false;
                }
                // Wheels can appear with equivalent vocabulary (ex.: "4 furos" vs "4x100").
                // Keep medium/high semantic matches even when token matching is not literal.
                if (semanticRuntime.ruleName === "wheels") {
                    return (hasCardConstraint(item) &&
                        (item.matchApproved || item.relevanceLevel === "alta" || item.relevanceLevel === "media"));
                }
                return hasCardConstraint(item) && item.matchApproved;
            })
            : results.filter((item) => item.relevanceLevel !== "descartar");
        let filtered = strictFiltered;
        if (requireTermMatch && filtered.length === 0 && results.length > 0) {
            const relaxed = results.filter((item) => item.relevanceLevel !== "descartar" &&
                item.matchedTokens.length >= 1 &&
                hasCardConstraint(item));
            if (relaxed.length > 0) {
                const limited = maxFallbackResults > 0 ? relaxed.slice(0, maxFallbackResults) : relaxed;
                console.log(`Filtro estrito retornou 0. Aplicando fallback para anúncios com pelo menos 1 token casado (${limited.length}/${relaxed.length}).`);
                filtered = limited;
            }
        }
        if (requireTermMatch) {
            console.log(`Após filtro de match: ${filtered.length}`);
        }
        filtered.sort((a, b) => {
            const bySemantic = b.relevanceScore - a.relevanceScore;
            if (bySemantic !== 0) {
                return bySemantic;
            }
            const byMatch = b.matchScore - a.matchScore;
            if (byMatch !== 0) {
                return byMatch;
            }
            const byMatchedCount = b.matchedTokens.length - a.matchedTokens.length;
            if (byMatchedCount !== 0) {
                return byMatchedCount;
            }
            return a.titleRaw.localeCompare(b.titleRaw, "pt-BR");
        });
        return filtered;
    }
    finally {
        if (context) {
            await context.close();
        }
    }
}
