<script setup lang="ts">
interface MarketplaceResult {
  titleRaw: string
  priceRaw: string | null
  locationRaw: string | null
  url: string
  image: string | null
  matchScore: number
  matchApproved: boolean
  relevanceLevel: 'alta' | 'media' | 'baixa' | 'descartar'
  relevanceScore: number
  semanticReason: string
  matchedTokens: string[]
  missingTokens: string[]
  collectedAt: string
}

interface ResultEntry {
  item: MarketplaceResult
  /** Termos cuja lista final (validada) contém este anúncio. */
  terms: string[]
  /** Termos em que o anúncio apareceu só como prévia durante a coleta. */
  previewTerms: string[]
}

interface ArchivedListing {
  url: string
  titleRaw: string
  priceRaw: string | null
  locationRaw: string | null
  image: string | null
  searchTerms: string[]
  archivedAt: string
}

type RemoteStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'

interface RemoteTermState {
  term: string
  status: RemoteStatus
  total: number | null
  error: string | null
}

interface WorkerStatus {
  online: boolean
  status: 'IDLE' | 'RUNNING' | null
  workerId: string | null
  searchTerm: string | null
  lastSeenAt: string | null
}

interface RemoteSearchDelta {
  id: string
  terms: string[]
  status: RemoteStatus
  active: boolean
  cancelRequested: boolean
  termStates: RemoteTermState[]
  error: string | null
  stale: boolean
  logs: { term: string | null, message: string }[]
  previews: { term: string, item: unknown }[]
  finals: { term: string, items: unknown[] }[]
}

type RelevanceFilter = 'todas' | 'alta' | 'media' | 'baixa'

const RECENT_SEARCHES_STORAGE_KEY = 'bot-anuncios.marketplace.recent-searches.v1'
const RESULTS_CACHE_STORAGE_KEY = 'bot-anuncios.marketplace.results-cache.v1'
const MAX_RECENT_SEARCHES = 8
const MAX_LOG_LINES = 250
const REMOTE_POLL_INTERVAL_MS = 2_000
const REMOTE_POLL_RETRY_MS = 5_000
const REMOTE_POLL_MAX_FAILURES = 6
const WORKER_STATUS_POLL_MS = 30_000

const RELEVANCE_ORDER: Record<MarketplaceResult['relevanceLevel'], number> = {
  alta: 0,
  media: 1,
  baixa: 2,
  descartar: 3,
}

const RELEVANCE_META: Record<MarketplaceResult['relevanceLevel'], { label: string, variant: 'success' | 'info' | 'warning' | 'danger' }> = {
  alta: { label: 'Alta', variant: 'success' },
  media: { label: 'Média', variant: 'info' },
  baixa: { label: 'Baixa', variant: 'warning' },
  descartar: { label: 'Descartar', variant: 'danger' },
}

// ─── Estado ──────────────────────────────────────────────────────────────────

const searchTerm = ref('')
const recentSearches = ref<string[]>([])
const editingRecent = ref(false)

const isSearching = ref(false)
const isBatchSearch = ref(false)
const searchFinished = ref(false)
const cancelRequested = ref(false)
const searchAbortController = shallowRef<AbortController | null>(null)
const activeRemoteSearchId = ref<string | null>(null)
const remoteStatus = ref<RemoteStatus | null>(null)
const remoteTermStates = ref<RemoteTermState[]>([])

const resultEntries = ref(new Map<string, ResultEntry>())
const relevanceFilter = ref<RelevanceFilter>('todas')
const cachedAt = ref<string | null>(null)
const errorMessages = ref<string[]>([])
const logs = ref<string[]>([])

const workerStatus = ref<WorkerStatus | null>(null)
const workerStatusError = ref<string | null>(null)
let workerStatusTimer: ReturnType<typeof setInterval> | null = null

const archivingUrls = ref(new Set<string>())
// Arquivados nesta sessão: impede que a lista final de uma busca em andamento traga o card de volta.
const sessionArchivedUrls = new Set<string>()
const archivedDialogOpen = ref(false)
const archivedItems = ref<ArchivedListing[]>([])
const archivedLoading = ref(false)
const archivedError = ref<string | null>(null)
const restoringUrls = ref(new Set<string>())

// ─── Derivados ───────────────────────────────────────────────────────────────

function compareResults(a: MarketplaceResult, b: MarketplaceResult): number {
  return (RELEVANCE_ORDER[a.relevanceLevel] - RELEVANCE_ORDER[b.relevanceLevel])
    || (b.relevanceScore - a.relevanceScore)
    || (b.matchScore - a.matchScore)
    || (b.matchedTokens.length - a.matchedTokens.length)
    || a.titleRaw.localeCompare(b.titleRaw, 'pt-BR')
}

