import type { MongoConfig } from "../integrations/mongo.js";
import { CONTACT_CATEGORIES, addContact } from "../integrations/mongo.js";

const TEMPLATE_MESSAGE = [
  "Para cadastrar um contato, responda neste formato:",
  "",
  "*CATEGORIA | NOME | TELEFONE | OBS (opcional)*",
  "",
  "Categorias disponíveis:",
  CONTACT_CATEGORIES.join(" · "),
  "",
  "Exemplo:",
  "motor | Oficina do João | 41999990000 | Especialista Golf TSI"
].join("\n");

export type ContactInsertResult = {
  ok: boolean;
  message: string;
  showTemplate?: boolean;
};

function parseContactData(data: string): {
  category: string;
  name: string;
  phone: string;
  notes: string | null;
} | null {
  const parts = data.split("|").map((p) => p.trim());
  if (parts.length < 3) {
    return null;
  }

  const [category, name, phone, ...rest] = parts;
  const notes = rest.join("|").trim() || null;

  if (!category || !name || !phone) {
    return null;
  }

  return { category: category.toLowerCase(), name, phone, notes };
}

export async function handleContactInsert(
  arg: string | null,
  senderPhone: string,
  config: MongoConfig
): Promise<ContactInsertResult> {
  if (!arg) {
    return { ok: true, message: TEMPLATE_MESSAGE, showTemplate: true };
  }

  const parsed = parseContactData(arg);
  if (!parsed) {
    return {
      ok: false,
      message:
        "❌ Formato inválido. Use:\n*CATEGORIA | NOME | TELEFONE | OBS (opcional)*\n\n" +
        "Exemplo:\nmotor | Oficina do João | 41999990000 | Especialista Golf TSI"
    };
  }

  if (!CONTACT_CATEGORIES.includes(parsed.category as never)) {
    const list = CONTACT_CATEGORIES.join(", ");
    return {
      ok: false,
      message: `❌ Categoria *${parsed.category}* inválida.\n\nCategorias: ${list}`
    };
  }

  await addContact(config, {
    category: parsed.category,
    name: parsed.name,
    phone: parsed.phone,
    notes: parsed.notes,
    addedBy: senderPhone,
    addedAt: new Date()
  });

  return {
    ok: true,
    message: `✅ Contato *${parsed.name}* cadastrado em *${parsed.category}*.\nTelefone: ${parsed.phone}`
  };
}
