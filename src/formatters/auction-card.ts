export type AuctionVehicle = {
  source:
    | "vs-veiculos"
    | "sodre"
    | "copart"
    | "favareto"
    | "claudio-kuss"
    | "lucinei"
    | "vardana"
    | "mgl"
    | "ph-batidos"
    | "megaleiloes"
    | "superbid"
    | "leiloesjudiciais"
    | "vipleiloes";
  brand: string;
  model: string;
  year: number | null;
  damage: string | null;
  condition?: string | null;
  price: number | null;
  priceRaw: string | null;
  priceLabel?: string | null;
  imageUrls: string[];
  description: string;
  url: string;
  auctionDate: Date | null;
  lot?: string;
  km?: string | null;
  color?: string | null;
  yard?: string | null;
  consignor?: string | null;
  appraisal?: number | null;
  appraisalRaw?: string | null;
  fipe?: number | null;
  fipeRaw?: string | null;
  fipeCode?: string | null;
  fipeReferenceMonth?: string | null;
  fipeModelYear?: number | null;
  fipeFuel?: string | null;
  fipeBrandMatched?: string | null;
  fipeModelMatched?: string | null;
  fipeCheckedAt?: string | Date | null;
  fipeLookupError?: string | null;
  city?: string | null;
  state?: string | null;
  manualCostsTotal?: number | null;
  costNotes?: string | null;
};

const SOURCE_LABELS: Record<AuctionVehicle["source"], string> = {
  "vs-veiculos": "VS Veículos",
  sodre: "Sodré Santoro",
  copart: "Copart",
  favareto: "Favareto",
  "claudio-kuss": "Claudio Kuss",
  lucinei: "Lucinei Automóveis",
  vardana: "Vardana Leilões",
  mgl: "MGL",
  "ph-batidos": "PH Batidos",
  megaleiloes: "Mega Leilões",
  superbid: "Superbid",
  leiloesjudiciais: "Leilões Judiciais",
  vipleiloes: "VIP Leilões"
};

type MontaLevel = "pequena" | "media";

type AuctionCostTier = {
  maxFipe: number | null;
  repairSmall: number;
  repairMedium: number;
  saleCost: number;
  targetProfit: number;
};

const AUCTION_COST_TIERS: AuctionCostTier[] = [
  { maxFipe: 40_000, repairSmall: 3_000, repairMedium: 6_000, saleCost: 3_000, targetProfit: 10_000 },
  { maxFipe: 60_000, repairSmall: 8_000, repairMedium: 15_000, saleCost: 5_000, targetProfit: 10_000 },
  { maxFipe: 120_000, repairSmall: 12_000, repairMedium: 20_000, saleCost: 10_000, targetProfit: 20_000 },
  { maxFipe: 200_000, repairSmall: 20_000, repairMedium: 30_000, saleCost: 20_000, targetProfit: 40_000 },
  // Assumido para > 200k; ajustar se quiser outro alvo.
  { maxFipe: null, repairSmall: 30_000, repairMedium: 50_000, saleCost: 30_000, targetProfit: 60_000 }
];

const TRANSPORT_COST_BY_STATE: Record<string, number> = {
  RS: 1_300,
  SP: 1_300
};

function formatPrice(price: number | null, priceRaw: string | null): string {
  if (priceRaw) return priceRaw;
  if (price != null) return `R$ ${price.toLocaleString("pt-BR")}`;
  return "Sem oferta de Lance";
}

function normalizePriceLabel(value: string | null | undefined): string {
  const label = (value ?? "").trim();
  return label || "Atual";
}

function formatMoney(value: number | null, valueRaw: string | null): string | null {
  if (valueRaw) return valueRaw;
  if (value != null) return `R$ ${value.toLocaleString("pt-BR")}`;
  return null;
}

function formatDate(date: Date | null): string | null {
  if (!date) {
    return null;
  }
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

function formatDateShort(date: Date | null): string | null {
  if (!date) return null;
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit"
  });
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeLocationText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detectTransportState(vehicle: AuctionVehicle): string | null {
  const haystack = normalizeLocationText(
    [vehicle.yard, vehicle.description, vehicle.url].filter(Boolean).join(" ")
  );
  if (!haystack) return null;

  if (/\bRS\b/.test(haystack) || /\bRIO GRANDE DO SUL\b/.test(haystack)) return "RS";
  if (/\bSP\b/.test(haystack) || /\bSAO PAULO\b/.test(haystack)) return "SP";
  return null;
}

