import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AUCTION_PREPARE_MS, MAX_AUCTION_PAGES, copartAuctionsWaitingForRoom, favoriteAuctionRoomUrl, parseFavoriteAuctionAgenda, planFavoriteAuctions, type FavoriteAuction } from "../src/scheduler/favorite-auction-plan.js";
import { copartCatalogAuctionId, findCopartRoomForCatalog } from "../shared/utils/copart-auction-room.js";
import { FavoriteAuctionEngine, type AuctionJob, type AuctionRoomDriver } from "../src/scheduler/favorite-auction-engine.js";
import { auctionAppUrl, lockAuctionWorker, readAuctionWorkerConfig, writeAuctionWorkerJson } from "../src/scheduler/favorite-auction-storage.js";

const start = Date.parse("2026-10-07T13:00:00.000Z"); // 10h em Brasília
const copartUrl = "https://www.copart.com.br/auctionDashboard?auctionDetails=53-9551&auctionId=112097";
const vipUrl = "https://www.vipleiloes.com.br/eventoonline/071026bsgo";
function auction(overrides: Partial<FavoriteAuction> = {}): FavoriteAuction {
  return { id: "copart-112097", source: "copart", label: "Copart", url: copartUrl, urlKind: "auction",
    startsAt: new Date(start).toISOString(), endsAt: null, timeKnown: true, status: "upcoming", favoriteCount: 2, locationStates: [], ...overrides };
}
function harness() {
  const opens: string[] = [], closes: string[] = [], accounts: string[] = [];
  let failure = false;
  let status: Awaited<ReturnType<AuctionRoomDriver["inspect"]>> = "login_required";
  let jobs: AuctionJob[] = [];
  const driver: AuctionRoomDriver = {
    async open(key) { if (failure) throw new Error("secret-cookie-must-not-be-logged"); opens.push(key); },
    async close(key) { closes.push(key); },
    async inspect() { return status; },
    async resetAccount(userId) { accounts.push(userId); },
  };
  const logs: string[] = [];
  const engine = new FavoriteAuctionEngine(driver, async state => { jobs = structuredClone(state); }, text => logs.push(text));
  return { engine, driver, opens, closes, accounts, logs, jobs: () => jobs, fail: (value: boolean) => { failure = value; }, status: (value: typeof status) => { status = value; } };
}

test("abre exatamente 30 minutos antes e reconcilia Windows iniciado depois do começo", () => {
  for (const delta of [-AUCTION_PREPARE_MS, -1, 0, 2 * 60 * 60_000]) assert.equal(planFavoriteAuctions([auction()], start + delta)[0]?.due, true);
  assert.equal(planFavoriteAuctions([auction()], start - AUCTION_PREPARE_MS - 1)[0]?.due, false);
});

test("Copart procura sala desde uma hora antes, mas ainda aguarda os trinta minutos para abrir", () => {
  const item = auction({ auctionId: "9551", url: null });
  assert.equal(copartAuctionsWaitingForRoom([item], start - 60 * 60_000 - 1).length, 0);
  assert.equal(copartAuctionsWaitingForRoom([item], start - 60 * 60_000).length, 1);
  assert.equal(planFavoriteAuctions([{ ...item, url: copartUrl }], start - 45 * 60_000)[0]?.due, false);
  assert.equal(planFavoriteAuctions([{ ...item, url: copartUrl }], start - 30 * 60_000)[0]?.due, true);
  for (const change of [{ favoriteCount: 0 }, { favoriteCount: null }, { timeKnown: false }, { auctionId: null }, { status: "finished" }, { url: copartUrl }]) {
    assert.equal(copartAuctionsWaitingForRoom([{ ...item, ...change }], start).length, 0);
  }
  assert.equal(copartAuctionsWaitingForRoom([item], start + 86_400_000).length, 0);
});

test("link Copart usa o catálogo do mesmo card sem confundir seu ID com o da sala", () => {
  const catalogUrl = "https://www.copart.com.br/saleListResult/auctionId/9551";
  const entries = [{ roomUrl: copartUrl, saleUrls: [catalogUrl] }];
  assert.equal(copartCatalogAuctionId(catalogUrl), "9551");
  assert.equal(copartCatalogAuctionId("https://www.copart.com.br/saleListResult/inventory/53"), null);
  assert.equal(copartCatalogAuctionId("https://evil.test/saleListResult/9551"), null);
  assert.deepEqual(findCopartRoomForCatalog(entries, "9551"), { roomUrl: copartUrl, catalogUrl });
  assert.equal(findCopartRoomForCatalog(entries, "112097"), null);
  assert.equal(findCopartRoomForCatalog([...entries, { roomUrl: copartUrl.replace("112097", "112098"), saleUrls: [catalogUrl] }], "9551"), null);
  assert.equal(findCopartRoomForCatalog([{ roomUrl: copartUrl, saleUrls: [] }], "9551"), null);
});

