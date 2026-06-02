import { CONTACT_CATEGORIES, searchContacts } from "../integrations/mongo.js";
export async function handleContactSearch(arg, config) {
    const category = arg?.toLowerCase().trim() ?? null;
    if (category && !CONTACT_CATEGORIES.includes(category)) {
        const list = CONTACT_CATEGORIES.join(", ");
        return (`❌ Categoria *${category}* não existe.\n\nCategorias disponíveis:\n${list}`);
    }
    const contacts = await searchContacts(config, category ?? undefined);
    if (contacts.length === 0) {
        const scope = category ? `na categoria *${category}*` : "cadastrados";
        return `Nenhum contato ${scope}. Use */inserir-contato* para cadastrar.`;
    }
    const header = category
        ? `👥 *Contatos — ${category.toUpperCase()} (${contacts.length}):*`
        : `👥 *Todos os contatos (${contacts.length}):*`;
    const lines = [header, ""];
    for (const c of contacts) {
        const note = c.notes ? ` — _${c.notes}_` : "";
        lines.push(`📞 *${c.name}*${note}`);
        lines.push(`   ${c.phone}`);
        if (!category) {
            lines.push(`   🏷️ ${c.category}`);
        }
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
