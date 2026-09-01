import type { MarketplaceResult } from "../facebook-marketplace.js";
import {
  extractListingAge,
  formatCentsToBrl,
  isLocationOutsideParana,
  parseBoolean,
  parsePositiveInt,
  parsePriceToCents
} from "../utils.js";

export type ZApiConfig = {
  enabled: boolean;
  baseUrl: string;
  instanceId: string;
  token: string;
  clientToken: string;
  phone: string;
  maxImages: number;
  delayMessage: number;
  viewOnce: boolean;
};

export type ZApiDispatchLog = {
  url: string;
  title: string;
  image: string | null;
  status: "sent" | "skipped" | "error";
  destination: string;
  searchTerm: string;
  priceRaw: string | null;
  priceCents: number | null;
  sendReason: "first_time" | "price_drop" | null;
  collectedAt: string;
  reason?: string;
  response?: unknown;
};

export type ZApiDispatchReport = {
  enabled: boolean;
  attempted: number;
  sent: number;
  skipped: number;
  failed: number;
  logs: ZApiDispatchLog[];
};

export type ZApiSendReason = "first_time" | "price_drop";

export type ZApiSendInstruction = {
  item: MarketplaceResult;
  sendReason: ZApiSendReason;
  previousPriceRaw: string | null;
  previousPriceCents: number | null;
  priceDropCents: number | null;
  priceDropPercent: number | null;
};

type ZApiTextSendResult = {
  ok: boolean;
  response?: unknown;
  reason?: string;
};

export type ZApiTextDispatchResult = {
  enabled: boolean;
  ok: boolean;
  reason?: string;
  response?: unknown;
};

export type ZApiImageDispatchResult = {
  enabled: boolean;
  ok: boolean;
  reason?: string;
  response?: unknown;
};

const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function formatRelevance(level: MarketplaceResult["relevanceLevel"]): string {
  if (level === "alta") return "Alta";
  if (level === "media") return "Média";
  if (level === "baixa") return "Baixa";
  return "N/D";
}

function buildCaption(instruction: ZApiSendInstruction): string {
  const item = instruction.item;
  const title = truncate(item.titleRaw || "(sem título)", 120);
  const price = item.priceRaw ?? "-";
  const location = item.locationRaw ?? "-";
  const listingAge = extractListingAge(item.rawText);
  const relevance = formatRelevance(item.relevanceLevel);
  const isOutsideParana = isLocationOutsideParana(item.locationRaw);
  const dropLine =
    instruction.sendReason === "price_drop"
      ? (() => {
          const before =
            instruction.previousPriceRaw ?? formatCentsToBrl(instruction.previousPriceCents) ?? "N/D";
          const now = item.priceRaw ?? formatCentsToBrl(parsePriceToCents(item.priceRaw)) ?? "N/D";
          const dropValue = formatCentsToBrl(instruction.priceDropCents);
          const dropPercent =
            instruction.priceDropPercent != null
              ? ` (${instruction.priceDropPercent.toFixed(1)}%)`
              : "";

          return `📉 ${before} → ${now}${dropValue ? ` | ${dropValue}${dropPercent}` : ""}`;
        })()
      : null;

  const lines = [
    `*${title}*`,
    `💰 ${price}`,
    `📍 ${location}${isOutsideParana ? " ⚠️ um pouco mais distante" : ""}`,
    `📊 ${relevance}`,
    `🔗 ${item.url}`
  ];

  if (listingAge) {
    lines.splice(4, 0, `🕒 ${listingAge}`);
  }

  if (dropLine) lines.push(dropLine);

  return lines.join("\n");
}

export function getZApiConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ZApiConfig {
  const baseUrl = (env.ZAPI_BASE_URL ?? "https://api.z-api.io").trim().replace(/\/$/, "");
  const instanceId = (env.ZAPI_INSTANCE_ID ?? env.Z_INSTANCE ?? "").trim();
  const token = (env.ZAPI_TOKEN ?? env.Z_TOKEN ?? "").trim();
  const clientToken = (env.ZAPI_CLIENT_TOKEN ?? env.Z_CLIENT_TOKEN ?? "").trim();
  const phone = (env.ZAPI_PHONE ?? env.Z_PHONE ?? "").trim();
  const hasCredentials = Boolean(instanceId && token && clientToken && phone);
  const enabled = parseBoolean(env.ZAPI_ENABLED, hasCredentials);
  const maxImages = clampInt(parsePositiveInt(env.ZAPI_MAX_IMAGES, 5), 1, 20);
  const delayMessage = clampInt(parsePositiveInt(env.ZAPI_DELAY_MESSAGE, 2), 1, 15);
  const viewOnce = parseBoolean(env.ZAPI_VIEW_ONCE, false);

  return {
    enabled,
    baseUrl,
    instanceId,
    token,
    clientToken,
    phone,
    maxImages,
    delayMessage,
    viewOnce
  };
}

