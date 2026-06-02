import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import {
  type MarketplaceResult
} from "./facebook-marketplace.js";
import { getMongoDataConfigFromEnv } from "./integrations/mongo.js";
import { getZApiConfigFromEnv } from "./integrations/zapi.js";
import {
  executeSearchRun
} from "./search-runner.js";
import {
  isResultSlightlyDistant,
  parseBoolean,
  parsePositiveInt
} from "./utils.js";

dotenv.config();

type OutputPayload = {
  searchTerm: string;
  collectedAt: string;
  total: number;
  results: MarketplaceResult[];
};

type AnalysisPayload = {
  searchTerm: string;
  collectedAt: string;
  semanticRuleName: string;
  totals: {
    collectedCandidates: number;
    acceptedResults: number;
    discardedByRelevance: number;
    rejectedByMatch: number;
  };
  candidates: MarketplaceResult[];
  accepted: MarketplaceResult[];
};

function slugifyTerm(value: string): string {
  const slug = value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "busca";
}

async function saveJsonFile(filePath: string, payload: unknown): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  await mkdir(path.dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, JSON.stringify(payload, null, 2), "utf-8");
}

function getSearchTerm(): string {
  const fromArgs = process.argv.slice(2).join(" ").trim();
  if (fromArgs) {
    return fromArgs;
  }

  return (process.env.SEARCH_TERM ?? "").trim();
}

async function askSearchTerm(): Promise<string> {
  const envTerm = (process.env.SEARCH_TERM ?? "").trim();
  const baseTerm = getSearchTerm();
  if (baseTerm && process.argv.slice(2).join(" ").trim()) {
    return baseTerm;
  }

  const rl = createInterface({ input, output });
  try {
    const prompt = envTerm
      ? `Digite o termo de busca (ENTER para usar "${envTerm}"): `
      : "Digite o termo de busca: ";

    const answer = (await rl.question(prompt)).trim();
    return answer || envTerm;
  } finally {
    rl.close();
  }
}

function printTopResults(results: MarketplaceResult[], limit = 20): void {
  const top = results.slice(0, limit);

  for (let index = 0; index < top.length; index += 1) {
    const item = top[index];

    console.log(`${index + 1}. ${item.titleRaw || "(sem título detectado)"}`);
    console.log(`   Preço: ${item.priceRaw ?? "não identificado"}`);
    console.log(`   Local: ${item.locationRaw ?? "não identificado"}`);
    if (
      isResultSlightlyDistant({
        relevanceLevel: item.relevanceLevel,
        matchScore: item.matchScore,
        missingTokens: item.missingTokens
      })
    ) {
      console.log("   Aviso: resultado um pouco mais distante do que você selecionou.");
    }
    console.log(`   Link: ${item.url}`);
    console.log("");
  }
}

async function main(): Promise<void> {
  const searchTerm = await askSearchTerm();
  if (!searchTerm) {
    throw new Error("Nenhum termo de busca foi informado.");
  }

  const maxScrolls = parsePositiveInt(process.env.MAX_SCROLLS, 4);
  const headless = parseBoolean(process.env.HEADLESS, false);
  const profilePath = process.env.PROFILE_PATH?.trim() || "./data/facebook-profile";
  const outputPath = process.env.OUTPUT_PATH?.trim() || "./output/results.json";
  const mongoConfig = getMongoDataConfigFromEnv();
  const zApiConfig = { ...getZApiConfigFromEnv(), enabled: false };

  const {
    results,
    collectedCandidates,
    semanticRuleName,
    effectiveSearchTerm,
    conditionMode
  } = await executeSearchRun({
    searchTerm,
    maxScrolls,
    headless,
    profilePath,
    outputPath,
    mongoConfig,
    zApiConfig,
    log: (message) => console.log(message)
  });

  const collectedAt = new Date().toISOString();
  const outputPayload: OutputPayload = {
    searchTerm: effectiveSearchTerm,
    collectedAt,
    total: results.length,
    results
  };
  await saveJsonFile(outputPath, outputPayload);

  const discardedByRelevance = collectedCandidates.filter(
    (item) => item.relevanceLevel === "descartar"
  ).length;
  const rejectedByMatch = collectedCandidates.filter(
    (item) => item.relevanceLevel !== "descartar" && !item.matchApproved
  ).length;

  const analysisPayload: AnalysisPayload = {
    searchTerm: effectiveSearchTerm,
    collectedAt,
    semanticRuleName,
    totals: {
      collectedCandidates: collectedCandidates.length,
      acceptedResults: results.length,
      discardedByRelevance,
      rejectedByMatch
    },
    candidates: collectedCandidates,
    accepted: results
  };

  const stamp = collectedAt.replace(/[:.]/g, "-");
  const analysisPath = `./output/analysis/${stamp}-${slugifyTerm(effectiveSearchTerm)}.json`;
  await saveJsonFile(analysisPath, analysisPayload);

  console.log(`Condição aplicada: ${conditionMode}.`);
  console.log(`Encontrados ${results.length} anúncios únicos.`);
  console.log(`Resultado salvo em ${outputPath}`);
  console.log(`Log de análise salvo em ${analysisPath}`);
  console.log("");
  printTopResults(results, 20);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Erro: ${message}`);
  process.exitCode = 1;
});
