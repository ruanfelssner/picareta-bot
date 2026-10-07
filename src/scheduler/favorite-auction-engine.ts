import { AUCTION_RETRY_MS, MAX_AUCTION_PAGES, favoriteAuctionKey, planFavoriteAuctions, type FavoriteAuction } from "./favorite-auction-plan.js";

export type AuctionJobStatus = "preparing" | "room_open" | "login_required" | "collector_active" | "failed" | "finished";
export interface AuctionJob {
  key: string;
  userId: string;
  auctionId: string;
  source: string;
  label: string;
  startsAt: string | null;
  url: string;
  status: AuctionJobStatus;
  updatedAt: string;
  retryAt: number | null;
}
export interface AuctionRoomDriver {
  open(key: string, url: string): Promise<void>;
  close(key: string): Promise<void>;
  inspect(key: string, started: boolean): Promise<"room_open" | "login_required" | "collector_active" | "closed">;
  resetAccount(userId: string): Promise<void>;
}

/** Uma execução por vez; o lock do serviço protege outras instâncias e reinícios. */
export class FavoriteAuctionEngine {
  private busy = false;
  private userId: string | null = null;
  private active = new Set<string>();
  private opened = new Set<string>();
  private jobs = new Map<string, AuctionJob>();
  constructor(private driver: AuctionRoomDriver, private save: (jobs: AuctionJob[]) => Promise<void>, private log: (text: string) => void) {}

  async tick(userId: string, auctions: FavoriteAuction[], now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.driver.resetAccount(userId);
      if (this.userId !== userId) {
        this.userId = userId;
        this.active.clear(); this.opened.clear(); this.jobs.clear();
      }
      for (const [key, job] of this.jobs) {
        if (!this.active.has(key) && Date.parse(job.updatedAt) < now - 8 * 86_400_000) {
          this.jobs.delete(key); this.opened.delete(key);
        }
      }
      const decisions = planFavoriteAuctions(auctions, now);
      for (const { auction } of decisions) {
        const key = favoriteAuctionKey(userId, auction);
        for (const previousKey of this.active) {
          const previous = this.jobs.get(previousKey);
          if (previous && previous.auctionId === auction.id && previousKey !== key) {
            await this.driver.close(previousKey);
            this.active.delete(previousKey);
            previous.status = "finished";
            previous.updatedAt = new Date(now).toISOString();
          }
        }
      }
      // Só um encerramento explícito (ou fim conhecido) fecha abas; falha/agenda truncada não interrompe captura.
      for (const decision of decisions) {
        const key = favoriteAuctionKey(userId, decision.auction);
        if (decision.reason !== "encerrado" || !this.active.has(key)) continue;
        await this.driver.close(key);
        this.active.delete(key);
        const job = this.jobs.get(key);
        if (job) { job.status = "finished"; job.updatedAt = new Date(now).toISOString(); }
      }
      for (const { auction, url, due } of decisions) {
        if (!due || !url) continue;
        const key = favoriteAuctionKey(userId, auction);
        const previous = this.jobs.get(key);
        if (previous) previous.startsAt = auction.startsAt;
        if (this.active.has(key)) {
          if (previous && previous.url !== url) {
            await this.driver.open(key, url);
            previous.url = url;
          }
          const status = await this.driver.inspect(key, Date.parse(auction.startsAt!) <= now);
          if (status === "closed") { this.active.delete(key); continue; }
          if (previous && previous.status !== status) {
            previous.status = status; previous.updatedAt = new Date(now).toISOString();
            this.log(`${auction.label}: ${status === "login_required" ? "login necessário; confira a sala e o painel da extensão" : status === "collector_active" ? "coletor ativo no painel (entrega de eventos deve ser conferida na extensão)" : "sala aberta"}.`);
          }
          continue;
        }
        // Fechar uma aba manualmente não gera novas aberturas a cada minuto.
        if (this.opened.has(key) || (previous?.retryAt && previous.retryAt > now) || this.active.size >= MAX_AUCTION_PAGES) continue;
        const job: AuctionJob = { key, userId, auctionId: auction.id, source: auction.source, label: auction.label,
          startsAt: auction.startsAt, url, status: "preparing", updatedAt: new Date(now).toISOString(), retryAt: null };
        this.jobs.set(key, job);
        await this.save([...this.jobs.values()]);
        try {
          await this.driver.open(key, url);
          this.active.add(key); this.opened.add(key);
          const status = await this.driver.inspect(key, Date.parse(auction.startsAt!) <= now);
          job.status = status === "closed" ? "room_open" : status;
          this.log(`${auction.label}: sala aberta, ${auction.favoriteCount} favorito(s). ${job.status === "login_required" ? "Login necessário no navegador." : "Confira o painel da extensão."}`);
        } catch {
          // Nunca publicar exceções de navegador/HTTP: podem conter headers, cookies ou credenciais.
          await this.driver.close(key).catch(() => undefined);
          this.active.delete(key); this.opened.delete(key);
          job.status = "failed"; job.retryAt = now + AUCTION_RETRY_MS;
          this.log(`${auction.label}: falha ao abrir sala; nova tentativa em cinco minutos.`);
        }
      }
      await this.save([...this.jobs.values()]);
    } finally { this.busy = false; }
  }
}