function detectMontaLevel(damage: string | null | undefined): MontaLevel | null {
  const normalized = normalizeText(damage ?? "");
  if (!normalized) return null;
  if (normalized.includes("sem monta")) return null;
  if (normalized.includes("pequena")) return "pequena";
  if (normalized.includes("media") || normalized.includes("média")) return "media";
  if (normalized.includes("grande") || normalized.includes("sucata")) return "media";
  return null;
}

function pickCostTierByFipe(fipe: number): AuctionCostTier {
  for (const tier of AUCTION_COST_TIERS) {
    if (tier.maxFipe == null || fipe <= tier.maxFipe) {
      return tier;
    }
  }
  return AUCTION_COST_TIERS[AUCTION_COST_TIERS.length - 1]!;
}

type AuctionFinancialEstimate = {
  fipe: number | null;
  price: number | null;
  montaLevel: MontaLevel | null;
  repairCost: number | null;
  saleCost: number | null;
  transportCost: number | null;
  estimatedCostsTotal: number | null;
  effectiveCostsTotal: number | null;
  totalPaidWithCosts: number | null;
  bidPercentFromFipe: number | null;
  paidWithCostsPercentFromFipe: number | null;
  targetProfit: number | null;
  estimatedGain: number | null;
  estimatedMarginPercent: number | null;
  costsMode: "manual" | "estimated" | "none";
};

function estimateAuctionFinancials(vehicle: AuctionVehicle): AuctionFinancialEstimate {
  const fipe = Number.isFinite(Number(vehicle.fipe)) && Number(vehicle.fipe) > 0
    ? Math.round(Number(vehicle.fipe))
    : null;
  const price = Number.isFinite(Number(vehicle.price)) && Number(vehicle.price) > 0
    ? Math.round(Number(vehicle.price))
    : null;
  const manualCosts = Number.isFinite(Number(vehicle.manualCostsTotal)) && Number(vehicle.manualCostsTotal) > 0
    ? Math.round(Number(vehicle.manualCostsTotal))
    : null;

  if (fipe == null) {
    return {
      fipe: null,
      price,
      montaLevel: null,
      repairCost: null,
      saleCost: null,
      transportCost: null,
      estimatedCostsTotal: null,
      effectiveCostsTotal: manualCosts,
      totalPaidWithCosts: price != null && manualCosts != null ? price + manualCosts : null,
      bidPercentFromFipe: null,
      paidWithCostsPercentFromFipe: null,
      targetProfit: null,
      estimatedGain: null,
      estimatedMarginPercent: null,
      costsMode: manualCosts != null ? "manual" : "none"
    };
  }

  const tier = pickCostTierByFipe(fipe);
  const montaLevel = detectMontaLevel(vehicle.damage);
  const repairCost =
    montaLevel === "pequena"
      ? tier.repairSmall
      : montaLevel === "media"
        ? tier.repairMedium
        : null;
  const saleCost = tier.saleCost;
  const transportState = detectTransportState(vehicle);
  const transportCost = transportState ? (TRANSPORT_COST_BY_STATE[transportState] ?? 0) : 0;
  const estimatedCostsTotal = (repairCost ?? 0) + saleCost + transportCost;
  const effectiveCostsTotal = manualCosts ?? estimatedCostsTotal;
  const totalPaidWithCosts =
    price != null && effectiveCostsTotal != null
      ? price + effectiveCostsTotal
      : null;
  const bidPercentFromFipe =
    price != null && fipe > 0
      ? Math.round((price / fipe) * 100)
      : null;
  const paidWithCostsPercentFromFipe =
    totalPaidWithCosts != null && fipe > 0
      ? Math.round((totalPaidWithCosts / fipe) * 100)
      : null;
  const estimatedGain =
    totalPaidWithCosts != null
      ? fipe - totalPaidWithCosts
      : null;
  const estimatedMarginPercent =
    estimatedGain != null && fipe > 0
      ? Math.round((estimatedGain / fipe) * 100)
      : null;

  return {
    fipe,
    price,
    montaLevel,
    repairCost,
    saleCost,
    transportCost,
    estimatedCostsTotal,
    effectiveCostsTotal,
    totalPaidWithCosts,
    bidPercentFromFipe,
    paidWithCostsPercentFromFipe,
    targetProfit: tier.targetProfit,
    estimatedGain,
    estimatedMarginPercent,
    costsMode: manualCosts != null ? "manual" : "estimated"
  };
}

