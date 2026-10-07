import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export interface AuctionWorkerConfig { enabled: boolean; appUrl: string }
export const DEFAULT_AUCTION_APP_URL = "https://felssner.com.br";
export const auctionWorkerDirectory = () => path.resolve("data/auction-worker");

export function auctionAppUrl(value: string): string {
  const url = new URL(value);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) || url.username || url.password) {
    throw new Error("Use uma URL HTTPS do Picareta, sem credenciais, ou localhost para teste.");
  }
  return url.origin;
}

export async function readAuctionWorkerConfig(directory: string): Promise<AuctionWorkerConfig | null> {
  let raw: string;
  try { raw = await readFile(path.join(directory, "config.json"), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  const config: unknown = JSON.parse(raw);
  if (!config || typeof config !== "object" || !("appUrl" in config) || typeof config.appUrl !== "string" || !("enabled" in config) || typeof config.enabled !== "boolean") {
    throw new Error("Configuração local do worker de leilões inválida.");
  }
  return { appUrl: auctionAppUrl(config.appUrl), enabled: config.enabled };
}

export async function writeAuctionWorkerJson(directory: string, name: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, name);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(() => undefined); }
}

/** Lock de processo local: nunca roubar um lock cuja identidade ainda não pode ser lida. */
export async function lockAuctionWorker(directory: string): Promise<(() => Promise<void>) | null> {
  await mkdir(directory, { recursive: true });
  const filename = path.join(directory, "worker.lock");
  const nonce = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(filename, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, nonce })); }
      finally { await handle.close(); }
      return async () => {
        const current: unknown = JSON.parse(await readFile(filename, "utf8"));
        if (current && typeof current === "object" && "nonce" in current && current.nonce === nonce) await unlink(filename);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let reclaim: Awaited<ReturnType<typeof open>> | null = null;
      try {
        // Só um processo remove locks órfãos. Reler depois de obter este segundo lock
        // impede que dois reinícios apaguem o lock novo um do outro.
        reclaim = await open(`${filename}.reclaim`, "wx", 0o600);
        const current: unknown = JSON.parse(await readFile(filename, "utf8"));
        if (!current || typeof current !== "object" || !("pid" in current) || typeof current.pid !== "number" || !Number.isInteger(current.pid) || current.pid <= 0) return null;
        try { process.kill(current.pid, 0); return null; }
        catch (probe) { if ((probe as NodeJS.ErrnoException).code !== "ESRCH") return null; }
        await unlink(filename);
      } catch { return null; }
      finally {
        if (reclaim) {
          await reclaim.close();
          await unlink(`${filename}.reclaim`).catch(() => undefined);
        }
      }
    }
  }
  return null;
}