test("ignora favoritos zero/desconhecidos, horários ausentes, salas de lote e encerrados", () => {
  for (const change of [{ favoriteCount: 0 }, { favoriteCount: null }, { timeKnown: false }, { startsAt: "2026-10-07" },
    { startsAt: "2026-10-07T10:00:00" }, { startsAt: "invalid" }, { urlKind: "lot" }, { url: "https://www.copart.com.br/lot/123" },
    { status: "finished" }, { endsAt: new Date(start).toISOString() }]) {
    assert.equal(planFavoriteAuctions([auction(change)], start)[0]?.due, false, JSON.stringify(change));
  }
});

test("virada do dia brasileiro não mantém leilões antigos abertos por calendário", () => {
  const nextBrazilDay = Date.parse("2026-10-08T03:00:00Z");
  assert.equal(planFavoriteAuctions([auction({ status: "started" })], nextBrazilDay)[0]?.due, false);
  assert.equal(planFavoriteAuctions([auction({ status: "live" })], nextBrazilDay)[0]?.due, true);
  assert.equal(planFavoriteAuctions([auction({ startsAt: "2026-10-08T02:30:00Z" })], Date.parse("2026-10-08T02:45:00Z"))[0]?.due, true);
});

test("ordena Copart, Sodré e VIP PR; um evento VIP multirregional abre só uma sala", () => {
  const vip = auction({ id: "vip", source: "vipleiloes", url: vipUrl, locationStates: ["SP", "PR", "RS"] });
  const sodre = auction({ id: "sodre", source: "sodre", url: "https://leilao.sodresantoro.com.br/leilao/29125/" });
  assert.deepEqual(planFavoriteAuctions([vip, sodre, auction()], start).map(item => item.auction.source), ["copart", "sodre", "vipleiloes"]);
  assert.equal(planFavoriteAuctions([vip], start)[0]?.due, true);
  assert.equal(planFavoriteAuctions([{ ...vip, locationStates: ["SP", "RS"] }], start)[0]?.due, false);
});

test("aceita salas oficiais, preserva parâmetros Copart e bloqueia host, lote, login embutido e protocolo inseguros", () => {
  assert.equal(favoriteAuctionRoomUrl("copart", copartUrl), copartUrl);
  assert.equal(favoriteAuctionRoomUrl("vipleiloes", vipUrl), vipUrl);
  for (const bad of ["http://www.copart.com.br/auctionDashboard?auctionId=1", "https://www.copart.com.br:444/auctionDashboard?auctionId=1",
    "https://user:password@www.copart.com.br/auctionDashboard?auctionId=1", "https://copart.com.br.evil.test/auctionDashboard?auctionId=1",
    "https://www.copart.com.br/auctionDashboard?auctionId=cat-12", "javascript:alert(1)"]) assert.equal(favoriteAuctionRoomUrl("copart", bad), null);
  assert.equal(favoriteAuctionRoomUrl("sodre", "https://leilao.sodresantoro.com.br/leilao/29125/lote/1"), null);
  assert.equal(favoriteAuctionRoomUrl("vipleiloes", "https://www.vipleiloes.com.br/agenda"), null);
});

test("validação da API ignora fontes desconhecidas e não transforma erro em agenda vazia", () => {
  assert.throws(() => parseFavoriteAuctionAgenda({ error: "timeout" }));
  assert.deepEqual(parseFavoriteAuctionAgenda({ auctions: [null, {}, { ...auction(), source: "other" }] }), []);
  const rows = parseFavoriteAuctionAgenda({ auctions: [{ ...auction(), favoriteCount: "2" }, { ...auction(), favoriteCount: -1 }] });
  assert.deepEqual(rows.map(row => row.favoriteCount), [null, null]);
});

test("consultas repetidas, IDs duplicados e mudança de horário no mesmo dia não duplicam abas", async () => {
  const h = harness();
  await h.engine.tick("user-a", [auction(), auction()], start - AUCTION_PREPARE_MS);
  await h.engine.tick("user-a", [auction({ startsAt: new Date(start + 60_000).toISOString() })], start);
  await h.engine.tick("user-a", [auction()], start);
  assert.equal(h.opens.length, 1);
  assert.equal(h.jobs()[0]?.status, "login_required");
});

test("alteração do dia reprograma sem manter a sala anterior; mudança do link reaproveita o job", async () => {
  const h = harness();
  await h.engine.tick("user-a", [auction()], start);
  await h.engine.tick("user-a", [auction({ url: copartUrl.replace("112097", "112098") })], start);
  assert.equal(h.jobs()[0]?.url.includes("112098"), true);
  await h.engine.tick("user-a", [auction({ startsAt: new Date(start + 86_400_000).toISOString() })], start);
  assert.equal(h.closes.length, 1);
  assert.equal(h.opens.length, 2); // mudança de URL no mesmo job, não nova aba
  await h.engine.tick("user-a", [auction({ startsAt: new Date(start + 86_400_000).toISOString() })], start + 86_400_000);
  assert.equal(h.opens.length, 3);
});

