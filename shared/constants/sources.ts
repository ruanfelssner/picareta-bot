import type { VehicleSource } from '../types/vehicle'

export interface SourceMeta {
  name: string
  color: string
}

export const SOURCE_META: Record<VehicleSource, SourceMeta> = {
  'facebook-marketplace': { name: 'Facebook Marketplace', color: '#1877F2' },
  'vs-veiculos': { name: 'VS Veículos', color: '#2563EB' },
  'sodre': { name: 'Sodré Santoro', color: '#7C3AED' },
  'copart': { name: 'Copart', color: '#DC2626' },
  'favareto': { name: 'Favareto', color: '#059669' },
  'claudio-kuss': { name: 'Claudio Kuss', color: '#D97706' },
  'lucinei': { name: 'Lucinei Automóveis', color: '#0891B2' },
  'vardana': { name: 'Vardana Leilões', color: '#9333EA' },
  'megaleiloes': { name: 'Mega Leilões', color: '#E11D48' },
  'superbid': { name: 'Superbid', color: '#EA580C' },
  'leiloesjudiciais': { name: 'Leilões Judiciais', color: '#65A30D' },
  'vipleiloes': { name: 'VIP Leilões', color: '#0F766E' },
  'mgl': { name: 'MGL', color: '#4F46E5' },
  'ph-batidos': { name: 'PH Batidos', color: '#B45309' },
}

export const VEHICLE_SOURCES = Object.keys(SOURCE_META) as VehicleSource[]

export const DISABLED_AUCTION_SOURCES = [
  'lucinei',
  'mgl',
  'ph-batidos',
] as const satisfies readonly VehicleSource[]

const AUCTION_SOURCES = [
  'vs-veiculos',
  'sodre',
  'copart',
  'favareto',
  'megaleiloes',
  'lucinei',
  'vardana',
  'claudio-kuss',
  'superbid',
  'leiloesjudiciais',
  'vipleiloes',
  'mgl',
  'ph-batidos',
] as const satisfies readonly VehicleSource[]

const DISABLED_AUCTION_SOURCE_SET = new Set<VehicleSource>(DISABLED_AUCTION_SOURCES)

export const ACTIVE_AUCTION_SOURCES = AUCTION_SOURCES.filter(
  source => !DISABLED_AUCTION_SOURCE_SET.has(source),
) as VehicleSource[]