const sortedResults = computed(() =>
  [...resultEntries.value.values()].sort((a, b) => compareResults(a.item, b.item)),
)

const relevanceCounts = computed(() => {
  const counts = { alta: 0, media: 0, baixa: 0 }
  for (const { item } of resultEntries.value.values()) {
    if (item.relevanceLevel in counts) counts[item.relevanceLevel as keyof typeof counts] += 1
  }
  return counts
})

const relevanceFilterOptions = computed(() => [
  { value: 'todas' as const, label: 'Todas', count: resultEntries.value.size },
  { value: 'alta' as const, label: 'Alta', count: relevanceCounts.value.alta },
  { value: 'media' as const, label: 'Média', count: relevanceCounts.value.media },
  { value: 'baixa' as const, label: 'Baixa', count: relevanceCounts.value.baixa },
].filter(option => option.value === 'todas' || option.count > 0))

const visibleResults = computed(() => relevanceFilter.value === 'todas'
  ? sortedResults.value
  : sortedResults.value.filter(entry => entry.item.relevanceLevel === relevanceFilter.value))

const resultCountLabel = computed(() => {
  const count = resultEntries.value.size
  return `${count} resultado${count === 1 ? '' : 's'}`
})

const cachedLabel = computed(() => {
  if (!cachedAt.value) return null
  const date = new Date(cachedAt.value)
  if (Number.isNaN(date.getTime())) return 'Salvos neste aparelho'
  return `Salvos em ${date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
})

const canSearch = computed(() => searchTerm.value.trim().length > 0 && !isSearching.value)

const workerOnline = computed(() => workerStatus.value?.online === true)

const workerPill = computed(() => {
  if (isSearching.value && remoteStatus.value === 'RUNNING') {
    return { label: 'Buscando', tone: 'bg-info-bg text-info', dot: 'bg-info animate-pulse', title: 'O PC está executando a sua busca' }
  }
  if (workerStatusError.value) {
    return { label: 'Sem status', tone: 'bg-surface text-muted', dot: 'bg-muted', title: workerStatusError.value }
  }
  const status = workerStatus.value
  if (!status) return { label: 'Verificando', tone: 'bg-surface text-muted', dot: 'bg-muted animate-pulse', title: 'Consultando o worker do PC' }
  if (!status.online) {
    return { label: 'PC offline', tone: 'bg-warning-bg text-warning', dot: 'bg-warning', title: 'Inicie o pnpm worker no PC para executar as buscas' }
  }
  if (status.status === 'RUNNING') {
    return { label: 'PC ocupado', tone: 'bg-info-bg text-info', dot: 'bg-info', title: status.searchTerm ? `Executando: ${status.searchTerm}` : 'Executando outra tarefa' }
  }
  return { label: 'PC online', tone: 'bg-success-bg text-success', dot: 'bg-success', title: 'Pronto para buscar' }
})

const runningTermIndex = computed(() => remoteTermStates.value.findIndex(state => state.status === 'RUNNING'))

const progressPercent = computed(() => {
  const total = remoteTermStates.value.length
  if (total === 0) return null
  const finished = remoteTermStates.value.filter(state => state.status !== 'PENDING' && state.status !== 'RUNNING').length
  // Termo em andamento conta meio passo para a barra não ficar parada durante a coleta.
  const inProgress = runningTermIndex.value >= 0 ? 0.5 : 0
  return Math.min(100, Math.round(((finished + inProgress) / total) * 100))
})

const statusTitle = computed(() => {
  if (cancelRequested.value) return 'Parando a busca...'
  if (remoteStatus.value === 'PENDING' || remoteStatus.value === null) return 'Na fila'
  const running = remoteTermStates.value[runningTermIndex.value]
  return running ? `Buscando “${running.term}”` : 'Finalizando...'
})

const statusSubtitle = computed(() => {
  if (remoteStatus.value === 'PENDING' || remoteStatus.value === null) {
    return workerOnline.value ? 'O PC vai começar em instantes' : 'PC offline: começa quando o worker ligar'
  }
  const total = remoteTermStates.value.length
  const found = `${resultEntries.value.size} encontrado${resultEntries.value.size === 1 ? '' : 's'}`
  if (total > 1 && runningTermIndex.value >= 0) return `Termo ${runningTermIndex.value + 1} de ${total} · ${found}`
  return found
})

// ─── Pesquisas recentes ──────────────────────────────────────────────────────

function persistRecentSearches() {
  try {
    localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, JSON.stringify(recentSearches.value))
  }
  catch {
    // O histórico é auxiliar; a busca não deve falhar se o navegador bloquear o storage.
  }
}

function loadRecentSearches() {
  try {
    const stored = localStorage.getItem(RECENT_SEARCHES_STORAGE_KEY)
    const parsed: unknown = stored ? JSON.parse(stored) : []
    if (!Array.isArray(parsed)) return

    recentSearches.value = parsed
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
      .slice(0, MAX_RECENT_SEARCHES)
  }
  catch {
    recentSearches.value = []
  }
}

function saveRecentSearch(term: string) {
  const normalizedTerm = term.trim()
  if (!normalizedTerm) return

  const comparisonTerm = normalizedTerm.toLowerCase()
  recentSearches.value = [
    normalizedTerm,
    ...recentSearches.value.filter(item => item.toLowerCase() !== comparisonTerm),
  ].slice(0, MAX_RECENT_SEARCHES)
  persistRecentSearches()
}

function removeRecentSearch(term: string) {
  recentSearches.value = recentSearches.value.filter(item => item !== term)
  if (recentSearches.value.length === 0) editingRecent.value = false
  persistRecentSearches()
}

function clearRecentSearches() {
  recentSearches.value = []
  editingRecent.value = false
  persistRecentSearches()
}

function onRecentClick(term: string) {
  if (editingRecent.value) {
    removeRecentSearch(term)
    return
  }
  if (isSearching.value) return
  // Não reordena os chips: o item tocado não "foge" do dedo.
  searchTerm.value = term
  void runSearch([term])
}

// ─── Resultados e cache ──────────────────────────────────────────────────────

function upsertPreview(term: string, item: MarketplaceResult) {
  if (sessionArchivedUrls.has(item.url)) return
  const entry = resultEntries.value.get(item.url)
  if (!entry) {
    resultEntries.value.set(item.url, { item, terms: [], previewTerms: [term] })
    return
  }
  // Anúncio já validado por outro termo: a prévia não sobrescreve dados finais.
  if (entry.terms.length === 0) entry.item = item
  if (!entry.terms.includes(term) && !entry.previewTerms.includes(term)) entry.previewTerms.push(term)
}

function applyFinalResults(term: string, items: MarketplaceResult[]) {
  const finalUrls = new Set<string>()

  for (const item of items) {
    if (sessionArchivedUrls.has(item.url)) continue
    finalUrls.add(item.url)
    const entry = resultEntries.value.get(item.url)
    if (!entry) {
      resultEntries.value.set(item.url, { item, terms: [term], previewTerms: [] })
      continue
    }
    // Dados finais substituem prévias; entre dois finais, fica a versão mais relevante.
    if (entry.terms.length === 0 || compareResults(item, entry.item) < 0) entry.item = item
    if (!entry.terms.includes(term)) entry.terms.push(term)
    entry.previewTerms = entry.previewTerms.filter(previewTerm => previewTerm !== term)
  }

  // Prévias deste termo que não sobreviveram ao filtro final saem da lista.
  for (const [url, entry] of resultEntries.value) {
    if (finalUrls.has(url) || !entry.previewTerms.includes(term)) continue
    entry.previewTerms = entry.previewTerms.filter(previewTerm => previewTerm !== term)
    if (entry.terms.length === 0 && entry.previewTerms.length === 0) resultEntries.value.delete(url)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function readResultItem(item: unknown): MarketplaceResult | null {
  if (!isRecord(item)) return null
  if (typeof item.url !== 'string' || !item.url) return null

  return {
    titleRaw: typeof item.titleRaw === 'string' ? item.titleRaw : 'Anúncio sem título',
    priceRaw: typeof item.priceRaw === 'string' ? item.priceRaw : null,
    locationRaw: typeof item.locationRaw === 'string' ? item.locationRaw : null,
    url: item.url,
    image: typeof item.image === 'string' ? item.image : null,
    matchScore: typeof item.matchScore === 'number' ? item.matchScore : 0,
    matchApproved: item.matchApproved === true,
    relevanceLevel: item.relevanceLevel === 'alta' || item.relevanceLevel === 'media' || item.relevanceLevel === 'descartar'
      ? item.relevanceLevel
      : 'baixa',
    relevanceScore: typeof item.relevanceScore === 'number' ? item.relevanceScore : 0,
    semanticReason: typeof item.semanticReason === 'string' ? item.semanticReason : '',
    matchedTokens: readStringArray(item.matchedTokens),
    missingTokens: readStringArray(item.missingTokens),
    collectedAt: typeof item.collectedAt === 'string' ? item.collectedAt : '',
  }
}

function readFetchError(error: unknown): string {
  if (isRecord(error)) {
    if (isRecord(error.data) && typeof error.data.statusMessage === 'string') return error.data.statusMessage
    if (typeof error.statusMessage === 'string') return error.statusMessage
  }
  return error instanceof Error ? error.message : String(error)
}

function persistResultsCache() {
  try {
    if (resultEntries.value.size === 0) {
      localStorage.removeItem(RESULTS_CACHE_STORAGE_KEY)
      return
    }
    localStorage.setItem(RESULTS_CACHE_STORAGE_KEY, JSON.stringify({
      savedAt: new Date().toISOString(),
      isBatch: isBatchSearch.value,
      entries: [...resultEntries.value.values()].map(entry => ({
        item: entry.item,
        terms: [...entry.terms],
        previewTerms: [...entry.previewTerms],
      })),
    }))
  }
  catch {
    // Cache é auxiliar; storage cheio ou bloqueado não deve afetar a busca.
  }
}

function loadResultsCache() {
  try {
    const stored = localStorage.getItem(RESULTS_CACHE_STORAGE_KEY)
    if (!stored) return
    const parsed: unknown = JSON.parse(stored)
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return

    const entries = new Map<string, ResultEntry>()
    for (const raw of parsed.entries) {
      if (!isRecord(raw)) continue
      const item = readResultItem(raw.item)
      if (!item) continue
      entries.set(item.url, { item, terms: readStringArray(raw.terms), previewTerms: readStringArray(raw.previewTerms) })
    }
    if (entries.size === 0) return

    resultEntries.value = entries
    isBatchSearch.value = parsed.isBatch === true
    cachedAt.value = typeof parsed.savedAt === 'string' ? parsed.savedAt : null
  }
  catch {
    // Cache corrompido: começa vazio.
  }
}

function clearResults() {
  if (isSearching.value) return
  resultEntries.value = new Map()
  relevanceFilter.value = 'todas'
  cachedAt.value = null
  searchFinished.value = false
  errorMessages.value = []
  logs.value = []
  persistResultsCache()
}

function appendLog(message: string) {
  if (!message) return
  logs.value.push(message)
  if (logs.value.length > MAX_LOG_LINES) logs.value.splice(0, logs.value.length - MAX_LOG_LINES)
}

function pushError(message: string) {
  errorMessages.value.push(message)
  appendLog(`⚠ ${message}`)
}

function resultTerms(entry: ResultEntry): string[] {
  return [...entry.terms, ...entry.previewTerms]
}

// ─── Arquivados ──────────────────────────────────────────────────────────────

async function archiveResult(entry: ResultEntry) {
  const { item } = entry
  if (archivingUrls.value.has(item.url)) return
  archivingUrls.value.add(item.url)

  try {
    await $fetch('/api/marketplace/archive', {
      method: 'POST',
      body: {
        url: item.url,
        titleRaw: item.titleRaw,
        priceRaw: item.priceRaw,
        locationRaw: item.locationRaw,
        image: item.image,
        searchTerms: resultTerms(entry),
      },
    })
    sessionArchivedUrls.add(item.url)
    resultEntries.value.delete(item.url)
    persistResultsCache()
  }
  catch (error: unknown) {
    pushError(`Não foi possível arquivar “${item.titleRaw}”: ${readFetchError(error)}`)
  }
  finally {
    archivingUrls.value.delete(item.url)
  }
}

async function loadArchived() {
  archivedLoading.value = true
  archivedError.value = null
  try {
    const response = await $fetch<{ items: ArchivedListing[] }>('/api/marketplace/archived')
    archivedItems.value = response.items
  }
  catch (error: unknown) {
    archivedError.value = readFetchError(error)
  }
  finally {
    archivedLoading.value = false
  }
}

function openArchived() {
  archivedDialogOpen.value = true
  void loadArchived()
}

async function restoreArchived(url: string) {
  if (restoringUrls.value.has(url)) return
  restoringUrls.value.add(url)
  try {
    await $fetch('/api/marketplace/unarchive', { method: 'POST', body: { url } })
    sessionArchivedUrls.delete(url)
    archivedItems.value = archivedItems.value.filter(item => item.url !== url)
  }
  catch (error: unknown) {
    archivedError.value = readFetchError(error)
  }
  finally {
    restoringUrls.value.delete(url)
  }
}

function formatArchivedAt(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

// ─── Busca pelo worker do PC ─────────────────────────────────────────────────

function beginSearch(terms: string[]): AbortController {
  const controller = new AbortController()
  searchAbortController.value = controller
  isSearching.value = true
  isBatchSearch.value = terms.length > 1
  searchFinished.value = false
  cancelRequested.value = false
  remoteStatus.value = null
  remoteTermStates.value = terms.map(term => ({ term, status: 'PENDING', total: null, error: null }))
  relevanceFilter.value = 'todas'
  errorMessages.value = []
  logs.value = []
  resultEntries.value = new Map()
  cachedAt.value = null
  editingRecent.value = false
  return controller
}

function endSearch(controller: AbortController) {
  isSearching.value = false
  cancelRequested.value = false
  activeRemoteSearchId.value = null
  // Também grava prévias de uma busca interrompida.
  persistResultsCache()
  if (searchAbortController.value === controller) searchAbortController.value = null
}

function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function applyRemoteDelta(delta: RemoteSearchDelta, reportedTermErrors: Set<number>) {
  isBatchSearch.value = delta.terms.length > 1
  remoteStatus.value = delta.status
  remoteTermStates.value = delta.termStates

  for (const log of delta.logs) {
    appendLog(log.term && isBatchSearch.value ? `[${log.term}] ${log.message}` : log.message)
  }
  for (const preview of delta.previews) {
    const item = readResultItem(preview.item)
    if (item) upsertPreview(preview.term, item)
  }
  for (const final of delta.finals) {
    applyFinalResults(final.term, final.items
      .map(readResultItem)
      .filter((item): item is MarketplaceResult => item !== null))
  }
  if (delta.finals.length > 0) persistResultsCache()

  delta.termStates.forEach((state, index) => {
    if (state.status !== 'FAILED' || !state.error || reportedTermErrors.has(index)) return
    reportedTermErrors.add(index)
    pushError(isBatchSearch.value ? `“${state.term}”: ${state.error}` : state.error)
  })

  if (delta.cancelRequested) cancelRequested.value = true
}

function finishRemoteSearch(delta: RemoteSearchDelta) {
  if (delta.status === 'DONE') {
    searchFinished.value = true
    appendLog(`✓ Busca finalizada: ${resultCountLabel.value}.`)
  }
  else if (delta.status === 'CANCELLED') {
    appendLog('Busca cancelada.')
  }
  else if (delta.status === 'FAILED') {
    pushError(delta.error ?? 'A busca falhou no PC.')
  }
}

/** Acompanha a busca por polling; offsets garantem que logs/prévias/listas finais cheguem uma única vez. */
async function followRemoteSearch(id: string, controller: AbortController) {
  activeRemoteSearchId.value = id
  const offsets = { logs: 0, previews: 0, finals: 0 }
  const reportedTermErrors = new Set<number>()
  let failures = 0

  while (!controller.signal.aborted) {
    let delta: RemoteSearchDelta
    try {
      delta = await $fetch<RemoteSearchDelta>(`/api/marketplace/remote-searches/${id}`, {
        query: offsets,
        signal: controller.signal,
      })
      failures = 0
    }
    catch (error: unknown) {
      if (controller.signal.aborted) return
      failures += 1
      // Rede do celular oscila: tenta de novo antes de desistir de acompanhar.
      if (failures >= REMOTE_POLL_MAX_FAILURES) throw error
      appendLog(`⚠ Falha ao consultar a busca (${readFetchError(error)}). Tentando de novo...`)
      await waitFor(REMOTE_POLL_RETRY_MS, controller.signal)
      continue
    }

    applyRemoteDelta(delta, reportedTermErrors)
    offsets.logs += delta.logs.length
    offsets.previews += delta.previews.length
    offsets.finals += delta.finals.length

    if (delta.stale) {
      pushError('O PC parou de responder no meio da busca. Verifique o terminal do pnpm worker.')
      return
    }

    if (!delta.active) {
      finishRemoteSearch(delta)
      return
    }

    await waitFor(REMOTE_POLL_INTERVAL_MS, controller.signal)
  }
}

function readConflictSearchId(error: unknown): string | null {
  if (!isRecord(error) || !isRecord(error.data) || !isRecord(error.data.data)) return null
  return typeof error.data.data.id === 'string' ? error.data.data.id : null
}

async function runSearch(terms: string[]) {
  if (terms.length === 0 || isSearching.value) return
  const controller = beginSearch(terms)

  try {
    let id: string
    try {
      const response = await $fetch<{ id: string }>('/api/marketplace/remote-searches', {
        method: 'POST',
        body: { terms },
        signal: controller.signal,
      })
      id = response.id
      appendLog(`Busca enviada para o PC (${terms.length} termo${terms.length === 1 ? '' : 's'}).`)
    }
    catch (error: unknown) {
      const existingId = readConflictSearchId(error)
      if (!existingId) throw error
      appendLog(`${readFetchError(error)} Acompanhando a busca existente.`)
      id = existingId
    }

    await followRemoteSearch(id, controller)
  }
  catch (error: unknown) {
    if (!controller.signal.aborted) pushError(readFetchError(error))
  }
  finally {
    endSearch(controller)
  }
}

/** Ao abrir a tela (em qualquer aparelho), volta a acompanhar uma busca que ainda está na fila/rodando. */
async function resumeRemoteSearch() {
  if (isSearching.value) return

  let search: { id: string, terms: string[], active: boolean } | null
  try {
    const response = await $fetch<{ search: { id: string, terms: string[], active: boolean } | null }>('/api/marketplace/remote-searches/latest')
    search = response.search
  }
  catch {
    return
  }
  if (!search?.active || isSearching.value) return

  const controller = beginSearch(search.terms)
  appendLog('Retomando a busca em andamento no PC.')
  try {
    await followRemoteSearch(search.id, controller)
  }
  catch (error: unknown) {
    if (!controller.signal.aborted) pushError(readFetchError(error))
  }
  finally {
    endSearch(controller)
  }
}

async function refreshWorkerStatus() {
  try {
    workerStatus.value = await $fetch<WorkerStatus>('/api/marketplace/worker-status')
    workerStatusError.value = null
  }
  catch (error: unknown) {
    workerStatusError.value = readFetchError(error)
  }
}

async function startSearch() {
  if (!canSearch.value) return
  const term = searchTerm.value.trim()
  saveRecentSearch(term)
  await runSearch([term])
}

async function searchAllRecent() {
  if (isSearching.value || recentSearches.value.length === 0) return
  await runSearch([...recentSearches.value])
}

async function stopSearch() {
  const remoteId = activeRemoteSearchId.value
  if (!remoteId || cancelRequested.value) return

  // Parar = pedir cancelamento; o polling segue até o PC confirmar.
  cancelRequested.value = true
  try {
    await $fetch(`/api/marketplace/remote-searches/${remoteId}/cancel`, { method: 'POST' })
    appendLog('Cancelamento solicitado ao PC...')
  }
  catch (error: unknown) {
    cancelRequested.value = false
    pushError(`Não foi possível parar: ${readFetchError(error)}`)
  }
}

onMounted(() => {
  loadRecentSearches()
  loadResultsCache()
  void refreshWorkerStatus()
  void resumeRemoteSearch()
  workerStatusTimer = setInterval(() => {
    void refreshWorkerStatus()
  }, WORKER_STATUS_POLL_MS)
})

onBeforeUnmount(() => {
  // Sair da tela só para o acompanhamento; a busca continua no PC e é retomada ao voltar.
  searchAbortController.value?.abort()
  if (workerStatusTimer) clearInterval(workerStatusTimer)
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-4">
    <!-- Cabeçalho -->
    <header class="flex items-center justify-between gap-3">
      <div class="min-w-0">
        <h1 class="text-lg font-bold leading-tight text-strong">Marketplace</h1>
        <p class="text-xs text-muted">Busca no Facebook pelo seu PC</p>
      </div>
      <span
        class="inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
        :class="workerPill.tone"
        :title="workerPill.title"
      >
        <span class="size-1.5 rounded-full" :class="workerPill.dot" />
        {{ workerPill.label }}
      </span>
    </header>

    <!-- Busca -->
    <UiCard class="p-3 sm:p-4">
      <form class="flex gap-2" role="search" @submit.prevent="startSearch">
        <UiInput
          v-model="searchTerm"
          size="lg"
          type="search"
          enterkeyhint="search"
          maxlength="80"
          autocomplete="off"
          placeholder="Peça, marca ou modelo"
          aria-label="Termo de busca"
          :disabled="isSearching"
        />
        <UiButton type="submit" variant="primary" size="lg" class="shrink-0" :disabled="!canSearch">
          Buscar
        </UiButton>
      </form>

      <p v-if="workerStatus && !workerOnline && !isSearching" class="mt-2 text-[11.5px] leading-relaxed text-warning">
        O PC está offline. Suas buscas ficam na fila e começam quando o worker ligar.
      </p>

      <div v-if="recentSearches.length > 0" class="mt-3">
        <div class="mb-1.5 flex items-center justify-between gap-2">
          <span class="text-[11px] font-semibold uppercase tracking-wide text-muted">Recentes</span>
          <div class="flex items-center">
            <UiButton v-if="!editingRecent && recentSearches.length > 1" variant="ghost" size="xs" :disabled="isSearching" @click="searchAllRecent">
              Buscar todas ({{ recentSearches.length }})
            </UiButton>
            <UiButton variant="ghost" size="xs" @click="editingRecent = !editingRecent">
              {{ editingRecent ? 'Concluir' : 'Editar' }}
            </UiButton>
          </div>
        </div>

        <div class="-mx-3 flex gap-1.5 overflow-x-auto px-3 pb-0.5 scrollbar-none sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
          <button
            v-for="recent in recentSearches"
            :key="recent"
            type="button"
            class="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs transition disabled:opacity-50"
            :class="editingRecent
              ? 'border-danger-line bg-danger-bg text-danger'
              : 'border-line-soft bg-panel-soft text-soft hover:border-line-hover hover:text-body'"
            :disabled="isSearching && !editingRecent"
            :aria-label="editingRecent ? `Remover ${recent}` : `Buscar ${recent}`"
            @click="onRecentClick(recent)"
          >
            <span class="max-w-56 truncate">{{ recent }}</span>
            <svg v-if="editingRecent" class="size-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </button>
          <button
            v-if="editingRecent"
            type="button"
            class="inline-flex min-h-8 shrink-0 items-center rounded-full px-3 text-xs font-semibold text-danger hover:bg-danger-bg"
            @click="clearRecentSearches"
          >
            Limpar tudo
          </button>
        </div>
      </div>
    </UiCard>

    <!-- Progresso -->
    <div v-if="isSearching" class="rounded-card border border-line bg-panel p-3" aria-live="polite">
      <div class="flex items-center gap-3">
        <span class="size-5 shrink-0 animate-spin rounded-full border-2 border-accent/30 border-t-accent" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <p class="truncate text-[13px] font-semibold text-body">{{ statusTitle }}</p>
          <p class="truncate text-[11.5px] text-muted">{{ statusSubtitle }}</p>
        </div>
        <UiButton variant="danger" size="sm" :disabled="cancelRequested" @click="stopSearch">
          {{ cancelRequested ? 'Parando' : 'Parar' }}
        </UiButton>
      </div>
      <div v-if="progressPercent !== null && remoteStatus === 'RUNNING'" class="mt-3 h-1 overflow-hidden rounded-full bg-surface">
        <div class="h-full rounded-full bg-accent transition-[width] duration-500" :style="{ width: `${progressPercent}%` }" />
      </div>
    </div>

    <!-- Erros -->
    <div v-if="errorMessages.length > 0" class="flex items-start gap-2 rounded-card border border-danger-line bg-danger-bg px-3 py-2.5 text-[12px] leading-relaxed text-danger" role="alert">
      <div class="min-w-0 flex-1 space-y-1">
        <p v-for="(message, index) in errorMessages" :key="index" class="wrap-break-word">{{ message }}</p>
      </div>
      <button type="button" class="grid size-6 shrink-0 place-items-center rounded-control hover:bg-danger/10" aria-label="Fechar avisos" @click="errorMessages = []">
        <svg class="size-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
      </button>
    </div>

    <!-- Resultados -->
    <section v-if="sortedResults.length > 0" class="flex flex-col gap-3">
      <div class="flex items-end justify-between gap-2">
        <div class="min-w-0">
          <h2 class="text-sm font-semibold text-body">{{ resultCountLabel }}</h2>
          <p v-if="cachedLabel && !isSearching" class="text-[11px] text-muted">{{ cachedLabel }}</p>
          <p v-else-if="searchFinished" class="text-[11px] text-success">Busca concluída</p>
        </div>
        <div class="flex shrink-0 items-center">
          <UiButton variant="ghost" size="xs" @click="openArchived">Arquivados</UiButton>
          <UiButton v-if="!isSearching" variant="ghost" size="xs" @click="clearResults">Limpar</UiButton>
        </div>
      </div>

      <div v-if="relevanceFilterOptions.length > 2" class="-mx-4 flex gap-1.5 overflow-x-auto px-4 scrollbar-none sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
        <button
          v-for="option in relevanceFilterOptions"
          :key="option.value"
          type="button"
          class="inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition"
          :class="relevanceFilter === option.value
            ? 'border-accent bg-surface-active text-strong'
            : 'border-line-soft text-muted hover:border-line-hover hover:text-soft'"
          :aria-pressed="relevanceFilter === option.value"
          @click="relevanceFilter = option.value"
        >
          {{ option.label }}
          <span class="text-[10.5px] text-faint">{{ option.count }}</span>
        </button>
      </div>

      <ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <li
          v-for="entry in visibleResults"
          :key="entry.item.url"
          class="relative rounded-card border border-line bg-panel transition hover:border-line-hover"
        >
          <a :href="entry.item.url" target="_blank" rel="noopener noreferrer" class="flex gap-3 p-2">
            <div class="size-24 shrink-0 overflow-hidden rounded-control bg-canvas-deep">
              <img v-if="entry.item.image" :src="entry.item.image" :alt="entry.item.titleRaw" class="size-full object-cover" loading="lazy">
              <div v-else class="grid size-full place-items-center text-2xl text-faint">🛒</div>
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5 pr-8">
              <p class="truncate text-[15px] font-bold text-strong">{{ entry.item.priceRaw ?? 'Sem preço' }}</p>
              <h3 class="line-clamp-2 text-[13px] leading-snug text-body">{{ entry.item.titleRaw }}</h3>
              <p class="truncate text-[11.5px] text-muted">{{ entry.item.locationRaw ?? 'Local não informado' }}</p>
              <div class="mt-auto flex min-w-0 items-center gap-1.5 pt-1">
                <UiBadge :variant="RELEVANCE_META[entry.item.relevanceLevel].variant" size="xs">
                  {{ RELEVANCE_META[entry.item.relevanceLevel].label }}
                </UiBadge>
                <UiBadge v-if="entry.terms.length === 0" variant="muted" size="xs" title="Ainda não validado pelo filtro final">Prévia</UiBadge>
                <span v-if="isBatchSearch" class="truncate text-[10.5px] text-faint">{{ resultTerms(entry).join(' · ') }}</span>
              </div>
            </div>
          </a>
          <button
            type="button"
            class="absolute right-1 top-1 grid size-9 place-items-center rounded-control text-muted transition hover:bg-surface hover:text-soft disabled:opacity-50"
            title="Arquivar: não aparece mais nas buscas"
            :aria-label="`Arquivar ${entry.item.titleRaw}`"
            :disabled="archivingUrls.has(entry.item.url)"
            @click="archiveResult(entry)"
          >
            <span v-if="archivingUrls.has(entry.item.url)" class="size-3.5 animate-spin rounded-full border-2 border-muted/30 border-t-muted" />
            <svg v-else class="size-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="4" width="18" height="4" rx="1" />
              <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8M10 12h4" />
            </svg>
          </button>
        </li>
      </ul>

      <p v-if="visibleResults.length === 0" class="py-6 text-center text-xs text-muted">
        Nenhum resultado com essa relevância.
      </p>
    </section>

    <!-- Estado vazio -->
    <div v-else-if="!isSearching" class="flex flex-col items-center rounded-card border border-dashed border-line px-6 py-12 text-center">
      <svg class="size-9 text-faint" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <p class="mt-3 text-[13px] font-semibold text-soft">Nenhum resultado por aqui</p>
      <p class="mt-1 max-w-xs text-xs leading-relaxed text-muted">
        Busque uma peça ou veículo. Os anúncios aparecem conforme o PC encontra, com os mais relevantes primeiro.
      </p>
      <UiButton variant="ghost" size="xs" class="mt-3" @click="openArchived">Ver arquivados</UiButton>
    </div>

    <!-- Detalhes técnicos -->
    <details v-if="logs.length > 0" class="group rounded-card border border-line bg-panel">
      <summary class="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold text-muted [&::-webkit-details-marker]:hidden">
        Detalhes da busca
        <svg class="size-3.5 transition group-open:rotate-180" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
      </summary>
      <div class="scrollbar-dark max-h-64 overflow-y-auto border-t border-line px-3 py-2">
        <p
          v-for="(line, index) in logs"
          :key="index"
          class="wrap-break-word font-mono text-[11px] leading-relaxed"
          :class="line.startsWith('✓') ? 'text-success' : line.startsWith('⚠') ? 'text-danger' : 'text-dim'"
        >
          {{ line }}
        </p>
      </div>
      <p class="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
        Se o Facebook pedir login ou verificação, resolva na janela do Chromium aberta no PC.
      </p>
    </details>

    <UiDialog v-model:open="archivedDialogOpen" title="Arquivados" description="Não aparecem mais nas buscas. Restaure para voltar a vê-los.">
      <p v-if="archivedError" class="mb-3 rounded-control border border-danger-line bg-danger-bg px-3 py-2 text-[12px] text-danger">
        {{ archivedError }}
      </p>
      <p v-if="archivedLoading && archivedItems.length === 0" class="py-8 text-center text-xs text-muted">Carregando...</p>
      <p v-else-if="archivedItems.length === 0" class="py-8 text-center text-xs text-muted">Nenhum anúncio arquivado.</p>
      <ul v-else class="flex flex-col divide-y divide-line-soft">
        <li v-for="archived in archivedItems" :key="archived.url" class="flex items-center gap-3 py-2.5">
          <a :href="archived.url" target="_blank" rel="noopener noreferrer" class="flex min-w-0 flex-1 items-center gap-3">
            <img v-if="archived.image" :src="archived.image" :alt="archived.titleRaw" class="size-12 shrink-0 rounded-control object-cover" loading="lazy">
            <div v-else class="grid size-12 shrink-0 place-items-center rounded-control bg-canvas-deep text-lg text-faint">🛒</div>
            <div class="min-w-0">
              <p class="truncate text-[13px] font-semibold text-body">{{ archived.priceRaw ?? 'Sem preço' }} · {{ archived.titleRaw }}</p>
              <p class="truncate text-[11px] text-muted">
                {{ formatArchivedAt(archived.archivedAt) }}<template v-if="archived.searchTerms.length"> · {{ archived.searchTerms.join(', ') }}</template>
              </p>
            </div>
          </a>
          <UiButton variant="secondary" size="xs" class="shrink-0" :disabled="restoringUrls.has(archived.url)" @click="restoreArchived(archived.url)">
            Restaurar
          </UiButton>
        </li>
      </ul>
    </UiDialog>
  </div>
</template>
