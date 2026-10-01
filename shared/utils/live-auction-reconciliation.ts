import type { LiveAuctionAuditEvent, LiveAuctionAuditSource } from '../types/live-auction-audit'
import type {
  LiveAuctionEvidenceOrigin,
  LiveAuctionEvidenceStatus,
  LiveAuctionLotEvidence,
  LiveAuctionReconciliationIssue,
  LiveAuctionReconciliationRow,
} from '../types/live-auction-reconciliation'

const LIVE_SOURCES = new Set<LiveAuctionAuditSource>(['copart', 'vipleiloes', 'sodre'])
const TERMINAL_KINDS: Record<string, LiveAuctionEvidenceStatus> = {
  lot_sold: 'sold',
  lot_conditional: 'conditional',
  lot_not_sold: 'not_sold',
}
const TERMINAL_STATUSES = new Set<LiveAuctionEvidenceStatus>(['sold', 'conditional', 'not_sold'])
const DETAIL_ORIGINS = new Set<LiveAuctionEvidenceOrigin>([
  'bot_capture',
  'public_history',
  'local_capture',
])

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function number(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function source(value: unknown, fallback: unknown = null): LiveAuctionAuditSource | null {
  const parsed = text(value) ?? text(fallback)
  return parsed && LIVE_SOURCES.has(parsed as LiveAuctionAuditSource)
    ? parsed as LiveAuctionAuditSource
    : null
}

function status(value: unknown): LiveAuctionEvidenceStatus {
  const parsed = text(value)
  if (parsed === 'sold' || parsed === 'conditional' || parsed === 'not_sold' || parsed === 'unknown' || parsed === 'open') return parsed
  return null
}

function codeFromUrl(value: unknown): string | null {
  const url = text(value)
  if (!url) return null
  const patterns = [/\/lot\/(\d+)/i, /[?&](?:lot|lotId|vehicleId)=([a-z0-9-]+)/i]
  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match?.[1]) return match[1]
  }
  return null
}

function sessionFrom(sourceValue: LiveAuctionAuditSource, item: Record<string, unknown>, fallback: Record<string, unknown> | null): string | null {
  const direct = text(item.sessionKey) ?? text(item.auctionSessionKey) ?? text(fallback?.sessionKey) ?? text(fallback?.auctionSessionKey)
  if (direct) return direct
  const auctionId = text(item.auctionId) ?? text(fallback?.auctionId)
  return auctionId ? `${sourceValue}:${auctionId}` : null
}

function evidenceFromRecord(
  value: unknown,
  origin: LiveAuctionEvidenceOrigin,
  context: Record<string, unknown> | null = null,
): LiveAuctionLotEvidence | null {
  const item = record(value)
  if (!item) return null
  const nested = record(item.lastEvent)
  const sourceValue = source(item.source, context?.source)
  if (!sourceValue) return null
  const eventStatus = TERMINAL_KINDS[text(item.kind) ?? ''] ?? null
  const vehicleUrl = text(item.vehicleUrl) ?? text(item.url) ?? text(nested?.vehicleUrl) ?? text(nested?.url)
  const amount = number(item.amount)
    ?? number(item.soldPrice)
    ?? number(item.price)
    ?? number(item.bid)
    ?? number(nested?.amount)
    ?? number(nested?.soldPrice)
    ?? number(nested?.price)
    ?? number(nested?.bid)

  return {
    origin,
    source: sourceValue,
    sessionKey: sessionFrom(sourceValue, item, context),
    auctionId: text(item.auctionId) ?? text(nested?.auctionId) ?? text(context?.auctionId),
    lot: text(item.lot) ?? text(nested?.lot),
    // O código anexado ao log vem do snapshot visual e pode pertencer ao lote
    // atual quando a mensagem relida é de um lote anterior. Para logs, sessão +
    // lote são a identidade confiável; códigos continuam válidos nas capturas.
    code: origin === 'local_log' || origin === 'server_log'
      ? null
      : text(item.code) ?? text(nested?.code) ?? codeFromUrl(vehicleUrl),
    status: eventStatus ?? status(item.finalStatus) ?? status(item.saleStatus) ?? status(nested?.saleStatus),
    amount,
    fipe: number(item.fipe) ?? number(nested?.fipe),
    damage: text(item.damage) ?? text(nested?.damage),
    title: text(item.title)
      ?? text(item.description)
      ?? text(nested?.title)
      ?? text(nested?.description)
      ?? ([text(item.brand), text(item.model)].filter(Boolean).join(' ') || null),
    observedAt: text(item.observedAt)
      ?? text(item.scrapedAt)
      ?? text(item.lastCapturedAt)
      ?? text(nested?.observedAt),
    url: vehicleUrl,
    eventId: text(item.eventId),
  }
}

