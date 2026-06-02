import { formatFipeResult, lookupFipe } from "../scrapers/placafipe.js";
import { sendTextMessageToZApi } from "../integrations/zapi.js";
export async function handleFipeLookup(plate, groupPhone, zApiConfig, options) {
    const log = options?.log ?? console.log;
    if (!plate) {
        return "❌ Informe a placa. Ex: */buscar-fipe ABC1234*";
    }
    log(`[fipe] Consultando placa: ${plate}`);
    const result = await lookupFipe(plate, { headless: options?.headless ?? true });
    if (!result.ok) {
        return `❌ ${result.reason}`;
    }
    const message = formatFipeResult(result.data);
    if (zApiConfig.enabled) {
        await sendTextMessageToZApi(zApiConfig, { message, phone: groupPhone });
    }
    return message;
}
