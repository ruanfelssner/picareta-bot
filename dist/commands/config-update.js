import { getAuctionFilters, upsertAuctionFilters } from "../integrations/mongo.js";
function parseConfigArg(arg) {
    const raw = arg.trim();
    const lower = raw.toLowerCase();
    if (lower === "" || lower === "show") {
        return { action: "show", value: null };
    }
    if (lower.startsWith("locais ")) {
        return { action: "set-locations", value: raw.slice("locais ".length).trim() };
    }
    if (lower.startsWith("local ")) {
        return { action: "set-locations", value: raw.slice("local ".length).trim() };
    }
    if (lower.startsWith("estados ")) {
        return { action: "set-states", value: raw.slice("estados ".length).trim() };
    }
    if (lower.startsWith("estado ")) {
        return { action: "set-states", value: raw.slice("estado ".length).trim() };
    }
    if (lower.startsWith("cidades ")) {
        return { action: "set-cities", value: raw.slice("cidades ".length).trim() };
    }
    if (lower.startsWith("cidade ")) {
        return { action: "set-cities", value: raw.slice("cidade ".length).trim() };
    }
    return null;
}
function formatComboRule(rule, index) {
    const chunks = [
        rule.brand?.trim() || null,
        rule.model?.trim() || null,
        rule.text?.trim() || null,
        rule.minYear != null ? `ano>=${rule.minYear}` : null
    ].filter(Boolean);
    const label = chunks.length > 0 ? chunks.join(" + ") : "regra vazia";
    const status = rule.enabled ? "ativa" : "pausada";
    const mode = rule.mode === "exclude" ? "excluir" : "incluir";
    return `${index + 1}. [${mode}] ${label} (${status})`;
}
function formatFiltersMessage(filters) {
    const combos = filters.comboRules.length > 0
        ? filters.comboRules.map((rule, idx) => formatComboRule(rule, idx)).join("\n")
        : "nenhum combo cadastrado";
    const locations = filters.locations.length > 0
        ? filters.locations.join(", ")
        : "padrão do scraper";
    const states = filters.states.length > 0
        ? filters.states.join(", ")
        : "todos";
    const cities = filters.cities.length > 0
        ? filters.cities.join(", ")
        : "todas";
    return [
        "*⚙️ Filtros (modo novo):*",
        "",
        `🎯 *Combos:* ${filters.comboRules.length}`,
        combos,
        "",
        `📍 *Locais:* ${locations}`,
        `🗺️ *Estados:* ${states}`,
        `🏙️ *Cidades:* ${cities}`,
        "",
        "ℹ️ Campos legados (marca/modelo/ano/preço/avaria/negativados) foram removidos.",
        "_Edite combos na UI web._",
        "",
        `_Atualizado: ${filters.updatedAt.toLocaleString("pt-BR")}_`
    ].join("\n");
}
function parseLocationsInput(value) {
    return value
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
}
function parseListOrClearInput(value) {
    const trimmed = value.trim();
    const lowered = trimmed.toLowerCase();
    if (lowered === "limpar" ||
        lowered === "clear" ||
        lowered === "reset" ||
        lowered === "nenhum" ||
        lowered === "nenhuma" ||
        lowered === "none") {
        return { clear: true, values: [] };
    }
    return {
        clear: false,
        values: parseLocationsInput(trimmed)
    };
}
export async function handleConfigUpdate(arg, config) {
    const parsed = parseConfigArg(arg ?? "show");
    if (!parsed) {
        return {
            ok: false,
            message: "❌ Comando não reconhecido.\n" +
                "Use:\n" +
                "  /filtros\n" +
                "  /filtro locais Curitiba - PR, Canoas - RS\n" +
                "  /filtro locais limpar\n" +
                "  /filtro estados PR, SC\n" +
                "  /filtro cidades Curitiba, Pinhais\n" +
                "  /filtro estados limpar\n" +
                "  /filtro cidades limpar\n" +
                "Os filtros legados foram removidos; ajuste combos pela UI."
        };
    }
    if (parsed.action === "show") {
        const filters = await getAuctionFilters(config);
        return { ok: true, message: formatFiltersMessage(filters), filters };
    }
    if (parsed.action === "set-locations") {
        const { clear, values } = parseListOrClearInput(parsed.value);
        if (!clear && values.length === 0) {
            return {
                ok: false,
                message: "❌ Informe ao menos um local (ex: /filtro locais Curitiba - PR, Canoas - RS) " +
                    "ou use /filtro locais limpar"
            };
        }
        const updated = await upsertAuctionFilters(config, { locations: clear ? [] : values });
        return {
            ok: true,
            message: updated.locations.length > 0
                ? `✅ Locais atualizados: *${updated.locations.join(", ")}*`
                : "✅ Filtro de locais removido (Copart sem trava por local).",
            filters: updated
        };
    }
    if (parsed.action === "set-states") {
        const { clear, values } = parseListOrClearInput(parsed.value);
        if (!clear && values.length === 0) {
            return {
                ok: false,
                message: "❌ Informe estados (ex: /filtro estados PR, SC) ou use /filtro estados limpar"
            };
        }
        const updated = await upsertAuctionFilters(config, { states: clear ? [] : values });
        return {
            ok: true,
            message: updated.states.length > 0
                ? `✅ Estados atualizados: *${updated.states.join(", ")}*`
                : "✅ Filtro por estado removido.",
            filters: updated
        };
    }
    if (parsed.action === "set-cities") {
        const { clear, values } = parseListOrClearInput(parsed.value);
        if (!clear && values.length === 0) {
            return {
                ok: false,
                message: "❌ Informe cidades (ex: /filtro cidades Curitiba, Pinhais) ou use /filtro cidades limpar"
            };
        }
        const updated = await upsertAuctionFilters(config, { cities: clear ? [] : values });
        return {
            ok: true,
            message: updated.cities.length > 0
                ? `✅ Cidades atualizadas: *${updated.cities.join(", ")}*`
                : "✅ Filtro por cidade removido.",
            filters: updated
        };
    }
    return {
        ok: false,
        message: "❌ Comando inválido."
    };
}
