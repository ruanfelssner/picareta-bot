<script setup lang="ts">
import type { LiveAuctionAuditEvent } from '#shared/types/live-auction-audit'
import type {
  LiveAuctionAuditResponse,
  LiveAuctionEvidenceOrigin,
  LiveAuctionLotEvidence,
  LiveAuctionReconciliationIssue,
} from '#shared/types/live-auction-reconciliation'
import {
  lotEvidenceFromEvents,
  parseLocalAuctionEvidence,
  reconcileLiveAuctionLots,
} from '#shared/utils/live-auction-reconciliation'

type PeriodFilter = 'today' | '7d' | '30d'
type ViewMode = 'lots' | 'messages'

const ORIGIN_LABELS: Record<LiveAuctionEvidenceOrigin, string> = {
  local_log: 'Log da extensão',
  server_log: 'Log no Bot',
  extension_observation: 'Extensão · último estado',
  bot_capture: 'Captura no Bot',
  public_history: 'Histórico público',
  local_capture: 'Lote local',
}

const ISSUE_LABELS: Record<LiveAuctionReconciliationIssue, string> = {
  missing_local_log: 'Ausente no log da extensão',
  missing_local_result: 'Resultado ausente no log da extensão',
  missing_local_capture: 'Ausente nos lotes locais',
  missing_server_log: 'Não chegou ao Bot',
  missing_server_result: 'Resultado ausente no log do Bot',
  missing_bot_capture: 'Não virou captura',
  missing_public_history: 'Não aparece no histórico',
  status_mismatch: 'Status divergente',
  amount_mismatch: 'Valor divergente',
  missing_fipe: 'FIPE ausente em alguma etapa',
  fipe_mismatch: 'FIPE divergente',
  missing_damage: 'Monta ausente em alguma etapa',
  damage_mismatch: 'Monta divergente',
  unidentified_lot: 'Identidade incompleta',
}

const STATUS_LABELS: Record<string, string> = {
  sold: 'Vendido',
  conditional: 'Condicional',
  not_sold: 'Não vendido',
  unknown: 'Sem resultado',
  open: 'Em aberto',
}

const route = useRoute()
const router = useRouter()
const period = ref<PeriodFilter>('7d')
const selectedSessionKey = ref(typeof route.query.sessionKey === 'string' ? route.query.sessionKey.toLowerCase() : '')
const view = ref<ViewMode>('lots')
const search = ref('')
const onlyIssues = ref(false)
const localEvents = ref<LiveAuctionAuditEvent[]>([])
const localEvidence = ref<LiveAuctionLotEvidence[]>([])
const importedSessionKeys = ref<string[]>([])
const localLogSessionKeys = ref<string[]>([])
const localCaptureSessionKeys = ref<string[]>([])
const extensionLocalEvents = ref<LiveAuctionAuditEvent[]>([])
const extensionLocalEvidence = ref<LiveAuctionLotEvidence[]>([])
const extensionLocalSessionKeys = ref<string[]>([])
const extensionLocalLogSessionKeys = ref<string[]>([])
const extensionLocalSessionUpdatedAt = ref<Record<string, string>>({})
const extensionBridgeState = ref<'checking' | 'connected' | 'unavailable'>('checking')
const extensionBridgeUpdatedAt = ref<string | null>(null)
const localLogImported = ref(false)
const localCaptureImported = ref(false)
const importMessage = ref('')
const importError = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const BRIDGE_PAGE_SOURCE = 'picareta-history-page'
const BRIDGE_EXTENSION_SOURCE = 'picareta-conditional-extension'
const BRIDGE_MESSAGE = 'PICARETA_LIVE_AUCTION_LOCAL_STATE'
let liveRefreshTimer: ReturnType<typeof window.setInterval> | null = null
let bridgeStartedAt = 0
let sessionManuallySelected = false

const query = computed(() => ({
  period: period.value,
  sessionKey: selectedSessionKey.value || undefined,
}))

