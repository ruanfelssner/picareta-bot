import { SOURCE_META, VEHICLE_SOURCES } from './sources'
import type { VehicleSource } from '../types/vehicle'

export function scrapingCatalog(version: string, registeredSources: readonly string[]) {
  return {
    schemaVersion: 1 as const,
    version,
    sources: VEHICLE_SOURCES.filter((id): id is Exclude<VehicleSource, 'facebook-marketplace'> => id !== 'facebook-marketplace' && registeredSources.includes(id)).map(id => {
      const meta = SOURCE_META[id]
      const enabled = meta.enabled !== false
      return {
        id, label: meta.name, color: meta.color, enabled, manual: enabled && meta.manual !== false,
        automatic: enabled && meta.automaticPriority != null,
        automaticPriority: meta.automaticPriority ?? 100,
        schedulePriority: meta.schedulePriority ?? 100,
        aliases: [...new Set([id, id.replace(/-/g, ' '), meta.name, ...meta.aliases ?? []])],
        images: meta.images ?? null,
      }
    }),
  }
}