export function parseLocalAuctionEvidence(value: unknown): {
  events: LiveAuctionAuditEvent[]
  lots: LiveAuctionLotEvidence[]
  sessionKeys: string[]
} {
  const root = record(value)
  const context = record(root?.session)
  const messages = Array.isArray(root?.messages) ? root.messages : []
  const capturedItems = Array.isArray(root?.items)
    ? root.items
    : Array.isArray(value)
      ? value
      : []
  const eventEvidence = messages
    .map(item => evidenceFromRecord(item, 'local_log', context))
    .filter((item): item is LiveAuctionLotEvidence => item != null)
  const resultEvidence = Array.isArray(root?.results)
    ? root.results.map(item => evidenceFromRecord(item, 'local_log', context)).filter((item): item is LiveAuctionLotEvidence => item != null)
    : []
  const localCaptures = [
    ...(Array.isArray(root?.lots) ? root.lots : []),
    ...capturedItems,
  ].map(item => evidenceFromRecord(item, 'local_capture', context ?? root))
    .filter((item): item is LiveAuctionLotEvidence => item != null)

  const events = messages.map((item) => record(item)).filter((item): item is Record<string, unknown> => item != null)
    .filter(item => text(item.eventId) != null && text(item.sessionKey) != null)
    .map(item => item as unknown as LiveAuctionAuditEvent)
  const terminalByIdentity = new Map<string, LiveAuctionLotEvidence>()
  for (const item of [...eventEvidence, ...resultEvidence]) {
    if (!TERMINAL_STATUSES.has(item.status)) continue
    terminalByIdentity.set(evidenceIdentity(item), item)
  }
  const sessionKeys = new Set<string>()
  const rootSession = text(context?.sessionKey)
  if (rootSession) sessionKeys.add(rootSession)
  for (const item of [...eventEvidence, ...localCaptures]) {
    if (item.sessionKey) sessionKeys.add(item.sessionKey)
  }
  return { events, lots: [...terminalByIdentity.values(), ...localCaptures], sessionKeys: [...sessionKeys] }
}

export function terminalEvidenceFromEvents(events: LiveAuctionAuditEvent[], origin: Extract<LiveAuctionEvidenceOrigin, 'local_log' | 'server_log'>): LiveAuctionLotEvidence[] {
  const latest = new Map<string, LiveAuctionLotEvidence>()
  for (const event of events) {
    if (!TERMINAL_KINDS[event.kind]) continue
    const evidence = evidenceFromRecord(event, origin)
    if (!evidence) continue
    latest.set(evidenceIdentity(evidence), evidence)
  }
  return [...latest.values()]
}

export function lotEvidenceFromEvents(events: LiveAuctionAuditEvent[], origin: Extract<LiveAuctionEvidenceOrigin, 'local_log' | 'server_log'>): LiveAuctionLotEvidence[] {
  const latest = new Map<string, LiveAuctionLotEvidence>()
  for (const event of events) {
    if (!event.lot && !event.code) continue
    const evidence = evidenceFromRecord(event, origin)
    if (!evidence) continue
    const current = latest.get(evidenceIdentity(evidence))
    if (current && TERMINAL_STATUSES.has(current.status) && !TERMINAL_STATUSES.has(evidence.status)) continue
    latest.set(evidenceIdentity(evidence), evidence)
  }
  return [...latest.values()]
}

