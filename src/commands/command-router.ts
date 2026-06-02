import type { MarketplaceCommandType } from "../integrations/mongo.js";

export type ParsedCommand = {
  commandType: MarketplaceCommandType;
  commandArg: string | null;
  raw: string;
};

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function stripPrefix(text: string, prefix: string): string {
  return text.slice(prefix.length).trim();
}

export function parseWhatsAppCommand(message: string): ParsedCommand | null {
  const trimmed = message.trim();
  const lower = normalize(trimmed);

  if (!lower.startsWith("/")) {
    return null;
  }

  // /buscar-pecas <termo> — marketplace (existente)
  if (lower.startsWith("/buscar-pecas")) {
    const arg = stripPrefix(trimmed, "/buscar-pecas");
    return { commandType: "SEARCH", commandArg: arg || null, raw: trimmed };
  }

  // /buscar — alias legacy para /buscar-pecas
  if (lower.startsWith("/buscar ")) {
    const arg = stripPrefix(trimmed, "/buscar");
    return { commandType: "SEARCH", commandArg: arg || null, raw: trimmed };
  }

  // /buscar-leilao — aciona scrapers de leilão
  if (lower.startsWith("/buscar-leilao")) {
    return { commandType: "AUCTION_SEARCH", commandArg: null, raw: trimmed };
  }

  // /buscar-fipe <placa> — consulta FIPE por placa
  if (lower.startsWith("/buscar-fipe")) {
    const arg = stripPrefix(trimmed, "/buscar-fipe").toUpperCase();
    return { commandType: "FIPE_LOOKUP", commandArg: arg || null, raw: trimmed };
  }

  // /buscar-contatos [categoria] — lista contatos
  if (lower.startsWith("/buscar-contatos")) {
    const arg = stripPrefix(trimmed, "/buscar-contatos") || null;
    return { commandType: "CONTACT_SEARCH", commandArg: arg, raw: trimmed };
  }

  // /inserir-contato [dados] — inserção de contato
  // Sem args: bot envia template. Com args (CATEGORIA | NOME | FONE | OBS): salva direto.
  if (lower.startsWith("/inserir-contato")) {
    const arg = stripPrefix(trimmed, "/inserir-contato") || null;
    return { commandType: "CONTACT_INSERT", commandArg: arg, raw: trimmed };
  }

  // /filtros — mostra configuração atual
  if (lower === "/filtros") {
    return { commandType: "CONFIG_UPDATE", commandArg: "show", raw: trimmed };
  }

  // /filtro locais <lista>
  // ex: /filtro locais Curitiba - PR, Canoas - RS
  if (lower.startsWith("/filtro ")) {
    const arg = stripPrefix(trimmed, "/filtro");
    return { commandType: "CONFIG_UPDATE", commandArg: arg, raw: trimmed };
  }

  // /parar — cancela busca em andamento
  if (lower === "/parar") {
    return { commandType: "STOP", commandArg: null, raw: trimmed };
  }

  return null;
}

export function formatCommandHelp(): string {
  return [
    "*Comandos disponíveis:*",
    "",
    "🔍 */buscar-pecas <termo>* — busca no Facebook Marketplace",
    "🚗 */buscar-leilao* — busca nos leilões (VS, Sodré, Copart, Favareto, Claudio Kuss)",
    "📋 */buscar-fipe <placa>* — consulta FIPE pela placa",
    "",
    "👥 */buscar-contatos [categoria]* — lista contatos",
    "➕ */inserir-contato* — cadastra novo contato",
    "   _Categorias: lataria · pneus · rodas · transmissao · motor · pecas · airbag · modulos · injecao · autocenter_",
    "",
    "⚙️ */filtros* — mostra filtros de leilão configurados",
    "⚙️ */filtro locais <lista>* — define locais (ex: Curitiba - PR, Canoas - RS)",
    "♻️ */filtro locais limpar* — remove trava de local do Copart",
    "🗺️ */filtro estados <lista>* — filtra por UF (ex: PR, SC)",
    "🏙️ */filtro cidades <lista>* — filtra por cidade (ex: Curitiba, Pinhais)",
    "♻️ */filtro estados|cidades limpar* — remove filtro geográfico",
    "   _Combos avançados são editados na UI web_",
    "",
    "⏹️ */parar* — cancela busca em andamento"
  ].join("\n");
}