const { data, status, error, refresh } = await useFetch<LiveAuctionAuditResponse>('/api/vehicles/live-audit', { query })

const sessions = computed(() => {
  const values = [...(data.value?.sessions ?? [])]
  for (const sessionKeyValue of [...importedSessionKeys.value, ...extensionLocalSessionKeys.value]) {
    const sessionKey = sessionKeyValue.toLowerCase()
    if (values.some(item => item.sessionKey === sessionKey)) continue
    const source = sessionKey.split(':')[0]
    if (source !== 'copart' && source !== 'vipleiloes' && source !== 'sodre') continue
    const sessionEvidence = extensionLocalEvidence.value.filter(item => item.sessionKey?.toLowerCase() === sessionKey)
    const localLots = new Set(sessionEvidence.map(item => item.code ?? item.lot).filter(Boolean)).size
    values.push({
      sessionKey,
      aliases: [sessionKey],
      source,
      auctionId: sessionKey.split(':')[1] ?? null,
      sessionLabel: `${source === 'vipleiloes' ? 'VIP' : source === 'sodre' ? 'Sodré' : 'Copart'} local · leilão ${sessionKey.split(':')[1] ?? 'não identificado'}`,
      eventCount: 0,
      localLots,
      terminalLots: sessionEvidence.filter(item => item.status === 'sold' || item.status === 'conditional' || item.status === 'not_sold').length,
      pendingEvents: 0,
      firstObservedAt: extensionLocalSessionUpdatedAt.value[sessionKey] ?? new Date(0).toISOString(),
      lastObservedAt: extensionLocalSessionUpdatedAt.value[sessionKey] ?? new Date(0).toISOString(),
    })
  }
  return values.sort((first, second) => Date.parse(second.lastObservedAt) - Date.parse(first.lastObservedAt))
})

watch(sessions, (items) => {
  if (!selectedSessionKey.value && items[0]) selectedSessionKey.value = items[0].sessionKey
}, { immediate: true })

watch(selectedSessionKey, (sessionKey) => {
  void router.replace({ query: { ...route.query, sessionKey: sessionKey || undefined } })
  requestExtensionLocalState()
})

const selectedSession = computed(() => sessions.value.find(item => item.sessionKey === selectedSessionKey.value) ?? null)
const detail = computed(() => data.value?.selectedSessionKey === selectedSessionKey.value ? data.value : null)

function belongsToSelectedSession(item: { sessionKey?: string | null; auctionId?: string | null }): boolean {
  if (!selectedSessionKey.value) return false
  if (item.sessionKey) return item.sessionKey.toLowerCase() === selectedSessionKey.value.toLowerCase()
  return Boolean(item.auctionId && selectedSession.value?.auctionId?.toLowerCase() === item.auctionId.toLowerCase())
}

const selectedLocalEvents = computed(() => [...new Map([
  ...localEvents.value.filter(belongsToSelectedSession),
  ...extensionLocalEvents.value.filter(belongsToSelectedSession),
].map(item => [item.eventId, item])).values()])
const selectedLocalEvidence = computed(() => [
  ...localEvidence.value.filter(belongsToSelectedSession),
  ...extensionLocalEvidence.value.filter(belongsToSelectedSession),
])
const selectedLocalLogImported = computed(() => [...localLogSessionKeys.value, ...extensionLocalLogSessionKeys.value]
  .some(key => key.toLowerCase() === selectedSessionKey.value.toLowerCase()))
const selectedLocalCaptureImported = computed(() => [...localCaptureSessionKeys.value, ...extensionLocalSessionKeys.value]
  .some(key => key.toLowerCase() === selectedSessionKey.value.toLowerCase()))