test("encerramento fecha só a sala conhecida; agenda vazia/truncada não encerra coleta", async () => {
  const h = harness();
  await h.engine.tick("user-a", [auction()], start);
  await h.engine.tick("user-a", [], start + 60_000);
  assert.equal(h.closes.length, 0);
  await h.engine.tick("user-a", [auction({ status: "finished", favoriteCount: null, url: null })], start + 120_000);
  assert.equal(h.closes.length, 1);
  assert.equal(h.jobs()[0]?.status, "finished");
});

test("falha de navegação tem backoff, libera aba e não publica cookies/erro de navegador", async () => {
  const h = harness(); h.fail(true);
  await h.engine.tick("user-a", [auction()], start);
  assert.equal(h.jobs()[0]?.status, "failed");
  assert.equal(h.logs.some(text => text.includes("secret-cookie")), false);
  h.fail(false);
  await h.engine.tick("user-a", [auction()], start + 60_000);
  assert.equal(h.opens.length, 0);
  await h.engine.tick("user-a", [auction()], start + 5 * 60_000);
  assert.equal(h.opens.length, 1);
});

test("um limite de seis salas não perde os próximos jobs e fechamento manual não reabre a mesma sala", async () => {
  const h = harness();
  const rows = Array.from({ length: MAX_AUCTION_PAGES + 1 }, (_, index) => auction({ id: `room-${index}` }));
  await h.engine.tick("user-a", rows, start);
  assert.equal(h.opens.length, MAX_AUCTION_PAGES);
  h.status("closed");
  await h.engine.tick("user-a", rows, start + 60_000);
  assert.equal(h.opens.length, MAX_AUCTION_PAGES + 1);
  await h.engine.tick("user-a", rows, start + 120_000);
  assert.equal(h.opens.length, MAX_AUCTION_PAGES + 1);
});

test("troca de usuário limpa jobs e reinício reconcilia uma sala ativa novamente", async () => {
  const h = harness();
  await h.engine.tick("user-a", [auction()], start);
  await h.engine.tick("user-b", [auction({ favoriteCount: 0 })], start);
  assert.deepEqual(h.accounts, ["user-a", "user-b"]);
  assert.equal(h.jobs().length, 0);
  const restarted = new FavoriteAuctionEngine(h.driver, async () => {}, () => {});
  await restarted.tick("user-a", [auction()], start + 60_000);
  assert.equal(h.opens.length, 2);
});

test("poll concorrente não dispara duas aberturas", async () => {
  const h = harness();
  await Promise.all([h.engine.tick("user-a", [auction()], start), h.engine.tick("user-a", [auction()], start)]);
  assert.equal(h.opens.length, 1);
});

test("lock bloqueia segunda instância, libera ao encerrar e não rouba arquivo incompleto", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "favorite-auction-lock-"));
  try {
    const release = await lockAuctionWorker(directory);
    assert.ok(release);
    assert.equal(await lockAuctionWorker(directory), null);
    await release();
    const second = await lockAuctionWorker(directory); assert.ok(second); await second();
    await writeFile(path.join(directory, "worker.lock"), "");
    assert.equal(await lockAuctionWorker(directory), null);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("configuração mantém ativação explícita, grava atomicamente e rejeita credenciais em URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "favorite-auction-config-"));
  try {
    assert.equal(await readAuctionWorkerConfig(directory), null);
    await writeAuctionWorkerJson(directory, "config.json", { appUrl: "https://felssner.com.br/leiloes", enabled: false });
    assert.deepEqual(await readAuctionWorkerConfig(directory), { appUrl: "https://felssner.com.br", enabled: false });
    assert.equal((await readFile(path.join(directory, "config.json"), "utf8")).includes("password"), false);
    assert.throws(() => auctionAppUrl("https://user:password@felssner.com.br"));
    assert.throws(() => auctionAppUrl("http://felssner.com.br"));
    assert.equal(auctionAppUrl("http://localhost:3000/leiloes"), "http://localhost:3000");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("reinícios concorrentes recuperam lock de processo morto com apenas um vencedor", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "favorite-auction-stale-"));
  try {
    await writeFile(path.join(directory, "worker.lock"), JSON.stringify({ pid: 2147483647, nonce: "dead-worker" }));
    const releases = await Promise.all(Array.from({ length: 20 }, () => lockAuctionWorker(directory)));
    const winners = releases.filter((release): release is () => Promise<void> => Boolean(release));
    assert.equal(winners.length, 1);
    await winners[0]!();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
