import type { VehicleRecord } from '#shared/types/vehicle'

function startOfLocalDay(now: Date): Date {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date
}

function isValidDate(value: Date | string | null | undefined): value is Date | string {
  if (value == null) return false
  const date = value instanceof Date ? value : new Date(value)
  return !Number.isNaN(date.getTime())
}

function hasFinalSaleResult(status: VehicleRecord['saleStatus'] | null | undefined): boolean {
  return status === 'sold' || status === 'conditional' || status === 'not_sold'
}

export function isAuctionDatePast(vehicle: Pick<VehicleRecord, 'auctionDate'>, now = new Date()): boolean {
  if (!isValidDate(vehicle.auctionDate)) return false
  return new Date(vehicle.auctionDate).getTime() < startOfLocalDay(now).getTime()
}

export function getEffectiveAuctionStatus(
  vehicle: Pick<VehicleRecord, 'auctionDate' | 'auctionStatus' | 'saleStatus'>,
  now = new Date(),
): VehicleRecord['auctionStatus'] {
  const auctionStatus = vehicle.auctionStatus ?? 'unknown'
  if (auctionStatus === 'finished' || auctionStatus === 'future') return auctionStatus
  if (hasFinalSaleResult(vehicle.saleStatus)) return 'finished'
  if (isAuctionDatePast(vehicle, now)) return 'finished'
  return auctionStatus
}

export function withEffectiveAuctionLifecycle(vehicle: VehicleRecord, now = new Date()): VehicleRecord {
  const auctionStatus = getEffectiveAuctionStatus(vehicle, now)
  const saleStatus = vehicle.saleStatus ?? 'unknown'
  const inferredFinishedRaw = vehicle.source === 'copart'
    ? 'Venda Finalizada'
    : 'Data do leilão passada'

  return {
    ...vehicle,
    auctionStatus,
    auctionStatusRaw: vehicle.auctionStatusRaw ?? (auctionStatus === 'finished' ? inferredFinishedRaw : null),
    auctionStatusCheckedAt: vehicle.auctionStatusCheckedAt ?? null,
    saleStatus,
    saleStatusRaw: vehicle.saleStatusRaw ?? null,
    saleStatusCheckedAt: vehicle.saleStatusCheckedAt ?? null,
    soldPrice: vehicle.soldPrice ?? null,
    soldPriceRaw: vehicle.soldPriceRaw ?? null,
  }
}

export function canSendVehicleToWhatsapp(_vehicle: VehicleRecord, _now = new Date()): boolean {
  return true
}