const serverLotEvidence = computed(() => lotEvidenceFromEvents(detail.value?.events ?? [], 'server_log'))
const reconciliationRows = computed(() => reconcileLiveAuctionLots([
  ...lotEvidenceFromEvents(selectedLocalEvents.value, 'local_log'),
  ...selectedLocalEvidence.value,
  ...serverLotEvidence.value,
  ...(detail.value?.extensionCaptures ?? []),
  ...(detail.value?.botCaptures ?? []),
  ...(detail.value?.publicHistory ?? []),
], {
  localLogImported: selectedLocalLogImported.value,
  localCaptureImported: selectedLocalCaptureImported.value,
  publicHistoryAvailable: detail.value?.publicHistoryState.status === 'available',
}))

const filteredRows = computed(() => {
  const term = search.value.trim().toLocaleLowerCase('pt-BR')
  return reconciliationRows.value.filter((row) => {
    if (onlyIssues.value && row.issues.length === 0) return false
    if (!term) return true
    return [row.lot, row.code, row.title, row.sessionKey, ...row.issues.map(issue => ISSUE_LABELS[issue])]
      .some(value => String(value ?? '').toLocaleLowerCase('pt-BR').includes(term))
  })
})

const messageRows = computed(() => {
  const rows = new Map<string, { event: LiveAuctionAuditEvent; local: boolean; server: boolean }>()
  for (const event of selectedLocalEvents.value) rows.set(event.eventId, { event, local: true, server: false })
  for (const event of detail.value?.events ?? []) {
    const current = rows.get(event.eventId)
    if (current) current.server = true
    else rows.set(event.eventId, { event, local: false, server: true })
  }
  const term = search.value.trim().toLocaleLowerCase('pt-BR')
  return [...rows.values()]
    .filter((row) => !onlyIssues.value || !row.local || !row.server)
    .filter((row) => !term || [row.event.rawText, row.event.lot, row.event.code, row.event.kind]
      .some(value => String(value ?? '').toLocaleLowerCase('pt-BR').includes(term)))
    .sort((first, second) => first.event.sequence - second.event.sequence)
})

const issueCount = computed(() => reconciliationRows.value.filter(row => row.issues.length > 0).length)
const messageStats = computed(() => {
  const serverIds = new Set((detail.value?.events ?? []).map(item => item.eventId))
  const localIds = new Set(selectedLocalEvents.value.map(item => item.eventId))
  return {
    local: localIds.size,
    server: serverIds.size,
    missingServer: [...localIds].filter(id => !serverIds.has(id)).length,
    serverOnly: [...serverIds].filter(id => !localIds.has(id)).length,
  }
})
const localLotCount = computed(() => new Set(selectedLocalEvidence.value
  .filter(item => item.origin === 'local_capture')
  .map(item => item.code ?? `${item.sessionKey}:${item.lot}`)).size)

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function requestExtensionLocalState() {
  if (!import.meta.client) return
  window.postMessage({
    source: BRIDGE_PAGE_SOURCE,
    type: BRIDGE_MESSAGE,
    sessionKey: selectedSessionKey.value || null,
  }, window.location.origin)
}

