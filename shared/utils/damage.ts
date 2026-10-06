export type DamageBucket = 'pequena' | 'media' | 'grande' | 'sem_monta' | 'sem_info' | 'outros'

export function normalizeDamageText(value: string | null | undefined): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// A Copart troca a monta por "Aguardando classificação" na página do lote
// depois de um não vendido, até reclassificar o veículo. É um estado
// transitório, não uma monta: nunca deve substituir a monta conhecida.
export function isPendingDamageClassification(raw: string | null | undefined): boolean {
  const normalized = normalizeDamageText(raw)
  return /\b(aguardando|em|pendente de|a) classifica|\bnao classificad|\bsem classificacao\b/.test(normalized)
}

export function classifyDamage(raw: string | null | undefined): DamageBucket {
  const normalized = normalizeDamageText(raw)
  if (!normalized || isPendingDamageClassification(raw)) return 'sem_info'
  if (/pequena/.test(normalized)) return 'pequena'
  if (/media/.test(normalized)) return 'media'
  if (/grande|sucata|perda\s+total|irrecuper/.test(normalized)) return 'grande'
  if (/sem\s+monta|nao\s+batid[oa]|sem\s+sinistro|nao\s+sinistrad[oa]|semi\s+novo|seminovo|usado/.test(normalized)) return 'sem_monta'
  return 'outros'
}

export function normalizeDamage(raw: string | null | undefined): string | null {
  const value = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (!value || isPendingDamageClassification(value)) return null

  switch (classifyDamage(value)) {
    case 'pequena': return 'Pequena monta'
    case 'media': return 'Média monta'
    case 'grande': return 'Grande monta'
    case 'sem_monta': return 'Sem monta'
    default: return value
  }
}
