export const VEHICLE_RETENTION_YEARS = 5

export function getVehicleRetentionDate(reference: Date): Date {
  const expiresAt = new Date(reference)
  expiresAt.setUTCFullYear(expiresAt.getUTCFullYear() + VEHICLE_RETENTION_YEARS)
  return expiresAt
}