function receiveExtensionLocalState(event: MessageEvent) {
  if (event.source !== window || event.origin !== window.location.origin) return
  const message = event.data
  if (!isRecord(message) || message.source !== BRIDGE_EXTENSION_SOURCE || message.type !== `${BRIDGE_MESSAGE}_RESULT`) return
  if (message.ok !== true || !isRecord(message.body)) {
    extensionBridgeState.value = 'unavailable'
    return
  }

  const body = message.body
  const snapshots = Array.isArray(body.snapshots) ? body.snapshots : []
  const nextEvidence: LiveAuctionLotEvidence[] = []
  const nextSessionKeys = new Set<string>()
  const nextLogSessionKeys = new Set<string>()
  const nextUpdatedAt: Record<string, string> = {}
  for (const snapshot of snapshots) {
    if (!isRecord(snapshot) || !Array.isArray(snapshot.items) || typeof snapshot.sessionKey !== 'string') continue
    const sessionKey = snapshot.sessionKey.toLowerCase()
    const parsed = parseLocalAuctionEvidence({ source: snapshot.source, sessionKey, items: snapshot.items })
    nextEvidence.push(...parsed.lots.filter(item => item.origin === 'local_capture'))
    nextSessionKeys.add(sessionKey)
    if (typeof snapshot.updatedAt === 'string' && !Number.isNaN(Date.parse(snapshot.updatedAt))) nextUpdatedAt[sessionKey] = snapshot.updatedAt
  }
  const events = Array.isArray(body.events)
    ? body.events.filter(isRecord).map(item => item as unknown as LiveAuctionAuditEvent)
    : []
  for (const item of events) {
    if (!item.sessionKey) continue
    nextSessionKeys.add(item.sessionKey.toLowerCase())
    nextLogSessionKeys.add(item.sessionKey.toLowerCase())
  }
  extensionLocalEvidence.value = nextEvidence
  extensionLocalEvents.value = events
  extensionLocalSessionKeys.value = [...nextSessionKeys]
  extensionLocalLogSessionKeys.value = [...nextLogSessionKeys]
  extensionLocalSessionUpdatedAt.value = nextUpdatedAt
  extensionBridgeState.value = 'connected'
  extensionBridgeUpdatedAt.value = typeof body.updatedAt === 'string' ? body.updatedAt : new Date().toISOString()
  if (!sessionManuallySelected) {
    const latestSessionKey = [...nextSessionKeys].sort((first, second) => Date.parse(nextUpdatedAt[second] ?? '') - Date.parse(nextUpdatedAt[first] ?? ''))[0]
    if (latestSessionKey) selectedSessionKey.value = latestSessionKey
  }
}

onMounted(() => {
  bridgeStartedAt = Date.now()
  window.addEventListener('message', receiveExtensionLocalState)
  requestExtensionLocalState()
  liveRefreshTimer = window.setInterval(() => {
    if (document.hidden) return
    if (!extensionBridgeUpdatedAt.value && Date.now() - bridgeStartedAt > 6_000) extensionBridgeState.value = 'unavailable'
    void refresh()
    requestExtensionLocalState()
  }, 3_000)
})

onBeforeUnmount(() => {
  window.removeEventListener('message', receiveExtensionLocalState)
  if (liveRefreshTimer != null) window.clearInterval(liveRefreshTimer)
})

async function importFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = [...(input.files ?? [])]
  if (!files.length) return
  importError.value = ''
  let eventCount = 0
  let lotCount = 0
  try {
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name}: o arquivo ultrapassa 25 MB.`)
      const raw: unknown = JSON.parse(await file.text())
      const parsed = parseLocalAuctionEvidence(raw)
      const root = isRecord(raw) ? raw : null
      const hasMessages = Array.isArray(root?.messages)
      const hasCaptures = Array.isArray(raw) || Array.isArray(root?.items) || Array.isArray(root?.lots)
      if (!hasMessages && !hasCaptures) throw new Error(`${file.name}: formato de exportação não reconhecido.`)
      if (hasMessages) localLogImported.value = true
      if (hasCaptures) localCaptureImported.value = true
      localEvents.value = [...new Map([...localEvents.value, ...parsed.events].map(item => [item.eventId, item])).values()]
      localEvidence.value = [...localEvidence.value, ...parsed.lots]
      importedSessionKeys.value = [...new Set([...importedSessionKeys.value, ...parsed.sessionKeys.map(key => key.toLowerCase())])]
      if (hasMessages) {
        const keys = parsed.events.map(item => item.sessionKey)
        const sessionRecord = isRecord(root?.session) ? root.session : null
        const rootSession = typeof sessionRecord?.sessionKey === 'string' ? sessionRecord.sessionKey : null
        localLogSessionKeys.value = [...new Set([...localLogSessionKeys.value, ...keys.map(key => key.toLowerCase()), ...(rootSession ? [rootSession.toLowerCase()] : [])])]
      }
      if (hasCaptures) {
        const keys = parsed.lots.filter(item => item.origin === 'local_capture').map(item => item.sessionKey).filter((item): item is string => Boolean(item))
        localCaptureSessionKeys.value = [...new Set([...localCaptureSessionKeys.value, ...keys.map(key => key.toLowerCase())])]
      }
      eventCount += parsed.events.length
      lotCount += parsed.lots.filter(item => item.origin === 'local_capture').length
    }
    importMessage.value = `${files.length} arquivo(s) lido(s): ${eventCount} mensagem(ns) e ${lotCount} lote(s) locais.`
    const firstImported = importedSessionKeys.value.find(key => sessions.value.some(item => item.sessionKey === key)) ?? importedSessionKeys.value[0]
    if (firstImported) selectedSessionKey.value = firstImported
  }
  catch (requestError) {
    importError.value = requestError instanceof Error ? requestError.message : 'Não foi possível ler o JSON.'
  }
  finally {
    input.value = ''
  }
}

function clearImports() {
  localEvents.value = []
  localEvidence.value = []
  importedSessionKeys.value = []
  localLogSessionKeys.value = []
  localCaptureSessionKeys.value = []
  localLogImported.value = false
  localCaptureImported.value = false
  importMessage.value = ''
  importError.value = ''
}

function exportReport() {
  if (!selectedSessionKey.value) return
  const payload = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sessionKey: selectedSessionKey.value,
    summary: {
      lots: reconciliationRows.value.length,
      lotsWithIssues: issueCount.value,
      localMessages: messageStats.value.local,
      serverMessages: messageStats.value.server,
      messagesMissingOnServer: messageStats.value.missingServer,
    },
    rows: reconciliationRows.value,
  }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `auditoria-${selectedSessionKey.value.replace(/[^a-z0-9-]+/gi, '-')}.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
}

