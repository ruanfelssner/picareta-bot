import { FavoriteAuctionBrowser, AuctionLoginRequired } from "./favorite-auction-browser.js";
import { FavoriteAuctionEngine } from "./favorite-auction-engine.js";
import { AUCTION_POLL_MS } from "./favorite-auction-plan.js";
import { auctionWorkerDirectory, lockAuctionWorker, readAuctionWorkerConfig, writeAuctionWorkerJson } from "./favorite-auction-storage.js";

export function startFavoriteAuctionScheduler(log: (text: string) => void = console.log): { stop(): Promise<void> } {
  const directory = auctionWorkerDirectory();
  let browser: FavoriteAuctionBrowser | null = null;
  let engine: FavoriteAuctionEngine | null = null;
  let release: (() => Promise<void>) | null = null;
  let appUrl: string | null = null;
  let loginShown = false;
  let stopped = false;
  let running: Promise<void> | null = null;
  let lastMessage = "";
  const report = (message: string) => { if (message !== lastMessage) { log(`[leiloes-favoritos] ${message}`); lastMessage = message; } };
  const close = async () => {
    await browser?.closeBrowser().catch(() => undefined);
    browser = null; engine = null; appUrl = null; loginShown = false;
    await release?.().catch(() => undefined); release = null;
  };
  const tick = async () => {
    try {
      const config = await readAuctionWorkerConfig(directory);
      if (!config?.enabled) {
        await close();
        report("Agendamento desativado. Faça o teste com pnpm worker:auctions:setup e pnpm worker:auctions:preview; depois ative com pnpm worker:auctions:enable.");
        return;
      }
      if (appUrl && appUrl !== config.appUrl) await close();
      if (!browser) {
        release = await lockAuctionWorker(directory);
        if (!release) { report("Outra instância ou teste já usa o perfil local; aguardando."); return; }
        browser = await FavoriteAuctionBrowser.launch({ directory, appUrl: config.appUrl });
        appUrl = config.appUrl;
        engine = new FavoriteAuctionEngine(browser,
          jobs => writeAuctionWorkerJson(directory, "state.json", { updatedAt: new Date().toISOString(), jobs }),
          text => log(`[leiloes-favoritos] ${text}`));
        browser.context.once("close", () => { if (!stopped) report("Navegador encerrado; o agendamento será retomado na próxima consulta."); });
      }
      const snapshot = await browser.snapshot();
      loginShown = false;
      await engine!.tick(snapshot.userId, snapshot.auctions);
      report("Agenda consultada. Somente salas com favoritos, horário confirmado e dentro da janela serão abertas.");
    } catch (error) {
      if (error instanceof AuctionLoginRequired) {
        report("Login do Picareta necessário no navegador local; nenhuma sala nova será aberta até autenticar.");
        if (!loginShown && browser) {
          await browser.showAgenda().then(() => { loginShown = true; })
            .catch(() => report("Não foi possível abrir a agenda para login. Confira o navegador e a conexão; será tentado novamente."));
        }
      } else {
        report("Falha na consulta/abertura. Aguardando a próxima tentativa; confira conexão, configuração e Chromium instalado.");
        // Se o contexto foi fechado, liberar o perfil para recriá-lo no próximo minuto.
        if (!browser || !browser.context.browser()?.isConnected()) await close();
      }
    }
  };
  const run = () => {
    if (stopped || running) return;
    running = tick().finally(() => { running = null; });
  };
  const timer = setInterval(run, AUCTION_POLL_MS);
  run();
  return { async stop() { stopped = true; clearInterval(timer); await running; await close(); } };
}