export function formatAuctionCardCaption(vehicle: AuctionVehicle): string {
  const title = [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(" ").trim() || "(sem título)";
  const source = SOURCE_LABELS[vehicle.source];
  const currentPrice = formatPrice(vehicle.price, vehicle.priceRaw);
  const priceLabel = normalizePriceLabel(vehicle.priceLabel);
  const auctionDate = formatDate(vehicle.auctionDate);
  const auctionDateShort = formatDateShort(vehicle.auctionDate);
  const financial = estimateAuctionFinancials(vehicle);
  const appraisal = formatMoney(
    Number.isFinite(Number(vehicle.appraisal)) ? Number(vehicle.appraisal) : null,
    vehicle.appraisalRaw ?? null
  );
  const fipe = formatMoney(financial.fipe, vehicle.fipeRaw ?? null);
  const bidPercentFromFipe =
    financial.bidPercentFromFipe != null ? `${financial.bidPercentFromFipe}% FIPE` : null;
  const costsDisplay = formatMoney(financial.effectiveCostsTotal, null);
  const totalWithCosts = formatMoney(financial.totalPaidWithCosts, null);
  const totalPercentFromFipeWithCosts =
    financial.paidWithCostsPercentFromFipe != null
      ? `${financial.paidWithCostsPercentFromFipe}% FIPE`
      : null;
  const estimatedGain = formatMoney(financial.estimatedGain, null);
  const lines: string[] = [source, `🚗 ${title}`];
  if (vehicle.damage) lines.push(`🔧 ${vehicle.damage}`);

  const extras: string[] = [];
  if (vehicle.color) extras.push(vehicle.color);
  if (vehicle.km) extras.push(`${vehicle.km} km`);
  if (extras.length > 0) lines.push(`📌 ${extras.join(" · ")}`);
  if (vehicle.yard) lines.push(`📍 Pátio: ${vehicle.yard}`);
  if (appraisal) lines.push(`🏛️ Avaliação: ${appraisal}`);

  if (fipe) {
    const currentWithPercent = bidPercentFromFipe
      ? `${currentPrice} (${bidPercentFromFipe})`
      : currentPrice;
    lines.push(`📊 FIPE: ${fipe}  💰${priceLabel}: ${currentWithPercent}`);
  } else {
    lines.push(`💰${priceLabel}: ${currentPrice}`);
  }

  if (costsDisplay) {
    if (
      financial.costsMode === "estimated" &&
      financial.saleCost != null
    ) {
      const saleText = formatMoney(financial.saleCost, null);
      const transportText =
        financial.transportCost != null && financial.transportCost > 0
          ? formatMoney(financial.transportCost, null)
          : null;
      const breakdown: string[] = [];
      if (financial.montaLevel && financial.repairCost != null) {
        const repairText = formatMoney(financial.repairCost, null);
        const montaLabel = financial.montaLevel === "pequena" ? "pequena monta" : "média monta";
        breakdown.push(`${montaLabel}: ${repairText}`);
      }
      breakdown.push(`venda: ${saleText}`);
      if (transportText) {
        breakdown.push(`transporte: ${transportText}`);
      }
      lines.push(`🧰 Custos estimados: ${costsDisplay} (${breakdown.join(" + ")})`);
    } else {
      lines.push(`🧰 Custos: ${costsDisplay}`);
    }
  }
  if (totalWithCosts) {
    const totalWithPercent = totalPercentFromFipeWithCosts
      ? `${totalWithCosts} (${totalPercentFromFipeWithCosts})`
      : totalWithCosts;
    lines.push(`💵 Total c/ custos: ${totalWithPercent}`);
  }
  if (financial.targetProfit != null) {
    lines.push(`🎯 Meta lucro: ${formatMoney(financial.targetProfit, null)}`);
  }
  if (estimatedGain && financial.estimatedMarginPercent != null) {
    lines.push(`📉 Ganho Médio: ${estimatedGain} (Margem ${financial.estimatedMarginPercent}%)`);
  }
  if (vehicle.costNotes) lines.push(`📝 Obs: ${vehicle.costNotes}`);
  if (auctionDateShort) lines.push(`🗓️ Data: ${auctionDateShort}`);
  else if (auctionDate) lines.push(`🗓️ Data: ${auctionDate}`);
  if (vehicle.lot) lines.push(`📋 Lote: ${vehicle.lot}`);
  lines.push(`🏷️ Fonte: ${source}  🔗 ${vehicle.url}`);
  return lines.join("\n");
}

export function formatAuctionSummary(vehicles: AuctionVehicle[]): string {
  if (vehicles.length === 0) {
    return "Nenhum veículo encontrado nos leilões de hoje com os filtros configurados.";
  }

  const bySource = vehicles.reduce<Record<string, number>>((acc, v) => {
    const label = SOURCE_LABELS[v.source];
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});

  const sourceLines = Object.entries(bySource)
    .map(([label, count]) => `  • ${label}: ${count}`)
    .join("\n");

  return `✅ *${vehicles.length} veículo(s) encontrado(s) nos leilões de hoje:*\n${sourceLines}`;
}