export function applyFinalCapturesToExtensionObservations(
  observations: LiveAuctionLotEvidence[],
  captures: LiveAuctionLotEvidence[],
): LiveAuctionLotEvidence[] {
  return observations.map((observation) => {
    const finalCapture = captures.find((capture) => TERMINAL_STATUSES.has(capture.status) && sameLot(observation, capture))
    if (!finalCapture) return observation
    return {
      ...observation,
      status: finalCapture.status,
      amount: finalCapture.amount,
      fipe: finalCapture.fipe ?? observation.fipe,
      damage: finalCapture.damage ?? observation.damage,
      title: finalCapture.title ?? observation.title,
      observedAt: finalCapture.observedAt ?? observation.observedAt,
      url: finalCapture.url ?? observation.url,
    }
  })
}

export function evidenceIdentity(item: LiveAuctionLotEvidence): string {
  const sourceValue = item.source.toLowerCase()
  if (item.code) return `${sourceValue}:code:${item.code.toLowerCase()}`
  if (item.sessionKey && item.lot) return `${sourceValue}:session:${item.sessionKey.toLowerCase()}:lot:${item.lot.toLowerCase()}`
  if (item.auctionId && item.lot) return `${sourceValue}:auction:${item.auctionId.toLowerCase()}:lot:${item.lot.toLowerCase()}`
  if (item.lot) return `${sourceValue}:lot:${item.lot.toLowerCase()}`
  return `${sourceValue}:unknown:${item.eventId ?? item.url ?? item.title ?? 'sem-identidade'}`
}

function sameLot(first: LiveAuctionLotEvidence, second: LiveAuctionLotEvidence): boolean {
  if (first.source !== second.source) return false
  if (first.code && second.code) return first.code.toLowerCase() === second.code.toLowerCase()
  if (!first.lot || !second.lot || first.lot.toLowerCase() !== second.lot.toLowerCase()) return false
  if (first.sessionKey && second.sessionKey) return first.sessionKey.toLowerCase() === second.sessionKey.toLowerCase()
  if (first.auctionId && second.auctionId) return first.auctionId.toLowerCase() === second.auctionId.toLowerCase()
  return true
}

function matchesEvidenceRow(
  evidence: Partial<Record<LiveAuctionEvidenceOrigin, LiveAuctionLotEvidence>>,
  item: LiveAuctionLotEvidence,
): boolean {
  const existing = Object.values(evidence).filter((value): value is LiveAuctionLotEvidence => value != null)
  if (item.code && existing.some(value => value.code && value.code.toLowerCase() !== item.code?.toLowerCase())) return false
  return existing.some(value => sameLot(value, item))
}

function issueList(
  evidence: Partial<Record<LiveAuctionEvidenceOrigin, LiveAuctionLotEvidence>>,
  imported: { localLog: boolean; localCapture: boolean },
  publicAvailable: boolean,
): LiveAuctionReconciliationIssue[] {
  const issues: LiveAuctionReconciliationIssue[] = []
  const values = Object.values(evidence).filter((item): item is LiveAuctionLotEvidence => item != null)
  const hasTerminalResult = values.some(item => TERMINAL_STATUSES.has(item.status))
  if (values.some(item => !item.lot && !item.code)) issues.push('unidentified_lot')
  if (imported.localLog && (evidence.server_log || evidence.bot_capture || evidence.public_history) && !evidence.local_log) issues.push('missing_local_log')
  if (hasTerminalResult && imported.localLog && evidence.local_log && !TERMINAL_STATUSES.has(evidence.local_log.status)) issues.push('missing_local_result')
  // Logs apenas confirmam o transporte das mensagens. As divergências do fluxo
  // principal começam quando há uma captura, um item público ou um lote local.
  if (imported.localCapture && (evidence.bot_capture || evidence.public_history) && !evidence.local_capture) issues.push('missing_local_capture')
  if ((imported.localLog || imported.localCapture) && !evidence.server_log) issues.push('missing_server_log')
  if (hasTerminalResult && evidence.server_log && !TERMINAL_STATUSES.has(evidence.server_log.status)) issues.push('missing_server_result')
  if (hasTerminalResult && (evidence.public_history || (imported.localCapture && evidence.local_capture)) && !evidence.bot_capture) issues.push('missing_bot_capture')
  if (publicAvailable && hasTerminalResult && (evidence.bot_capture || (imported.localCapture && evidence.local_capture)) && !evidence.public_history) issues.push('missing_public_history')

  const terminal = values.filter(item => TERMINAL_STATUSES.has(item.status))
  const statuses = new Set(terminal.map(item => item.status))
  if (statuses.size > 1) issues.push('status_mismatch')
  const amounts = new Set(terminal.map(item => item.amount).filter((value): value is number => value != null))
  if (amounts.size > 1) issues.push('amount_mismatch')

  const details = values.filter(item => DETAIL_ORIGINS.has(item.origin))
  const vehicleYears = new Set(details.map(item => item.title?.match(/\b(?:19|20)\d{2}\b/)?.[0]).filter(Boolean))
  const vehicleBrands = new Set(details.map((item) => {
    const title = item.title?.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase()
      .replace(/\b(?:19|20)\d{2}\b/g, '').trim()
    const brand = title?.split(/\s+/)[0] ?? null
    return brand === 'VW' ? 'VOLKSWAGEN' : brand === 'GM' ? 'CHEVROLET' : brand
  }).filter(Boolean))
  if (vehicleYears.size > 1 || vehicleBrands.size > 1) issues.push('vehicle_mismatch')
  const fipeValues = new Set(details.map(item => item.fipe).filter((value): value is number => value != null).map(Math.round))
  if (details.length && details.some(item => item.fipe == null)) issues.push('missing_fipe')
  if (fipeValues.size > 1) issues.push('fipe_mismatch')

  const normalizeDamage = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/\s+/g, ' ').trim()
  const damageValues = new Set(details.map(item => item.damage).filter((value): value is string => Boolean(value)).map(normalizeDamage))
  if (details.length && details.some(item => !item.damage)) issues.push('missing_damage')
  if (damageValues.size > 1) issues.push('damage_mismatch')
  return issues
}

