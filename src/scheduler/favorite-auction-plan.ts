import { copartAuctionRoomUrl } from "../../shared/utils/copart-auction-room.js";

export const AUCTION_PREPARE_MS = 30 * 60_000;
export const AUCTION_POLL_MS = 60_000;
export const AUCTION_RETRY_MS = 5 * 60_000;
export const MAX_AUCTION_PAGES = 6;
export const AUCTION_SOURCES = ["copart", "sodre", "vipleiloes"] as const;
export type AuctionSource = typeof AUCTION_SOURCES[number];

export interface FavoriteAuction {
  id: string;
  source: AuctionSource;
  label: string;
  url: string | null;
  urlKind: string;
  startsAt: string | null;
  endsAt: string | null;
  timeKnown: boolean;
  status: string;
  favoriteCount: number | null;
  locationStates: string[];
}

export type AuctionDecision = { auction: FavoriteAuction; url: string | null; due: boolean; reason: string };
const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" });
const dateMs = (value: string | null) => value && /T\d{2}:\d{2}.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? Date.parse(value) : NaN;

export function favoriteAuctionRoomUrl(source: AuctionSource, value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    if (source === "copart") return copartAuctionRoomUrl(url.href);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    const valid = source === "sodre"
      ? ["leilao.sodresantoro.com.br", "sodresantoro.com.br"].includes(host) && /^\/leilao\/\d+$/i.test(path)
      : host === "vipleiloes.com.br" && /^\/eventoonline\/[a-z0-9_-]+$/i.test(path);
    if (!valid) return null;
    url.hash = "";
    return url.href;
  } catch { return null; }
}

/** Validação na fronteira: resposta inválida nunca vira agenda vazia nem libera uma abertura. */
export function parseFavoriteAuctionAgenda(value: unknown): FavoriteAuction[] {
  if (!value || typeof value !== "object" || !("auctions" in value) || !Array.isArray(value.auctions)) {
    throw new Error("Resposta da agenda inválida.");
  }
  return value.auctions.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== "object") return [];
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== "string" || !item.id || !AUCTION_SOURCES.includes(item.source as AuctionSource)) return [];
    return [{
      id: item.id, source: item.source as AuctionSource,
      label: typeof item.label === "string" ? item.label : item.id,
      url: typeof item.url === "string" ? item.url : null,
      urlKind: typeof item.urlKind === "string" ? item.urlKind : "unknown",
      startsAt: typeof item.startsAt === "string" ? item.startsAt : null,
      endsAt: typeof item.endsAt === "string" ? item.endsAt : null,
      timeKnown: item.timeKnown === true,
      status: typeof item.status === "string" ? item.status : "unknown",
      favoriteCount: typeof item.favoriteCount === "number" && Number.isInteger(item.favoriteCount) && item.favoriteCount >= 0 ? item.favoriteCount : null,
      locationStates: Array.isArray(item.locationStates) ? item.locationStates.filter((state): state is string => typeof state === "string") : [],
    }];
  });
}

export function planFavoriteAuctions(auctions: FavoriteAuction[], now: number): AuctionDecision[] {
  return auctions.map(auction => {
    const url = auction.urlKind === "auction" ? favoriteAuctionRoomUrl(auction.source, auction.url) : null;
    const start = dateMs(auction.startsAt);
    const end = dateMs(auction.endsAt);
    let reason = "pronto";
    if (auction.status === "finished" || (Number.isFinite(end) && end <= now)) reason = "encerrado";
    else if (auction.favoriteCount === null) reason = "favoritos indisponíveis";
    else if (auction.favoriteCount === 0) reason = "sem favoritos";
    else if (auction.source === "vipleiloes" && !auction.locationStates.includes("PR")) reason = "VIP sem PR confirmado";
    else if (!url) reason = "sala oficial indisponível";
    else if (!auction.timeKnown || !Number.isFinite(start)) reason = "horário não confirmado";
    else if (start - AUCTION_PREPARE_MS > now) reason = "aguardando janela de 30 minutos";
    else if (start <= now && day.format(start) !== day.format(now) && auction.status !== "live") reason = "leilão antigo sem atividade confirmada";
    return { auction, url, due: reason === "pronto", reason };
  }).sort((a, b) => AUCTION_SOURCES.indexOf(a.auction.source) - AUCTION_SOURCES.indexOf(b.auction.source)
    || dateMs(a.auction.startsAt) - dateMs(b.auction.startsAt) || a.auction.id.localeCompare(b.auction.id));
}

export function favoriteAuctionKey(userId: string, auction: FavoriteAuction): string {
  const start = dateMs(auction.startsAt);
  return JSON.stringify([userId, auction.id, Number.isFinite(start) ? day.format(start) : "unknown"]);
}