function validateZApiConfig(
  config: ZApiConfig,
  options?: { allowEmptyPhone?: boolean }
): string | null {
  if (!config.enabled) {
    return null;
  }

  if (!config.instanceId || !config.token || !config.clientToken) {
    return "Z-API habilitada, mas faltam envs obrigatórias (instance/token/client-token).";
  }

  if (!options?.allowEmptyPhone && !config.phone) {
    return "Z-API habilitada, mas faltam envs obrigatórias (instance/token/client-token/phone ou groupId).";
  }

  return null;
}

function parseApiResponse(responseText: string): unknown {
  if (!responseText.trim()) {
    return null;
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

async function sendTextToZApi(
  config: ZApiConfig,
  message: string,
  phoneOverride?: string
): Promise<ZApiTextSendResult> {
  const targetPhone = (phoneOverride ?? config.phone).trim();
  const endpoint = `${config.baseUrl}/instances/${encodeURIComponent(config.instanceId)}/token/${encodeURIComponent(config.token)}/send-text`;
  const body = {
    phone: targetPhone,
    message,
    delayMessage: config.delayMessage
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Client-Token": config.clientToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const responseText = await response.text();
    const parsedResponse = parseApiResponse(responseText);

    if (!response.ok) {
      return {
        ok: false,
        reason: `HTTP ${response.status}`,
        response: parsedResponse
      };
    }

    return {
      ok: true,
      response: parsedResponse
    };
  } catch (error) {
    const messageError = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason: messageError
    };
  }
}

export async function sendTextMessageToZApi(
  config: ZApiConfig,
  input: { message: string; phone?: string }
): Promise<ZApiTextDispatchResult> {
  const validationError = validateZApiConfig(config, { allowEmptyPhone: true });
  if (validationError) {
    return {
      enabled: false,
      ok: false,
      reason: validationError
    };
  }

  if (!config.enabled) {
    return {
      enabled: false,
      ok: false,
      reason: "Z-API desabilitada"
    };
  }

  const targetPhone = (input.phone ?? config.phone).trim();
  if (!targetPhone) {
    return {
      enabled: true,
      ok: false,
      reason: "Destino (phone/groupId) não informado."
    };
  }

  const sendResult = await sendTextToZApi(config, input.message, targetPhone);
  return {
    enabled: true,
    ok: sendResult.ok,
    reason: sendResult.reason,
    response: sendResult.response
  };
}

export async function sendImageMessageToZApi(
  config: ZApiConfig,
  input: { image: string; caption: string; phone?: string }
): Promise<ZApiImageDispatchResult> {
  const validationError = validateZApiConfig(config, { allowEmptyPhone: true });
  if (validationError) {
    return { enabled: false, ok: false, reason: validationError };
  }

  if (!config.enabled) {
    return { enabled: false, ok: false, reason: "Z-API desabilitada" };
  }

  const targetPhone = (input.phone ?? config.phone).trim();
  if (!targetPhone) {
    return { enabled: true, ok: false, reason: "Destino (phone/groupId) não informado." };
  }

  const endpoint = `${config.baseUrl}/instances/${encodeURIComponent(config.instanceId)}/token/${encodeURIComponent(config.token)}/send-image`;

  const sendImage = async (image: string): Promise<ZApiImageDispatchResult> => {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Client-Token": config.clientToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          phone: targetPhone,
          image,
          caption: input.caption,
          delayMessage: config.delayMessage,
          viewOnce: config.viewOnce
        })
      });

      const responseText = await response.text();
      const parsedResponse = parseApiResponse(responseText);
      if (!response.ok) {
        return { enabled: true, ok: false, reason: `HTTP ${response.status}`, response: parsedResponse };
      }
      return { enabled: true, ok: true, response: parsedResponse };
    } catch (error) {
      return { enabled: true, ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  if (input.image.startsWith("data:")) {
    return sendImage(input.image);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const parsedUrl = new URL(input.image);
    const imageResponse = await fetch(input.image, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        Accept: "image/*,*/*;q=0.8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
        Referer: `${parsedUrl.origin}/`
      }
    });

    if (imageResponse.ok && (imageResponse.headers.get("content-type") ?? "").toLowerCase().startsWith("image/")) {
      const bytes = Buffer.from(await imageResponse.arrayBuffer());
      if (bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES) {
        const contentType = imageResponse.headers.get("content-type")?.split(";", 1)[0] ?? "image/jpeg";
        const base64Result = await sendImage(`data:${contentType};base64,${bytes.toString("base64")}`);
        if (base64Result.ok) return base64Result;
      }
    }
  } catch {
    // A falha ao baixar a imagem não impede a tentativa pela URL original.
  } finally {
    clearTimeout(timeout);
  }

  return sendImage(input.image);
}

