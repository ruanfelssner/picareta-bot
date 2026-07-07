import type { VehicleRecord, VehicleSource } from '../types/vehicle'

export type FeeVehicleKind = 'moto' | 'carro_passeio' | 'caminhonete_suv' | 'caminhao'

export interface VehicleFeeEstimate {
  source: VehicleSource
  basePrice: number
  commission: number
  dsal: number
  fixedFees: number
  logistics: number
  feesTotal: number
  total: number
  vehicleKind: FeeVehicleKind
  mode: 'fixed' | 'auction'
}

type FeeVehicleInput = Pick<
  VehicleRecord,
  'source' | 'price' | 'soldPrice' | 'brand' | 'model' | 'title' | 'description' | 'damage' | 'fipe'
>

const FIXED_FEE_SOURCES = new Set<VehicleSource>([
  'vs-veiculos',
  'ph-batidos',
])

const AUCTION_FEE_SOURCES = new Set<VehicleSource>([
  'sodre',
  'copart',
  'favareto',
  'claudio-kuss',
  'vardana',
  'vipleiloes',
])

const FIXED_FEE_VALUE = 800
const AUCTIONEER_COMMISSION_RATE = 0.05
const FIXED_OPERATIONAL_FEES = {
  atpvDocument: 150,
  yardLoading: 100,
  bankSlip: 10,
}

const LOGISTICS_BY_KIND: Record<FeeVehicleKind, number> = {
  moto: 250,
  carro_passeio: 500,
  caminhonete_suv: 800,
  caminhao: 1500,
}

const DSAL_TABLE = [
  { min: 0, max: 4_999, value: 600 },
  { min: 5_000, max: 9_999, value: 900 },
  { min: 10_000, max: 19_999, value: 1_400 },
  { min: 20_000, max: 29_999, value: 1_900 },
  { min: 30_000, max: 49_999, value: 2_900 },
  { min: 50_000, max: 74_999, value: 3_500 },
  { min: 75_000, max: 999_999, value: 4_500 },
]

export function formatAuctionFeeMoney(value: number | null): string {
  return value != null ? `R$ ${Math.round(value).toLocaleString('pt-BR')}` : '-'
}

export function estimateVehicleFees(vehicle: FeeVehicleInput, priceOverride?: number | null): VehicleFeeEstimate | null {
  const basePrice = normalizePositiveMoney(priceOverride ?? vehicle.soldPrice ?? vehicle.price)
  if (basePrice == null) return null

  if (FIXED_FEE_SOURCES.has(vehicle.source)) {
    return buildFixedFeeEstimate(vehicle.source, basePrice)
  }

  if (!AUCTION_FEE_SOURCES.has(vehicle.source)) return null

  return buildAuctionFeeEstimate(vehicle, basePrice)
}

export function formatVehicleFeeEstimateTitle(estimate: VehicleFeeEstimate | null): string | null {
  if (!estimate) return null

  if (estimate.mode === 'fixed') {
    return `Taxa fixa estimada: ${formatAuctionFeeMoney(estimate.feesTotal)}`
  }

  return [
    `Comissão 5%: ${formatAuctionFeeMoney(estimate.commission)}`,
    `DSAL: ${formatAuctionFeeMoney(estimate.dsal)}`,
    `Logística: ${formatAuctionFeeMoney(estimate.logistics)}`,
    `Operacionais fixas: ${formatAuctionFeeMoney(estimate.fixedFees)}`,
    `Taxas totais: ${formatAuctionFeeMoney(estimate.feesTotal)}`,
  ].join(' · ')
}

export function calculateTotalFipePercent(total: number | null, fipe: number | null): number | null {
  if (total == null || fipe == null || fipe <= 0) return null
  return Math.round((total / fipe) * 100)
}

function buildFixedFeeEstimate(source: VehicleSource, basePrice: number): VehicleFeeEstimate {
  return {
    source,
    basePrice,
    commission: 0,
    dsal: 0,
    fixedFees: FIXED_FEE_VALUE,
    logistics: 0,
    feesTotal: FIXED_FEE_VALUE,
    total: basePrice + FIXED_FEE_VALUE,
    vehicleKind: 'carro_passeio',
    mode: 'fixed',
  }
}

function buildAuctionFeeEstimate(vehicle: FeeVehicleInput, basePrice: number): VehicleFeeEstimate {
  const commission = Math.round(basePrice * AUCTIONEER_COMMISSION_RATE)
  const dsal = findDsalFee(basePrice)
  const fixedFees = Object.values(FIXED_OPERATIONAL_FEES).reduce((sum, value) => sum + value, 0)
  const vehicleKind = inferVehicleKind(vehicle)
  const logistics = LOGISTICS_BY_KIND[vehicleKind]
  const feesTotal = commission + dsal + fixedFees + logistics

  return {
    source: vehicle.source,
    basePrice,
    commission,
    dsal,
    fixedFees,
    logistics,
    feesTotal,
    total: basePrice + feesTotal,
    vehicleKind,
    mode: 'auction',
  }
}

function findDsalFee(price: number): number {
  return DSAL_TABLE.find(row => price >= row.min && price <= row.max)?.value ?? DSAL_TABLE[DSAL_TABLE.length - 1]!.value
}

function inferVehicleKind(vehicle: FeeVehicleInput): FeeVehicleKind {
  const text = normalizeForMatch([
    vehicle.brand,
    vehicle.model,
    vehicle.title,
    vehicle.description,
    vehicle.damage,
  ].filter(Boolean).join(' '))

  if (/\b(MOTO|MOTOCICLETA|BIZ|CG|NXR|PCX|FAZER|YBR|XRE|BROS)\b/.test(text)) return 'moto'
  if (/\b(CAMINHAO|CAMINHÃO|ONIBUS|ÔNIBUS|CARRETA|TRATOR|SPRINTER)\b/.test(text)) return 'caminhao'
  if (/\b(SUV|PICAPE|PICAPES|PICKUP|CAMINHONETE|CAMIONETE|HILUX|SW4|S10|RANGER|L200|AMAROK|FRONTIER|TORO|STRADA|SAVEIRO|MONTANA|OROCH|RAM|RENEGADE|COMPASS|CRETA|TRACKER|HR V|T CROSS|NIVUS|KICKS|DUSTER)\b/.test(text)) {
    return 'caminhonete_suv'
  }

  return 'carro_passeio'
}

function normalizePositiveMoney(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return Math.round(value)
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