function formatCurrency(value: number | null): string {
  return value == null ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 })
}

function evidenceLabel(item: LiveAuctionLotEvidence | undefined): string {
  if (!item) return 'Ausente'
  return `${STATUS_LABELS[item.status ?? ''] ?? 'Registrado'} · ${formatCurrency(item.amount)}`
}

function evidenceClass(item: LiveAuctionLotEvidence | undefined): string {
  return item ? 'border-line-soft bg-panel-soft text-soft' : 'border-danger-line bg-danger-bg/40 text-danger'
}

function issueVariant(issue: LiveAuctionReconciliationIssue): 'danger' | 'warning' {
  return issue === 'amount_mismatch'
    || issue === 'status_mismatch'
    || issue === 'missing_fipe'
    || issue === 'fipe_mismatch'
    || issue === 'missing_damage'
    || issue === 'damage_mismatch'
    ? 'warning'
    : 'danger'
}

function hasDetailedFields(origin: LiveAuctionEvidenceOrigin): boolean {
  return origin !== 'local_log' && origin !== 'server_log'
}
</script>

<template>
  <UiContainer>
    <header class="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
      <div>
        <p class="text-[10px] font-bold uppercase tracking-[0.18em] text-accent-soft">Conferência ponta a ponta</p>
        <h1 class="mt-1 text-2xl font-bold text-strong">Auditoria dos leilões ao vivo</h1>
        <p class="mt-1 max-w-3xl text-[13px] leading-relaxed text-muted">
          Compare a coleta local, o recebimento no Bot, a captura persistida e o que realmente aparece no Histórico público.
        </p>
        <p class="mt-2 flex flex-wrap items-center gap-2 text-[10px] text-faint">
          <span class="inline-block size-1.5 rounded-full" :class="extensionBridgeState === 'connected' ? 'bg-success' : extensionBridgeState === 'checking' ? 'bg-warning' : 'bg-danger'" />
          {{ extensionBridgeState === 'connected' ? 'Extensão conectada · dados locais automáticos' : extensionBridgeState === 'checking' ? 'Procurando extensão…' : 'Ponte local indisponível · use Importar JSON' }}
          <span v-if="extensionBridgeUpdatedAt">· atualizado {{ formatDateTime(extensionBridgeUpdatedAt) }}</span>
          <span>· atualização automática a cada 3 segundos</span>
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <input ref="fileInput" class="sr-only" type="file" accept="application/json,.json" multiple @change="importFiles">
        <UiButton variant="primary" size="md" @click="fileInput?.click()">Importar JSON local</UiButton>
        <UiButton variant="secondary" size="md" :disabled="!selectedSessionKey" @click="exportReport">Exportar relatório</UiButton>
        <UiButton variant="secondary" size="md" :loading="status === 'pending'" @click="refresh">Atualizar</UiButton>
      </div>
    </header>

    <div v-if="importMessage || importError" class="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-card border px-3 py-2 text-xs" :class="importError ? 'border-danger-line bg-danger-bg text-danger' : 'border-line bg-panel text-soft'">
      <span>{{ importError || importMessage }} <span v-if="!importError" class="text-faint">Os arquivos não foram enviados ao servidor.</span></span>
      <button v-if="localLogImported || localCaptureImported" type="button" class="font-semibold text-accent-soft hover:underline" @click="clearImports">Remover arquivos</button>
    </div>

    <div v-if="error" class="mb-4 rounded-card border border-danger-line bg-danger-bg p-4 text-sm text-danger">
      Não foi possível consultar a auditoria: {{ error.message }}
    </div>

    <section class="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
      <UiCard class="p-3">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Local da extensão</p>
        <p class="mt-1 text-xl font-bold text-strong">{{ selectedLocalCaptureImported ? localLotCount : '—' }}</p>
        <p class="mt-1 text-[10px] text-faint">{{ selectedLocalLogImported ? `${messageStats.local} mensagens · ${messageStats.missingServer} não chegaram` : 'Aguardando snapshot local' }}</p>
      </UiCard>
      <UiCard class="p-3">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Log no Bot</p>
        <p class="mt-1 text-xl font-bold text-strong">{{ detail ? messageStats.server : status === 'pending' ? '…' : 0 }}</p>
        <p class="mt-1 text-[10px] text-faint">{{ selectedSession?.pendingEvents ?? 0 }} aguardando Picareta</p>
      </UiCard>
      <UiCard class="p-3">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Estados da extensão</p>
        <p class="mt-1 text-xl font-bold text-strong">{{ detail?.extensionCaptures.length ?? (status === 'pending' ? '…' : 0) }}</p>
        <p class="mt-1 text-[10px] text-faint">Prévia atualizada pelo resultado final</p>
      </UiCard>
      <UiCard class="p-3">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Capturas no Bot</p>
        <p class="mt-1 text-xl font-bold text-strong">{{ detail?.botCaptures.length ?? (status === 'pending' ? '…' : 0) }}</p>
        <p class="mt-1 text-[10px] text-faint">Lotes persistidos pela extensão</p>
      </UiCard>
      <UiCard class="p-3">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Histórico público</p>
        <p class="mt-1 text-xl font-bold text-strong">{{ detail?.publicHistoryState.status === 'available' ? detail.publicHistory.length : status === 'pending' ? '…' : '—' }}</p>
        <a v-if="detail?.publicHistoryState.historyUrl" :href="detail.publicHistoryState.historyUrl" target="_blank" rel="noopener" class="mt-1 inline-block text-[10px] text-accent-soft hover:underline">Abrir recorte no Picareta ↗</a>
        <p v-else class="mt-1 truncate text-[10px] text-faint" :title="detail?.publicHistoryState.error ?? undefined">{{ detail?.publicHistoryState.error ?? 'Selecione uma sessão' }}</p>
      </UiCard>
      <UiCard class="p-3" :class="issueCount ? 'border-danger-line' : ''">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-muted">Lotes com alerta</p>
        <p class="mt-1 text-xl font-bold" :class="issueCount ? 'text-danger' : 'text-success'">{{ issueCount }}</p>
        <p class="mt-1 text-[10px] text-faint">de {{ reconciliationRows.length }} lote(s) comparado(s)</p>
      </UiCard>
    </section>

    <UiCard class="mb-4 p-3">
      <div class="grid gap-3 lg:grid-cols-[minmax(260px,1fr)_150px_minmax(220px,1fr)_auto] lg:items-end">
        <label class="block">
          <span class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Sessão do leilão</span>
          <UiSelect v-model="selectedSessionKey" class="w-full min-h-9" @change="sessionManuallySelected = true">
            <option value="">Selecione uma sessão</option>
            <option v-for="session in sessions" :key="session.sessionKey" :value="session.sessionKey">
              {{ session.sessionLabel || session.sessionKey }} · {{ formatDateTime(session.lastObservedAt) }} · {{ session.localLots != null ? `${session.localLots} lotes locais` : `${session.eventCount} eventos` }} · {{ session.terminalLots }} finais
            </option>
          </UiSelect>
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Período</span>
          <UiSelect v-model="period" class="w-full min-h-9">
            <option value="today">Hoje</option>
            <option value="7d">7 dias</option>
            <option value="30d">30 dias</option>
          </UiSelect>
        </label>
        <label class="block">
          <span class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted">Buscar</span>
          <UiInput v-model="search" size="md" type="search" placeholder="Lote, código, veículo ou mensagem..." />
        </label>
        <label class="flex min-h-9 cursor-pointer items-center gap-2 rounded-control border border-line px-3 text-xs text-soft">
          <input v-model="onlyIssues" type="checkbox" class="accent-accent">
          Só divergências
        </label>
      </div>
      <div class="mt-3 flex flex-wrap gap-2 border-t border-line-soft pt-3">
        <UiButton size="sm" :active="view === 'lots'" @click="view = 'lots'">Lotes comparados</UiButton>
        <UiButton size="sm" :active="view === 'messages'" @click="view = 'messages'">Mensagens do log</UiButton>
      </div>
    </UiCard>

    <div v-if="status === 'pending' && !data" class="rounded-card border border-line bg-panel px-5 py-16 text-center text-sm text-muted">
      Carregando evidências da auditoria…
    </div>
    <div v-else-if="!selectedSessionKey" class="rounded-card border border-line bg-panel px-5 py-16 text-center text-sm text-muted">
      Nenhuma sessão encontrada no período. Importe um JSON local ou aguarde a chegada dos logs do leilão.
    </div>

    <section v-else-if="view === 'lots'" aria-label="Comparação de lotes">
      <div v-if="!filteredRows.length" class="rounded-card border border-line bg-panel px-5 py-16 text-center text-sm text-muted">
        Nenhum lote corresponde aos filtros atuais.
      </div>
      <div v-else class="space-y-2">
        <article v-for="row in filteredRows" :key="row.key" class="rounded-card border bg-panel p-3 transition" :class="row.issues.length ? 'border-danger-line' : 'border-line'">
          <div class="flex flex-col gap-3 xl:flex-row xl:items-start">
            <div class="min-w-0 xl:w-56 xl:shrink-0">
              <div class="flex flex-wrap items-center gap-1.5">
                <strong class="text-sm text-strong">Lote {{ row.lot ?? '—' }}</strong>
                <UiBadge v-if="row.code" variant="muted" size="xs">{{ row.code }}</UiBadge>
                <UiBadge v-if="!row.issues.length" variant="success" size="xs">Conferido</UiBadge>
              </div>
              <p class="mt-1 truncate text-xs text-muted" :title="row.title ?? undefined">{{ row.title ?? 'Veículo não identificado' }}</p>
              <p class="mt-1 truncate text-[10px] text-faint" :title="`FIPE ${formatCurrency(row.fipe)} · Monta ${row.damage ?? '—'}`">
                FIPE {{ formatCurrency(row.fipe) }} · Monta {{ row.damage ?? '—' }}
              </p>
              <div v-if="row.issues.length" class="mt-2 flex flex-wrap gap-1">
                <UiBadge v-for="issue in row.issues" :key="issue" :variant="issueVariant(issue)" size="xs">{{ ISSUE_LABELS[issue] }}</UiBadge>
              </div>
            </div>
            <div class="grid min-w-0 flex-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              <div v-for="origin in (Object.keys(ORIGIN_LABELS) as LiveAuctionEvidenceOrigin[])" :key="origin" class="min-w-0 rounded-control border p-2" :class="evidenceClass(row.evidence[origin])">
                <p class="text-[9px] font-bold uppercase tracking-wide text-muted">{{ ORIGIN_LABELS[origin] }}</p>
                <p class="mt-1 truncate text-[11px] font-semibold" :title="evidenceLabel(row.evidence[origin])">{{ evidenceLabel(row.evidence[origin]) }}</p>
                <template v-if="row.evidence[origin] && hasDetailedFields(origin)">
                  <p class="mt-1 truncate text-[10px]" :class="row.evidence[origin]?.fipe == null ? 'text-warning' : 'text-muted'">
                    <span class="text-faint">FIPE</span> {{ formatCurrency(row.evidence[origin]?.fipe ?? null) }}
                  </p>
                  <p class="mt-0.5 truncate text-[10px]" :class="row.evidence[origin]?.damage ? 'text-muted' : 'text-warning'" :title="row.evidence[origin]?.damage ?? undefined">
                    <span class="text-faint">Monta</span> {{ row.evidence[origin]?.damage ?? '—' }}
                  </p>
                </template>
                <p v-if="row.evidence[origin]?.observedAt" class="mt-1 text-[9px] text-faint">{{ formatDateTime(row.evidence[origin]?.observedAt) }}</p>
              </div>
            </div>
          </div>
        </article>
      </div>
    </section>

    <section v-else aria-label="Comparação de mensagens">
      <div class="mb-2 flex flex-wrap gap-2 text-[11px] text-muted">
        <span>{{ messageStats.local }} no log da extensão</span><span>·</span>
        <span>{{ messageStats.server }} no Bot</span><span>·</span>
        <span :class="messageStats.missingServer ? 'text-danger' : 'text-success'">{{ messageStats.missingServer }} ausente(s) no Bot</span>
      </div>
      <div v-if="!selectedLocalLogImported" class="mb-3 rounded-card border border-line bg-panel p-3 text-xs text-muted">
        Importe o JSON do botão <strong class="text-soft">Log</strong> da extensão para comparar mensagem por mensagem.
      </div>
      <div v-if="!messageRows.length" class="rounded-card border border-line bg-panel px-5 py-16 text-center text-sm text-muted">Nenhuma mensagem corresponde aos filtros.</div>
      <div v-else class="overflow-hidden rounded-card border border-line bg-panel">
        <div class="max-h-[68vh] overflow-y-auto scrollbar-dark">
          <article v-for="row in messageRows" :key="row.event.eventId" class="grid gap-2 border-b border-line-soft p-3 last:border-0 sm:grid-cols-[90px_120px_minmax(0,1fr)_150px] sm:items-start">
            <div><p class="text-[10px] font-semibold text-soft">#{{ row.event.sequence }}</p><p class="mt-1 text-[9px] text-faint">{{ formatDateTime(row.event.observedAt) }}</p></div>
            <div><UiBadge variant="info" size="xs">{{ row.event.kind }}</UiBadge><p class="mt-1 text-[10px] text-muted">Lote {{ row.event.lot ?? '—' }}</p></div>
            <p class="break-words text-xs leading-relaxed text-body">{{ row.event.rawText }}</p>
            <div class="flex flex-wrap gap-1 sm:justify-end">
              <UiBadge :variant="row.local ? 'success' : 'danger'" size="xs">Local {{ row.local ? '✓' : 'ausente' }}</UiBadge>
              <UiBadge :variant="row.server ? 'success' : 'danger'" size="xs">Bot {{ row.server ? '✓' : 'ausente' }}</UiBadge>
            </div>
          </article>
        </div>
      </div>
    </section>
  </UiContainer>
</template>

