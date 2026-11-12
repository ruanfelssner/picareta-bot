import { createHash } from 'node:crypto'
import type { AuctionVehicle } from '../../../../src/formatters/auction-card'
import { pestanaIdentityUrl } from '../../../../shared/utils/pestana-url'
import { vehicleYear } from '../../../../shared/utils/vehicle-year'

export function externalId(vehicle: AuctionVehicle): string {
  const identityUrl = vehicle.source === 'pestana' ? pestanaIdentityUrl(vehicle.url) : vehicle.url;
  const identity = [vehicle.source, identityUrl, vehicle.lot, vehicle.brand, vehicle.model, vehicle.year]
    .filter((value) => value != null && String(value).trim())
    .join("|");
  return `bot-${createHash("sha256").update(identity).digest("hex")}`;
}

export function toIngestRecord(vehicle: AuctionVehicle): Record<string, unknown> {
  return {
    externalId: externalId(vehicle),
    source: vehicle.source,
    // Este fluxo é o scraper automático. A extensão envia "extension" pelo
    // próprio registro; o Picareta usa null para separar os dois recortes.
    collectedVia: null,
    brand: vehicle.brand || null,
    model: vehicle.model || null,
    title: [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(" ") || null,
    description: vehicle.description || null,
    year: vehicleYear(vehicle.year),
    ...(vehicle.color != null ? { color: vehicle.color } : {}),
    ...(vehicle.fuel != null ? { fuel: vehicle.fuel } : {}),
    km: vehicle.km ? Number(String(vehicle.km).replace(/\D/g, "")) || null : null,
    price: vehicle.price ?? null,
    priceRaw: vehicle.priceRaw ?? null,
    damage: vehicle.damage ?? null,
    condition: vehicle.condition ?? null,
    lot: vehicle.lot ?? null,
    auctionDate: vehicle.auctionDate ?? null,
    auctionId: vehicle.auctionId ?? null,
    auctionUrl: vehicle.auctionUrl ?? null,
    auctionTimeKnown: vehicle.auctionTimeKnown ?? null,
    auctionEndsAt: vehicle.auctionEndsAt ?? null,
    auctionStatus: vehicle.auctionStatus ?? (vehicle.source === "vs-veiculos" ? "upcoming" : "unknown"),
    ...(vehicle.auctionStatusRaw != null ? { auctionStatusRaw: vehicle.auctionStatusRaw } : {}),
    ...(vehicle.auctionStatusCheckedAt != null ? { auctionStatusCheckedAt: vehicle.auctionStatusCheckedAt } : {}),
    ...(vehicle.saleStatus != null ? {
      saleStatus: vehicle.saleStatus,
      saleStatusRaw: vehicle.saleStatusRaw ?? null,
      saleStatusCheckedAt: vehicle.saleStatusCheckedAt ?? null,
    } : {}),
    ...(vehicle.soldPrice != null ? { soldPrice: vehicle.soldPrice, soldPriceRaw: vehicle.soldPriceRaw ?? null } : {}),
    city: vehicle.city ?? null,
    state: vehicle.state ?? null,
    fipe: vehicle.fipe ?? null,
    fipeRaw: vehicle.fipeRaw ?? null,
    fipeCode: vehicle.fipeCode ?? null,
    fipeReferenceMonth: vehicle.fipeReferenceMonth ?? null,
    fipeFuel: vehicle.fipeFuel ?? null,
    fipeBrandMatched: vehicle.fipeBrandMatched ?? null,
    fipeModelMatched: vehicle.fipeModelMatched ?? null,
    fipeCheckedAt: vehicle.fipeCheckedAt ?? null,
    status: "scraped",
    yard: vehicle.yard ?? null,
    consignor: vehicle.consignor ?? null,
    imageUrls: vehicle.imageUrls ?? [],
    url: vehicle.url ?? null,
    scrapedAt: new Date().toISOString()
  };
}

