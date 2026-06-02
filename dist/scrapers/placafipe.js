import { chromium } from "playwright";
import { buildPlaywrightLaunchOptions } from "../playwright-launch.js";
export async function lookupFipe(plate, options) {
    const cleanPlate = plate.replace(/[^A-Z0-9]/gi, "").toUpperCase();
    if (!cleanPlate || cleanPlate.length < 7) {
        return { ok: false, reason: "Placa inválida. Informe no formato ABC1234 ou ABC1D23." };
    }
    const headless = options?.headless ?? true;
    const browser = await chromium.launch(buildPlaywrightLaunchOptions(headless));
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    try {
        const url = `https://placafipe.com.br/${cleanPlate}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        // aguarda resultado aparecer (campo de marca ou mensagem de erro)
        await page.waitForSelector("table, .alert, .error, #resultado", { timeout: 20_000 }).catch(() => null);
        const pageText = (await page.innerText("body").catch(() => "")).toLowerCase();
        if (pageText.includes("não encontrad") || pageText.includes("placa inválida") || pageText.includes("erro")) {
            return { ok: false, reason: `Placa *${cleanPlate}* não encontrada na base FIPE.` };
        }
        // Tenta extrair de tabela (padrão placafipe.com.br)
        const extractCell = async (label) => {
            const rows = await page.$$("tr");
            for (const row of rows) {
                const text = await row.innerText().catch(() => "");
                if (text.toLowerCase().includes(label.toLowerCase())) {
                    const cells = await row.$$("td");
                    if (cells.length >= 2) {
                        return (await cells[cells.length - 1].innerText().catch(() => "")).trim();
                    }
                }
            }
            return "";
        };
        const [brand, model, year, fipeCode, fipePrice, fuelType, referenceMonth] = await Promise.all([
            extractCell("marca"),
            extractCell("modelo"),
            extractCell("ano"),
            extractCell("código fipe"),
            extractCell("preço"),
            extractCell("combustível"),
            extractCell("mês de referência")
        ]);
        if (!brand && !model) {
            return { ok: false, reason: `Não foi possível extrair dados para a placa *${cleanPlate}*.` };
        }
        return {
            ok: true,
            data: {
                plate: cleanPlate,
                brand: brand || "—",
                model: model || "—",
                year: year || "—",
                fipeCode: fipeCode || "—",
                fipePrice: fipePrice || "—",
                fuelType: fuelType || "—",
                referenceMonth: referenceMonth || "—"
            }
        };
    }
    finally {
        await browser.close();
    }
}
export function formatFipeResult(result) {
    return [
        `🚗 *${result.brand} ${result.model}*`,
        `📅 Ano: ${result.year}`,
        `⛽ Combustível: ${result.fuelType}`,
        `💰 Valor FIPE: *${result.fipePrice}*`,
        `🏷️ Código FIPE: ${result.fipeCode}`,
        `📆 Referência: ${result.referenceMonth}`,
        `🔍 Placa: ${result.plate}`
    ].join("\n");
}
