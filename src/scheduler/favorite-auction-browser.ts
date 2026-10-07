import { chromium, type BrowserContext, type LaunchOptions, type Page } from "playwright";
import path from "node:path";
import { AUCTION_SOURCES, favoriteAuctionRoomUrl, parseFavoriteAuctionAgenda, type FavoriteAuction } from "./favorite-auction-plan.js";
import type { AuctionRoomDriver } from "./favorite-auction-engine.js";

export class AuctionLoginRequired extends Error {}
export interface AuctionSnapshot { userId: string; auctions: FavoriteAuction[] }
export interface AuctionBrowserOptions {
  directory: string;
  appUrl: string;
  launch?: LaunchOptions;
  extensionPath?: string;
}

export class FavoriteAuctionBrowser implements AuctionRoomDriver {
  private pages = new Map<string, Page>();
  private userId: string | null = null;
  private control: Page | null = null;
  constructor(readonly context: BrowserContext, private appUrl: string) {}

  static async launch(options: AuctionBrowserOptions): Promise<FavoriteAuctionBrowser> {
    const extension = options.extensionPath ?? path.resolve(".extension/copart-live-collector");
    // Chromium do Playwright permite carregar a extensão local; Chrome/Edge atuais não permitem esses flags.
    const context = await chromium.launchPersistentContext(path.join(options.directory, "browser"), {
      headless: false, channel: "chromium", locale: "pt-BR", timezoneId: "America/Sao_Paulo", viewport: null,
      ...options.launch,
      args: [...(options.launch?.args ?? []), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    try {
      const worker = context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"))
        ?? await context.waitForEvent("serviceworker", { predicate: item => item.url().startsWith("chrome-extension://"), timeout: 15_000 });
      if (!worker) throw new Error("Extensão não carregada.");
      return new FavoriteAuctionBrowser(context, options.appUrl);
    } catch {
      await context.close();
      throw new Error("Não foi possível carregar a extensão local no Chromium do worker.");
    }
  }

  async showAgenda(): Promise<void> {
    if (!this.control || this.control.isClosed()) this.control = this.context.pages().find(page => page.url() === "about:blank") ?? await this.context.newPage();
    await this.control.goto(`${this.appUrl}/leiloes`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  }

  private async currentUser(): Promise<string> {
    const response = await this.context.request.get(`${this.appUrl}/api/v1/auth/me`, { timeout: 30_000, maxRedirects: 0 });
    try {
      if ([401, 403].includes(response.status())) throw new AuctionLoginRequired("Entre no Picareta neste navegador.");
      if (!response.ok()) throw new Error("Falha ao validar sessão do Picareta.");
      const data: unknown = await response.json();
      if (!data || typeof data !== "object" || !("user" in data) || !data.user || typeof data.user !== "object"
        || !("id" in data.user) || typeof data.user.id !== "string" || !data.user.id) throw new Error("Sessão do Picareta inválida.");
      return data.user.id;
    } finally { await response.dispose(); }
  }

  async snapshot(): Promise<AuctionSnapshot> {
    const userId = await this.currentUser();
    const response = await this.context.request.get(`${this.appUrl}/api/v1/auction-schedules`, { timeout: 30_000, maxRedirects: 0 });
    try {
      if ([401, 403].includes(response.status())) throw new AuctionLoginRequired("Sessão expirada; entre novamente no Picareta.");
      if (!response.ok()) throw new Error("Agenda do Picareta indisponível.");
      const data: unknown = await response.json();
      // Uma agenda servida de cache antigo não pode disparar o navegador.
      const generated = data && typeof data === "object" && "meta" in data && data.meta && typeof data.meta === "object"
        && "generatedAt" in data.meta && typeof data.meta.generatedAt === "string" ? Date.parse(data.meta.generatedAt) : NaN;
      const age = Date.now() - generated;
      if (!Number.isFinite(age) || age < -60_000 || age > 120_000) throw new Error("Agenda sem confirmação recente.");
      const auctions = parseFavoriteAuctionAgenda(data);
      if (await this.currentUser() !== userId) throw new Error("Conta alterada durante a leitura da agenda; aguarde a próxima consulta.");
      return { userId, auctions };
    } finally { await response.dispose(); }
  }

  async resetAccount(userId: string): Promise<void> {
    if (this.userId !== userId) {
      for (const key of this.pages.keys()) await this.close(key);
      this.userId = userId;
    }
    // Se a extensão estiver ligada a outra conta, exigir seu login novamente antes da coleta.
    const worker = this.context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"));
    const changed = worker ? await worker.evaluate(async (expectedUserId) => {
      const extension = (globalThis as unknown as { chrome: { storage: { local: {
        get(key: string): Promise<Record<string, unknown>>;
        remove(keys: string[]): Promise<void>;
      } } } }).chrome;
      const data = await extension.storage.local.get("picaretaExtensionUser");
      const user = data.picaretaExtensionUser;
      if (user && typeof user === "object" && "id" in user && user.id !== expectedUserId) {
        await extension.storage.local.remove(["picaretaExtensionUser", "picaretaExtensionAccessToken", "picaretaExtensionExpiresAt"]);
        return true;
      }
      return false;
    }, userId) : false;
    if (changed) {
      for (const page of this.pages.values()) if (!page.isClosed()) await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    }
  }

  async open(key: string, url: string): Promise<void> {
    const existing = this.pages.get(key);
    if (existing && !existing.isClosed() && existing.url() === url) return;
    const page = existing && !existing.isClosed() ? existing : await this.context.newPage();
    this.pages.set(key, page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    await page.bringToFront();
  }

  async close(key: string): Promise<void> {
    const page = this.pages.get(key);
    this.pages.delete(key);
    if (page && !page.isClosed()) await page.close();
  }

  async inspect(key: string, started: boolean): Promise<"room_open" | "login_required" | "collector_active" | "closed"> {
    const page = this.pages.get(key);
    if (!page || page.isClosed()) return "closed";
    const worker = this.context.serviceWorkers().find(item => item.url().startsWith("chrome-extension://"));
    const extensionUserId = worker ? await worker.evaluate(async () => {
      const extension = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome;
      const data = await extension.storage.local.get("picaretaExtensionUser");
      const user = data.picaretaExtensionUser;
      return user && typeof user === "object" && "id" in user && typeof user.id === "string" ? user.id : null;
    }) : null;
    if (extensionUserId !== this.userId) return "login_required";
    for (const frame of page.frames()) {
      const password = frame.locator('input[type="password"]:visible');
      if (await password.count()) return "login_required";
      const panel = frame.locator(".clp-root").first();
      if (!await panel.count()) continue;
      if (await panel.locator('[data-role="auth-panel"]').isVisible()) return "login_required";
      const toggle = panel.locator('[data-role="toggle-active"]');
      if (!await toggle.count()) continue;
      // Usuário comum já coleta automaticamente; para admin aciona o controle existente após o início.
      const title = await toggle.getAttribute("title");
      const inOfficialRoom = AUCTION_SOURCES.some(source => favoriteAuctionRoomUrl(source, page.url()));
      if (started && inOfficialRoom && title?.startsWith("Ativar coleta") && await toggle.isVisible()) await toggle.click({ timeout: 2_000 });
      if ((await toggle.getAttribute("title")) === "Desativar coleta") return "collector_active";
    }
    return "room_open";
  }

  async closeBrowser(): Promise<void> { await this.context.close(); }
}
