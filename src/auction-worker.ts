import { setTimeout as delay } from "node:timers/promises";
import { FavoriteAuctionBrowser, AuctionLoginRequired } from "./scheduler/favorite-auction-browser.js";
import { planFavoriteAuctions } from "./scheduler/favorite-auction-plan.js";
import { startFavoriteAuctionScheduler } from "./scheduler/favorite-auction-service.js";
import { DEFAULT_AUCTION_APP_URL, auctionAppUrl, auctionWorkerDirectory, lockAuctionWorker, readAuctionWorkerConfig, writeAuctionWorkerJson } from "./scheduler/favorite-auction-storage.js";

class AuctionWorkerCommandError extends Error {}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valid = ["--setup", "--dry-run", "--enable", "--disable", "--app-url"];
  const urlIndex = args.indexOf("--app-url");
  const flags = args.filter((_, index) => index !== urlIndex + 1 || urlIndex < 0);
  if (flags.some(arg => !valid.includes(arg)) || flags.filter(arg => arg !== "--app-url").length > 1 || (urlIndex >= 0 && !args[urlIndex + 1])) {
    throw new AuctionWorkerCommandError("Use --setup [--app-url URL], --dry-run, --enable, --disable ou nenhum argumento para acompanhar a agenda.");
  }
  if (urlIndex >= 0 && !args.includes("--setup")) throw new AuctionWorkerCommandError("--app-url deve ser usado com --setup.");
  const directory = auctionWorkerDirectory();
  const existing = await readAuctionWorkerConfig(directory);
  const appUrl = auctionAppUrl(urlIndex >= 0 ? args[urlIndex + 1]! : existing?.appUrl ?? DEFAULT_AUCTION_APP_URL);
  if (args.includes("--enable") || args.includes("--disable")) {
    if (!existing) throw new AuctionWorkerCommandError("Faça primeiro pnpm worker:auctions:setup.");
    const enabled = args.includes("--enable");
    await writeAuctionWorkerJson(directory, "config.json", { ...existing, enabled });
    console.log(enabled ? "Agendamento ativado. O worker acompanha a agenda a cada minuto." : "Agendamento desativado. O worker encerrará seu navegador na próxima consulta.");
    return;
  }
  if (args.includes("--setup") || args.includes("--dry-run")) {
    const release = await lockAuctionWorker(directory);
    if (!release) throw new AuctionWorkerCommandError("Outro worker usa o perfil. Desative o agendamento e aguarde um minuto, ou encerre o worker antes do teste.");
    let browser: FavoriteAuctionBrowser | null = null;
    try {
      browser = await FavoriteAuctionBrowser.launch({ directory, appUrl });
      if (args.includes("--setup")) {
        console.log("Entre no Picareta na janela aberta. A senha não será gravada em configuração. O agendamento ficará desativado até concluir o teste e ativar.");
        await browser.showAgenda();
        const deadline = Date.now() + 15 * 60_000;
        while (true) {
          try { await browser.snapshot(); break; }
          catch (error) {
            if (!(error instanceof AuctionLoginRequired)) throw new AuctionWorkerCommandError("Não foi possível consultar a agenda após o login. Confira a URL e a conexão.");
            if (Date.now() >= deadline) throw new AuctionWorkerCommandError("Tempo de configuração encerrado; execute setup novamente.");
            await delay(2_000);
          }
        }
        await writeAuctionWorkerJson(directory, "config.json", { appUrl, enabled: false });
        console.log("Login validado. Próximo passo: pnpm worker:auctions:preview. Nenhum leilão foi aberto.");
      } else {
        const snapshot = await browser.snapshot();
        const now = Date.now();
        const decisions = planFavoriteAuctions(snapshot.auctions, now);
        console.log(`SIMULAÇÃO da agenda real em ${new Date(now).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })} (Brasília). Nenhuma sala será aberta.`);
        console.table(decisions.map(({ auction, due, reason, url }) => ({ leilão: auction.label, favoritos: auction.favoriteCount ?? "indisponível",
          início: auction.startsAt && auction.timeKnown ? new Date(auction.startsAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "não confirmado",
          ação: due ? "ABRIRIA" : "AGUARDAR/IGNORAR", motivo: reason, link: url ?? "indisponível" })));
      }
    } finally { await browser?.closeBrowser().catch(() => undefined); await release(); }
    return;
  }
  const scheduler = startFavoriteAuctionScheduler();
  let stopping = false;
  const stop = () => { if (!stopping) { stopping = true; void scheduler.stop(); } };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  // Não imprimir objetos de erro provenientes de rede/navegador.
  console.error(error instanceof AuctionWorkerCommandError || error instanceof AuctionLoginRequired
    ? error.message
    : "Worker de leilões não iniciou. Confira a configuração local e o Chromium. Se o perfil estiver em uso, desative o agendamento e aguarde antes do setup/teste.");
  process.exitCode = 1;
});
