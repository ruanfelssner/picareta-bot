import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FavoriteAuctionBrowser, AuctionLoginRequired } from "../src/scheduler/favorite-auction-browser.js";
import { FavoriteAuctionEngine, type AuctionJob } from "../src/scheduler/favorite-auction-engine.js";
import { planFavoriteAuctions } from "../src/scheduler/favorite-auction-plan.js";

// Teste de navegador isolado: nenhum login, leilão ou envio externo real.
test("Chromium com extensão: login, favoritos, três salas, deduplicação, encerramento e conta isolada", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "favorite-auction-browser-"));
  const now = Date.now();
  let userId = "user-a";
  let state = "upcoming";
  let apiStatus = 200;
  let stale = false;
  const roomUrls = ["https://www.copart.com.br/auctionDashboard?auctionDetails=53-9551&auctionId=112097",
    "https://leilao.sodresantoro.com.br/leilao/29125/", "https://www.vipleiloes.com.br/eventoonline/071026bsgo"];
  const rows = ["copart", "sodre", "vipleiloes"].map((source, index) => ({ id: source, source, label: source,
    url: roomUrls[index], urlKind: "auction", startsAt: new Date(now + 15 * 60_000).toISOString(), endsAt: null,
    timeKnown: true, status: state, favoriteCount: 1, locationStates: source === "vipleiloes" ? ["SP", "PR"] : [] }));
  const server = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (!req.headers.cookie?.includes("picareta_auth=local-test-only")) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === "/api/v1/auth/me") { res.end(JSON.stringify({ user: { id: userId } })); return; }
    res.writeHead(apiStatus);
    res.end(JSON.stringify({ auctions: rows.map(row => ({ ...row, status: state })), meta: { generatedAt: new Date(stale ? now - 300_000 : Date.now()).toISOString() } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const appUrl = `http://127.0.0.1:${address.port}`;
  let browser: FavoriteAuctionBrowser | null = null;
  try {
    browser = await FavoriteAuctionBrowser.launch({ directory, appUrl, launch: { headless: true,
      ...(process.env.AUCTION_TEST_CHROMIUM ? { executablePath: process.env.AUCTION_TEST_CHROMIUM } : {}),
      args: ["--no-sandbox"] } });
    // Intercepta tudo no navegador; só a API localhost acima é acessada pelo request context.
    await browser.context.route("**/*", async route => {
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html><body><h1>Sala de teste</h1></body></html>" });
    });
    await assert.rejects(() => browser!.snapshot(), AuctionLoginRequired);
    await browser.context.addCookies([{ name: "picareta_auth", value: "local-test-only", url: appUrl }]);
    const snapshot = await browser.snapshot();
    assert.equal(snapshot.userId, "user-a");
    assert.equal(planFavoriteAuctions(snapshot.auctions, now).filter(row => row.due).length, 3);
    assert.equal(browser.context.pages().filter(page => roomUrls.includes(page.url())).length, 0); // dry-run
    let jobs: AuctionJob[] = [];
    const engine = new FavoriteAuctionEngine(browser, async state => { jobs = structuredClone(state); }, () => {});
    await engine.tick(snapshot.userId, snapshot.auctions, now);
    await engine.tick(snapshot.userId, snapshot.auctions, now);
    assert.deepEqual(browser.context.pages().map(page => page.url()).filter(url => roomUrls.includes(url)).sort(), [...roomUrls].sort());
    assert.ok(jobs.every(job => job.status === "login_required"));
    assert.ok(browser.context.serviceWorkers().some(worker => worker.url().startsWith("chrome-extension://")));
    const extensionWorker = browser.context.serviceWorkers().find(worker => worker.url().startsWith("chrome-extension://"))!;
    const setExtensionUser = async (id: string) => extensionWorker.evaluate(async (userId) => {
      const extension = (globalThis as unknown as { chrome: { storage: { local: { set(data: Record<string, unknown>): Promise<void> } } } }).chrome;
      await extension.storage.local.set({ picaretaExtensionUser: { id: userId } });
    }, id);
    await setExtensionUser("user-a");
    const copartPage = browser.context.pages().find(page => page.url() === roomUrls[0])!;
    // Controle de coleta simulado; não envia nenhum lote nem evento.
    await copartPage.evaluate(() => {
      document.querySelectorAll(".clp-root").forEach(root => root.remove());
      const panel = document.createElement("div"); panel.className = "clp-root";
      panel.innerHTML = '<section data-role="auth-panel" hidden></section><button data-role="toggle-active" title="Ativar coleta (somente leilão ao vivo)">Coletar</button>';
      panel.querySelector("button")!.addEventListener("click", event => (event.currentTarget as HTMLElement).setAttribute("title", "Desativar coleta"));
      document.body.append(panel);
    });
    const copartJob = jobs.find(job => job.source === "copart")!;
    assert.equal(await browser.inspect(copartJob.key, false), "room_open");
    assert.equal(await copartPage.locator('.clp-root [data-role="toggle-active"]').getAttribute("title"), "Ativar coleta (somente leilão ao vivo)");
    assert.equal(await browser.inspect(copartJob.key, true), "collector_active");
    await setExtensionUser("other-user");
    assert.equal(await browser.inspect(copartJob.key, true), "login_required");
    await browser.resetAccount("user-a");
    assert.equal(await extensionWorker.evaluate(async () => {
      const extension = (globalThis as unknown as { chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } } }).chrome;
      return Boolean((await extension.storage.local.get("picaretaExtensionUser")).picaretaExtensionUser);
    }), false);
    apiStatus = 503;
    await assert.rejects(() => browser!.snapshot());
    assert.equal(browser.context.pages().filter(page => roomUrls.includes(page.url())).length, 3);
    apiStatus = 200; stale = true;
    await assert.rejects(() => browser!.snapshot(), /confirmação recente/);
    stale = false; state = "finished";
    const finished = await browser.snapshot();
    await engine.tick(finished.userId, finished.auctions, now);
    assert.equal(browser.context.pages().filter(page => roomUrls.includes(page.url())).length, 0);
    state = "upcoming"; userId = "user-b";
    const next = await browser.snapshot();
    await engine.tick(next.userId, next.auctions, now);
    assert.equal(browser.context.pages().filter(page => roomUrls.includes(page.url())).length, 3);
    await browser.context.clearCookies();
    await assert.rejects(() => browser!.snapshot(), AuctionLoginRequired);
    await browser.context.addCookies([{ name: "picareta_auth", value: "local-test-only", url: appUrl, expires: Date.now() / 1000 + 3600 }]);
    await browser.closeBrowser();
    browser = await FavoriteAuctionBrowser.launch({ directory, appUrl, launch: { headless: true,
      ...(process.env.AUCTION_TEST_CHROMIUM ? { executablePath: process.env.AUCTION_TEST_CHROMIUM } : {}), args: ["--no-sandbox"] } });
    assert.equal((await browser.snapshot()).userId, "user-b");
    assert.equal(browser.context.pages().filter(page => roomUrls.includes(page.url())).length, 0);
  } finally {
    await browser?.closeBrowser();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("Copart sem sala na coleta inicial: descobre liberação tardia, atualiza agenda e abre só a sala certa", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "copart-room-late-"));
  const roomUrl = "https://www.copart.com.br/auctionDashboard?auctionDetails=53-9551&auctionId=112097";
  const catalogUrl = "https://www.copart.com.br/saleListResult/auctionId/9551";
  const now = Date.now();
  let published = false;
  let savedUrl: string | null = null;
  let writes = 0;
  const row = { id: "a".repeat(32), source: "copart", label: "Copart 13h", auctionId: "9551", urlKind: "auction",
    startsAt: new Date(now + 30 * 60_000 - 5_000).toISOString(), endsAt: null, timeKnown: true, status: "upcoming", favoriteCount: 1 };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (!req.headers.cookie?.includes("picareta_auth=local-test-only")) { res.writeHead(401); res.end('{}'); return; }
    if (req.url === "/api/v1/auth/me") { res.end(JSON.stringify({ user: { id: "user-a" } })); return; }
    if (req.method === "POST") {
      let body = ""; for await (const chunk of req) body += String(chunk);
      const data: unknown = JSON.parse(body);
      assert.deepEqual(data, { rooms: [{ scheduleId: row.id, roomUrl, catalogUrl }] });
      writes++; savedUrl = roomUrl; res.end('{"accepted":1}'); return;
    }
    res.end(JSON.stringify({ auctions: [{ ...row, url: savedUrl }], meta: { generatedAt: new Date().toISOString() } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const appUrl = `http://127.0.0.1:${address.port}`;
  let browser: FavoriteAuctionBrowser | null = null;
  try {
    browser = await FavoriteAuctionBrowser.launch({ directory, appUrl, launch: { headless: true,
      ...(process.env.AUCTION_TEST_CHROMIUM ? { executablePath: process.env.AUCTION_TEST_CHROMIUM } : {}), args: ["--no-sandbox"] } });
    await browser.context.route("**/*", async route => {
      const url = new URL(route.request().url());
      const listing = ["/todaysAuction/", "/auctionCalendar/"].includes(url.pathname);
      await route.fulfill({ status: 200, contentType: "text/html", body: published && listing
        ? `<html><body><table><tr><td><a href="${catalogUrl}">Ver lista</a><a href="${catalogUrl}">Ver todas as linhas</a></td><td><a href="${roomUrl.replaceAll('&', '&amp;')}">Entrar no leilão</a></td></tr></table></body></html>`
        : '<html><body><p>Aguardando liberação</p></body></html>' });
    });
    await browser.context.addCookies([{ name: "picareta_auth", value: "local-test-only", url: appUrl }]);
    const initial = await browser.snapshot();
    assert.equal(initial.auctions[0]?.url, null);
    assert.equal(planFavoriteAuctions(initial.auctions, now)[0]?.due, false);
    const missing = await browser.resolveCopartRooms(initial, true, () => {});
    assert.equal(missing.auctions[0]?.url, null); assert.equal(writes, 0);
    published = true;
    const preview = await browser.resolveCopartRooms(initial, false, () => {});
    assert.equal(preview.auctions[0]?.url, roomUrl);
    assert.equal(writes, 0);
    assert.equal(browser.context.pages().filter(page => page.url() === roomUrl).length, 0);
    const resolved = await browser.resolveCopartRooms(initial, true, () => {});
    assert.equal(writes, 1); assert.equal(resolved.auctions[0]?.url, roomUrl);
    const engine = new FavoriteAuctionEngine(browser, async () => {}, () => {});
    await engine.tick(resolved.userId, resolved.auctions, now);
    await engine.tick(resolved.userId, resolved.auctions, now);
    assert.equal(browser.context.pages().filter(page => page.url() === roomUrl).length, 1);
    assert.equal(browser.context.pages().filter(page => page.url() === catalogUrl).length, 0);
  } finally {
    await browser?.closeBrowser();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
