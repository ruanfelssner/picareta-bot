const BRAZIL_STATE_ALIASES = {
    "AC": "AC",
    "ACRE": "AC",
    "AL": "AL",
    "ALAGOAS": "AL",
    "AM": "AM",
    "AMAZONAS": "AM",
    "AP": "AP",
    "AMAPA": "AP",
    "BA": "BA",
    "BAHIA": "BA",
    "CE": "CE",
    "CEARA": "CE",
    "DF": "DF",
    "DISTRITO FEDERAL": "DF",
    "ES": "ES",
    "ESPIRITO SANTO": "ES",
    "GO": "GO",
    "GOIAS": "GO",
    "MA": "MA",
    "MARANHAO": "MA",
    "MG": "MG",
    "MINAS GERAIS": "MG",
    "MS": "MS",
    "MATO GROSSO DO SUL": "MS",
    "MT": "MT",
    "MATO GROSSO": "MT",
    "PA": "PA",
    "PARA": "PA",
    "PB": "PB",
    "PARAIBA": "PB",
    "PE": "PE",
    "PERNAMBUCO": "PE",
    "PI": "PI",
    "PIAUI": "PI",
    "PR": "PR",
    "PARANA": "PR",
    "RJ": "RJ",
    "RIO DE JANEIRO": "RJ",
    "RN": "RN",
    "RIO GRANDE DO NORTE": "RN",
    "RO": "RO",
    "RONDONIA": "RO",
    "RR": "RR",
    "RORAIMA": "RR",
    "RS": "RS",
    "RIO GRANDE DO SUL": "RS",
    "SC": "SC",
    "SANTA CATARINA": "SC",
    "SE": "SE",
    "SERGIPE": "SE",
    "SP": "SP",
    "SAO PAULO": "SP",
    "TO": "TO",
    "TOCANTINS": "TO"
};
const STATE_MAIN_NAME_BY_CODE = Object.entries(BRAZIL_STATE_ALIASES).reduce((acc, [name, code]) => {
    if (name.length > 2 && !acc[code]) {
        acc[code] = name;
    }
    return acc;
}, {});
function normalizeToken(value) {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function hasBoundaryTerm(haystackNormalized, termNormalized) {
    if (!termNormalized)
        return false;
    const pattern = termNormalized
        .split(" ")
        .filter(Boolean)
        .map(escapeRegExp)
        .join(" ");
    if (!pattern)
        return false;
    const regex = new RegExp(`(?:^| )${pattern}(?= |$)`);
    return regex.test(haystackNormalized);
}
export function normalizeBrazilState(value) {
    if (typeof value !== "string")
        return null;
    const normalized = normalizeToken(value);
    if (!normalized)
        return null;
    return BRAZIL_STATE_ALIASES[normalized] ?? null;
}
export function sanitizeStateList(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
        const state = normalizeBrazilState(raw);
        if (!state || seen.has(state))
            continue;
        seen.add(state);
        out.push(state);
    }
    return out;
}
export function sanitizeCityList(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    const seen = new Set();
    for (const raw of input) {
        if (typeof raw !== "string")
            continue;
        const city = raw.trim();
        if (!city)
            continue;
        const key = normalizeToken(city);
        if (!key || seen.has(key))
            continue;
        seen.add(key);
        out.push(city);
    }
    return out;
}
function buildVehicleLocationHaystack(vehicle) {
    const parts = [vehicle.yard, vehicle.description, vehicle.url]
        .filter((value) => typeof value === "string" && value.trim().length > 0);
    // Favareto opera base Curitiba/PR; evita falso negativo quando o pátio não vem no lote.
    if (vehicle.source === "favareto") {
        parts.push("Curitiba PR");
    }
    return normalizeToken(parts.join(" "));
}
export function matchesAuctionVehicleGeoFilters(vehicle, filters) {
    const states = sanitizeStateList(filters.states ?? []);
    const cities = sanitizeCityList(filters.cities ?? []);
    if (states.length === 0 && cities.length === 0)
        return true;
    const haystack = buildVehicleLocationHaystack(vehicle);
    if (!haystack)
        return false;
    if (states.length > 0) {
        const hasState = states.some((stateCode) => {
            const stateName = STATE_MAIN_NAME_BY_CODE[stateCode] ?? "";
            return (hasBoundaryTerm(haystack, stateCode) ||
                (stateName ? hasBoundaryTerm(haystack, stateName) : false));
        });
        if (!hasState)
            return false;
    }
    if (cities.length > 0) {
        const hasCity = cities.some((city) => hasBoundaryTerm(haystack, normalizeToken(city)));
        if (!hasCity)
            return false;
    }
    return true;
}
export function filterAuctionVehiclesByGeo(vehicles, filters) {
    const activeStates = sanitizeStateList(filters.states ?? []);
    const activeCities = sanitizeCityList(filters.cities ?? []);
    if (activeStates.length === 0 && activeCities.length === 0) {
        return {
            vehicles,
            activeStates,
            activeCities,
            skipped: 0
        };
    }
    const filtered = vehicles.filter((vehicle) => matchesAuctionVehicleGeoFilters(vehicle, {
        states: activeStates,
        cities: activeCities
    }));
    return {
        vehicles: filtered,
        activeStates,
        activeCities,
        skipped: Math.max(0, vehicles.length - filtered.length)
    };
}