export function reconcileLiveAuctionLots(
  evidence: LiveAuctionLotEvidence[],
  options: { localLogImported: boolean; localCaptureImported: boolean; publicHistoryAvailable: boolean },
): LiveAuctionReconciliationRow[] {
  const rows: Array<{ key: string; evidence: Partial<Record<LiveAuctionEvidenceOrigin, LiveAuctionLotEvidence>> }> = []
  for (const item of evidence) {
    let row = rows.find(candidate => matchesEvidenceRow(candidate.evidence, item))
    if (!row) {
      row = { key: evidenceIdentity(item), evidence: {} }
      rows.push(row)
    }
    const current = row.evidence[item.origin]
    if (!current || Date.parse(item.observedAt ?? '') >= Date.parse(current.observedAt ?? '')) row.evidence[item.origin] = item
  }

  return rows.map((row) => {
    const values = Object.values(row.evidence).filter((item): item is LiveAuctionLotEvidence => item != null)
    const preferred = row.evidence.bot_capture
      ?? row.evidence.public_history
      ?? row.evidence.local_capture
      ?? row.evidence.extension_observation
      ?? row.evidence.server_log
      ?? row.evidence.local_log
      ?? values[0]!
    return {
      key: row.key,
      source: preferred.source,
      sessionKey: preferred.sessionKey,
      auctionId: preferred.auctionId,
      lot: preferred.lot,
      code: preferred.code,
      title: row.evidence.bot_capture?.title
        ?? row.evidence.public_history?.title
        ?? row.evidence.extension_observation?.title
        ?? row.evidence.local_capture?.title
        ?? preferred.title
        ?? null,
      fipe: preferred.fipe ?? values.map(item => item.fipe).find((value): value is number => value != null) ?? null,
      damage: preferred.damage ?? values.map(item => item.damage).find((value): value is string => Boolean(value)) ?? null,
      evidence: row.evidence,
      issues: issueList(row.evidence, {
        localLog: options.localLogImported,
        localCapture: options.localCaptureImported,
      }, options.publicHistoryAvailable),
    }
  }).sort((first, second) => {
    const latestTime = (row: LiveAuctionReconciliationRow) => Math.max(0, ...Object.values(row.evidence)
      .map(item => Date.parse(item?.observedAt ?? ''))
      .filter(Number.isFinite))
    const timeDifference = latestTime(second) - latestTime(first)
    if (timeDifference) return timeDifference
    return (Number(second.lot) || 0) - (Number(first.lot) || 0)
  })
}