function buildMediumListMessage(instructions: ZApiSendInstruction[]): string {
  const lines = ["Resultados um pouco mais distantes do que você selecionou:"];

  for (let index = 0; index < instructions.length; index += 1) {
    const item = instructions[index].item;
    const title = truncate(item.titleRaw || "(sem título)", 90);
    const price = item.priceRaw ?? "-";
    lines.push(`${index + 1}. ${title} - ${price} - ${item.url}`);
  }

  return lines.join("\n");
}

export async function sendMediumResultsListToZApi(
  config: ZApiConfig,
  instructions: ZApiSendInstruction[]
): Promise<ZApiDispatchReport> {
  if (!config.enabled) {
    return {
      enabled: false,
      attempted: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      logs: []
    };
  }

  if (instructions.length === 0) {
    return {
      enabled: true,
      attempted: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      logs: []
    };
  }

  const message = buildMediumListMessage(instructions);
  const sendResult = await sendTextToZApi(config, message);

  const logs: ZApiDispatchLog[] = instructions.map((instruction) => {
    const item = instruction.item;
    return {
      url: item.url,
      title: item.titleRaw,
      image: item.image,
      destination: config.phone,
      searchTerm: item.searchTerm,
      priceRaw: item.priceRaw,
      priceCents: parsePriceToCents(item.priceRaw),
      sendReason: instruction.sendReason,
      collectedAt: item.collectedAt,
      status: sendResult.ok ? "sent" : "error",
      reason: sendResult.ok ? "sent_as_medium_list" : sendResult.reason,
      response: sendResult.response
    };
  });

  return {
    enabled: true,
    attempted: instructions.length,
    sent: sendResult.ok ? instructions.length : 0,
    skipped: 0,
    failed: sendResult.ok ? 0 : instructions.length,
    logs
  };
}

export async function sendResultsToZApi(
  config: ZApiConfig,
  instructions: ZApiSendInstruction[]
): Promise<ZApiDispatchReport> {
  const validationError = validateZApiConfig(config);
  if (validationError) {
    return {
      enabled: false,
      attempted: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      logs: [
        {
          url: "",
          title: "",
          image: null,
          destination: config.phone,
          searchTerm: "",
          priceRaw: null,
          priceCents: null,
          sendReason: null,
          collectedAt: new Date().toISOString(),
          status: "error",
          reason: validationError
        }
      ]
    };
  }

  if (!config.enabled) {
    return {
      enabled: false,
      attempted: 0,
      sent: 0,
      skipped: 0,
      failed: 0,
      logs: []
    };
  }

  const candidates = instructions.slice(0, config.maxImages);
  const logs: ZApiDispatchLog[] = [];
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (let index = 0; index < candidates.length; index += 1) {
    const instruction = candidates[index];
    const item = instruction.item;

    if (!item.image) {
      skipped += 1;
      logs.push({
        url: item.url,
        title: item.titleRaw,
        image: null,
        destination: config.phone,
        searchTerm: item.searchTerm,
        priceRaw: item.priceRaw,
        priceCents: parsePriceToCents(item.priceRaw),
        sendReason: instruction.sendReason,
        collectedAt: item.collectedAt,
        status: "skipped",
        reason: "Anúncio sem imagem"
      });
      continue;
    }

    const endpoint = `${config.baseUrl}/instances/${encodeURIComponent(config.instanceId)}/token/${encodeURIComponent(config.token)}/send-image`;
    const body = {
      phone: config.phone,
      image: item.image,
      caption: buildCaption(instruction),
      delayMessage: config.delayMessage,
      viewOnce: config.viewOnce
    };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Client-Token": config.clientToken,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });

      const responseText = await response.text();
      const parsedResponse = parseApiResponse(responseText);

      if (!response.ok) {
        failed += 1;
        logs.push({
          url: item.url,
          title: item.titleRaw,
          image: item.image,
          destination: config.phone,
          searchTerm: item.searchTerm,
          priceRaw: item.priceRaw,
          priceCents: parsePriceToCents(item.priceRaw),
          sendReason: instruction.sendReason,
          collectedAt: item.collectedAt,
          status: "error",
          reason: `HTTP ${response.status}`,
          response: parsedResponse
        });
        continue;
      }

      sent += 1;
      logs.push({
        url: item.url,
        title: item.titleRaw,
        image: item.image,
        destination: config.phone,
        searchTerm: item.searchTerm,
        priceRaw: item.priceRaw,
        priceCents: parsePriceToCents(item.priceRaw),
        sendReason: instruction.sendReason,
        collectedAt: item.collectedAt,
        status: "sent",
        response: parsedResponse
      });
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logs.push({
        url: item.url,
        title: item.titleRaw,
        image: item.image,
        destination: config.phone,
        searchTerm: item.searchTerm,
        priceRaw: item.priceRaw,
        priceCents: parsePriceToCents(item.priceRaw),
        sendReason: instruction.sendReason,
        collectedAt: item.collectedAt,
        status: "error",
        reason: message
      });
    }
  }

  return {
    enabled: true,
    attempted: candidates.length,
    sent,
    skipped,
    failed,
    logs
  };
}
