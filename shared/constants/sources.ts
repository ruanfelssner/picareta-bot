import type { VehicleSource } from '../types/vehicle'

export interface SourceMeta {
  name: string
  color: string
  aliases?: string[]
  enabled?: boolean
  manual?: boolean
  automaticPriority?: number
  schedulePriority?: number
  images?: { baseUrl: string; hosts: string[]; referer: string }
}

export const SOURCE_META: Record<VehicleSource, SourceMeta> = {
  'facebook-marketplace': { name: 'Facebook Marketplace', color: '#1877F2' },
  'vs-veiculos': { name: 'VS Veículos', color: '#2563EB', automaticPriority: 30 },
  'sodre': { name: 'Sodré Santoro', color: '#7C3AED', automaticPriority: 10, schedulePriority: 1, aliases: ['sodre', 'sodré'] },
  'copart': { name: 'Copart', color: '#DC2626', automaticPriority: 20, schedulePriority: 0 },
  'favareto': { name: 'Favareto', color: '#059669', images: { baseUrl: 'https://www.favaretoleiloes.com.br/', hosts: ['www.favaretoleiloes.com.br', 'srv1.favaretoleiloes.com.br'], referer: 'https://www.favaretoleiloes.com.br/' } },
  'claudio-kuss': { name: 'Claudio Kuss', color: '#D97706', images: { baseUrl: 'https://www.claudiokussleiloes.com.br/', hosts: ['www.claudiokussleiloes.com.br'], referer: 'https://www.claudiokussleiloes.com.br/' } },
  'lucinei': { name: 'Lucinei Automóveis', color: '#0891B2' },
  'vardana': { name: 'Vardana Leilões', color: '#9333EA', images: { baseUrl: 'https://www.vardanaleiloes.com.br/vardana/', hosts: ['www.vardanaleiloes.com.br', 'vardanaleiloes.com.br', 'vardana.com.br'], referer: 'https://www.vardanaleiloes.com.br/vardana/' } },
  'megaleiloes': { name: 'Mega Leilões', color: '#E11D48' },
  'superbid': { name: 'Superbid', color: '#EA580C' },
  'leiloesjudiciais': { name: 'Leilões Judiciais', color: '#65A30D' },
  'vipleiloes': { name: 'VIP Leilões', color: '#0F766E', schedulePriority: 2, aliases: ['vip'] },
  'mgl': { name: 'MGL', color: '#4F46E5' },
  'ph-batidos': { name: 'PH Batidos', color: '#B45309' },
  'pestana': { name: 'Pestana Leilões', color: '#009E8E', schedulePriority: 3 },
  'pampasul': { name: 'Pampa Sul Leilões', color: '#084D39', enabled: false, aliases: ['pampa sul'], images: { baseUrl: 'https://leiloespampasul.com/', hosts: ['leiloespampasul.com', 'www.leiloespampasul.com'], referer: 'https://leiloespampasul.com/' } },
  'freitas': { name: 'Freitas Leiloeiro', color: '#B91C1C', schedulePriority: 4, aliases: ['freitas leilões'], images: { baseUrl: 'https://www.freitasleiloeiro.com.br/', hosts: ['www.freitasleiloeiro.com.br', 'freitasleiloeiro.com.br', 'cdn3.freitasleiloeiro.com.br'], referer: 'https://www.freitasleiloeiro.com.br/' } },
  'palacio': { name: 'Palácio dos Leilões', color: '#C2410C', schedulePriority: 5, images: { baseUrl: 'https://www.palaciodosleiloes.com.br/site/', hosts: ['www.palaciodosleiloes.com.br'], referer: 'https://www.palaciodosleiloes.com.br/site/' } },
  'leilo': { name: 'Leilo Sul e Sudeste', color: '#E60015', schedulePriority: 6, aliases: ['leilo sul sudeste'], images: { baseUrl: 'https://leilo.com.br/', hosts: ['leilo.cdndp.com.br'], referer: 'https://leilo.com.br/' } },
}

export const VEHICLE_SOURCES = Object.keys(SOURCE_META) as VehicleSource[]

const AUCTION_SOURCES = VEHICLE_SOURCES.filter(source => source !== 'facebook-marketplace')
export const DISABLED_AUCTION_SOURCES = AUCTION_SOURCES.filter(source => SOURCE_META[source].enabled === false)

const DISABLED_AUCTION_SOURCE_SET = new Set<VehicleSource>(DISABLED_AUCTION_SOURCES)

export function isAuctionSourceDisabled(source: unknown): boolean {
  if (typeof source !== 'string') return false
  if (DISABLED_AUCTION_SOURCE_SET.has(source as VehicleSource)) return true
  const key = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
  return DISABLED_AUCTION_SOURCES.some(id => key(source) === key(id) || key(source) === key(SOURCE_META[id].name))
}

export function assertAuctionSourceEnabled(source: VehicleSource): void {
  if (isAuctionSourceDisabled(source)) throw new Error(`${SOURCE_META[source].name}: fonte desativada para coleta e envio.`)
}

export const ACTIVE_AUCTION_SOURCES = AUCTION_SOURCES.filter(
  source => !DISABLED_AUCTION_SOURCE_SET.has(source),
) as VehicleSource[]
