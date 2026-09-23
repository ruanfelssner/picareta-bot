<script setup lang="ts">
interface MarketplaceResult {
  titleRaw: string
  priceRaw: string | null
  locationRaw: string | null
  url: string
  image: string | null
  rawText: string
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

interface SearchProgress {
  term: string
  index: number
  total: number
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

type SseHandler = (payload: unknown) => void

/** `worker`: fila no Mongo executada pelo `pnpm worker` no PC. `direct`: navegador na máquina deste servidor (SSE). */
type SearchMode = 'worker' | 'direct'
type RemoteStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'

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
  termStates: { term: string, status: RemoteStatus, total: number | null, error: string | null }[]
  error: string | null
  stale: boolean
  logs: { term: string | null, message: string }[]
  previews: { term: string, item: unknown }[]
  finals: { term: string, items: unknown[] }[]
}

const RECENT_SEARCHES_STORAGE_KEY = 'bot-anuncios.marketplace.recent-searches.v1'
const MAX_RECENT_SEARCHES = 8
const RESULTS_CACHE_STORAGE_KEY = 'bot-anuncios.marketplace.results-cache.v1'
const SEARCH_MODE_STORAGE_KEY = 'bot-anuncios.marketplace.search-mode.v1'
const REMOTE_POLL_INTERVAL_MS = 2_000
const REMOTE_POLL_RETRY_MS = 5_000
const REMOTE_POLL_MAX_FAILURES = 6
const WORKER_STATUS_POLL_MS = 30_000

const searchTerm = ref('')
const recentSearches = ref<string[]>([])
const isSearching = ref(false)
const logs = ref<string[]>([])
const resultEntries = ref(new Map<string, ResultEntry>())
const errorMessages = ref<string[]>([])
const searchFinished = ref(false)
const searchAbortController = shallowRef<AbortController | null>(null)
const searchProgress = ref<SearchProgress | null>(null)
const isBatchSearch = ref(false)
/** Data do cache restaurado ao abrir a página; zera quando uma nova busca começa. */
const cachedAt = ref<string | null>(null)
const archivingUrls = ref(new Set<string>())
// Arquivados nesta sessão: impede que a lista final de uma busca em andamento traga o card de volta.
const sessionArchivedUrls = new Set<string>()
const archivedDialogOpen = ref(false)
const archivedItems = ref<ArchivedListing[]>([])
const archivedLoading = ref(false)
const archivedError = ref<string | null>(null)
const restoringUrls = ref(new Set<string>())
const searchMode = ref<SearchMode>('worker')
const workerStatus = ref<WorkerStatus | null>(null)
const workerStatusError = ref<string | null>(null)
const activeRemoteSearchId = ref<string | null>(null)
const cancelRequested = ref(false)
let workerStatusTimer: ReturnType<typeof setInterval> | null = null

const RELEVANCE_ORDER: Record<MarketplaceResult['relevanceLevel'], number> = {
  alta: 0,
  media: 1,
  baixa: 2,
  descartar: 3,
}

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

const resultCountLabel = computed(() => {
  const count = resultEntries.value.size
  return `${count} resultado${count === 1 ? '' : 's'}`
})

const progressLabel = computed(() => {
  const progress = searchProgress.value
  if (!progress || progress.total <= 1) return null
  return `Busca ${progress.index}/${progress.total}: ${progress.term}`
})

const cachedLabel = computed(() => {
  if (!cachedAt.value) return null
  const date = new Date(cachedAt.value)
  if (Number.isNaN(date.getTime())) return 'Em cache'
  return `Em cache · ${date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`
})

const workerStatusLabel = computed(() => {
  if (workerStatusError.value) return `Status do worker indisponível: ${workerStatusError.value}`
  const status = workerStatus.value
  if (!status) return 'Verificando worker do PC...'
  if (!status.online) return 'Worker do PC offline: a busca fica na fila até o pnpm worker ser iniciado.'
  if (status.status === 'RUNNING') return `Worker do PC online · ocupado${status.searchTerm ? ` (${status.searchTerm})` : ''}`
  return 'Worker do PC online · livre'
})

const canSearch = computed(() => searchTerm.value.trim().length > 0 && !isSearching.value)

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

function useRecentSearch(term: string) {
  if (isSearching.value) return
  searchTerm.value = term
}

function removeRecentSearch(term: string) {
  recentSearches.value = recentSearches.value.filter(item => item !== term)
  persistRecentSearches()
}

function clearRecentSearches() {
  recentSearches.value = []
  persistRecentSearches()
}

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

function readMessage(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.message !== 'string') return null
  return payload.message
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
    rawText: typeof item.rawText === 'string' ? item.rawText : '',
    matchScore: typeof item.matchScore === 'number' ? item.matchScore : 0,
    matchApproved: item.matchApproved === true,
    relevanceLevel: item.relevanceLevel === 'alta' || item.relevanceLevel === 'media' || item.relevanceLevel === 'descartar'
      ? item.relevanceLevel
      : 'baixa',
    relevanceScore: typeof item.relevanceScore === 'number' ? item.relevanceScore : 0,
    semanticReason: typeof item.semanticReason === 'string' ? item.semanticReason : '',
    matchedTokens: Array.isArray(item.matchedTokens) ? item.matchedTokens.filter((token): token is string => typeof token === 'string') : [],
    missingTokens: Array.isArray(item.missingTokens) ? item.missingTokens.filter((token): token is string => typeof token === 'string') : [],
    collectedAt: typeof item.collectedAt === 'string' ? item.collectedAt : '',
  }
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
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
      // rawText não é exibido e é o campo mais pesado; fica fora para caber no storage.
      entries: [...resultEntries.value.values()].map(entry => ({
        item: { ...entry.item, rawText: '' },
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
  cachedAt.value = null
  searchFinished.value = false
  errorMessages.value = []
  persistResultsCache()
}

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
        searchTerms: [...entry.terms, ...entry.previewTerms],
      },
    })
    sessionArchivedUrls.add(item.url)
    resultEntries.value.delete(item.url)
    persistResultsCache()
  }
  catch (error: unknown) {
    errorMessages.value.push(`Falha ao arquivar "${item.titleRaw}": ${readFetchError(error)}`)
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
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function appendLog(message: string) {
  if (!message) return
  logs.value.push(message)
  if (logs.value.length > 250) logs.value.splice(0, logs.value.length - 250)
}

function readPartial(payload: unknown): MarketplaceResult | null {
  if (!isRecord(payload)) return null
  return readResultItem(payload.item)
}

function readFinalResults(payload: unknown): MarketplaceResult[] | null {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return null
  return payload.items
    .map(readResultItem)
    .filter((item): item is MarketplaceResult => item !== null)
}

async function assertOk(response: Response) {
  if (response.ok) return
  const text = await response.text().catch(() => '')
  throw new Error(text.trim() || `HTTP ${response.status}`)
}

async function readSse(response: Response, handlers: Record<string, SseHandler>) {
  await assertOk(response)
  if (!response.body) throw new Error('O servidor não retornou um stream de eventos.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  const consumeLine = (line: string) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('event: ')) {
      currentEvent = trimmed.slice(7)
      return
    }
    if (!trimmed.startsWith('data: ')) return

    try {
      const payload: unknown = JSON.parse(trimmed.slice(6))
      handlers[currentEvent]?.(payload)
    }
    catch {
      appendLog('⚠ Evento inválido recebido do servidor.')
    }
    currentEvent = ''
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) consumeLine(line)
  }

  if (buffer.trim()) consumeLine(buffer)
}

interface TermRunOutcome {
  busy: boolean
}

async function runTermSearch(term: string, controller: AbortController): Promise<TermRunOutcome> {
  const outcome: TermRunOutcome = { busy: false }
  const prefix = isBatchSearch.value ? `[${term}] ` : ''
  let receivedFinal = false

  const response = await fetch('/api/marketplace/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ term }),
    signal: controller.signal,
  })

  await readSse(response, {
    status: (payload) => {
      const message = readMessage(payload)
      if (message) appendLog(message)
      appendLog('Se a sessão não estiver autenticada, faça o login na janela do navegador e aguarde a busca continuar.')
    },
    log: (payload) => {
      const message = readMessage(payload)
      if (message) appendLog(`${prefix}${message}`)
    },
    partial: (payload) => {
      const item = readPartial(payload)
      if (item) upsertPreview(term, item)
    },
    results: (payload) => {
      const items = readFinalResults(payload)
      if (!items) return
      receivedFinal = true
      applyFinalResults(term, items)
      persistResultsCache()
    },
    done: (payload) => {
      const total = isRecord(payload) && typeof payload.total === 'number' ? payload.total : 0
      appendLog(`✓ ${prefix}Busca finalizada: ${total} resultado${total === 1 ? '' : 's'}.`)
    },
    error: (payload) => {
      const message = readMessage(payload) ?? 'Falha na busca do Marketplace.'
      if (isRecord(payload) && payload.code === 'SEARCH_BUSY') outcome.busy = true
      errorMessages.value.push(isBatchSearch.value ? `"${term}": ${message}` : message)
      appendLog(`⚠ ${prefix}${message}`)
    },
  })

  // Sem lista final (erro no meio da busca), as prévias ficam visíveis e marcadas como tal.
  if (!receivedFinal && !outcome.busy) appendLog(`${prefix}Prévias coletadas mantidas na lista.`)

  return outcome
}

function beginSearch(terms: string[]): AbortController {
  const controller = new AbortController()
  searchAbortController.value = controller
  isSearching.value = true
  isBatchSearch.value = terms.length > 1
  searchFinished.value = false
  cancelRequested.value = false
  errorMessages.value = []
  logs.value = []
  resultEntries.value = new Map()
  cachedAt.value = null
  return controller
}

function endSearch(controller: AbortController) {
  isSearching.value = false
  searchProgress.value = null
  cancelRequested.value = false
  activeRemoteSearchId.value = null
  // Também grava prévias de uma busca interrompida.
  persistResultsCache()
  if (searchAbortController.value === controller) searchAbortController.value = null
}

function handleSearchError(error: unknown, controller: AbortController) {
  if (controller.signal.aborted) {
    appendLog('⚠ Busca interrompida.')
    return
  }
  const message = readFetchError(error)
  errorMessages.value.push(message)
  appendLog(`⚠ ${message}`)
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

async function runDirectSearches(terms: string[]) {
  const controller = beginSearch(terms)

  try {
    for (const [index, term] of terms.entries()) {
      if (controller.signal.aborted) break
      searchProgress.value = { term, index: index + 1, total: terms.length }
      if (isBatchSearch.value) appendLog(`▶ Busca ${index + 1}/${terms.length}: "${term}"`)

      const outcome = await runTermSearch(term, controller)
      // Outra busca ocupando o navegador: não adianta seguir para os próximos termos.
      if (outcome.busy) break
    }

    if (!controller.signal.aborted) {
      searchFinished.value = true
      if (isBatchSearch.value) appendLog(`✓ Todas as buscas finalizadas: ${resultCountLabel.value}.`)
    }
  }
  catch (error: unknown) {
    handleSearchError(error, controller)
  }
  finally {
    endSearch(controller)
  }
}

function applyRemoteDelta(delta: RemoteSearchDelta, reportedTermErrors: Set<number>) {
  isBatchSearch.value = delta.terms.length > 1

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

  const runningIndex = delta.termStates.findIndex(state => state.status === 'RUNNING')
  const running = delta.termStates[runningIndex]
  searchProgress.value = running ? { term: running.term, index: runningIndex + 1, total: delta.termStates.length } : null

  delta.termStates.forEach((state, index) => {
    if (state.status !== 'FAILED' || !state.error || reportedTermErrors.has(index)) return
    reportedTermErrors.add(index)
    errorMessages.value.push(isBatchSearch.value ? `"${state.term}": ${state.error}` : state.error)
  })

  if (delta.cancelRequested) cancelRequested.value = true
}

function finishRemoteSearch(delta: RemoteSearchDelta) {
  if (delta.status === 'DONE') {
    searchFinished.value = true
    appendLog(`✓ Busca finalizada no worker: ${resultCountLabel.value}.`)
  }
  else if (delta.status === 'CANCELLED') {
    appendLog('⚠ Busca cancelada.')
  }
  else if (delta.status === 'FAILED') {
    const message = delta.error ?? 'A busca falhou no worker do PC.'
    errorMessages.value.push(message)
    appendLog(`⚠ ${message}`)
  }
}

/** Acompanha a busca por polling; offsets garantem que logs/prévias/listas finais cheguem uma única vez. */
async function followRemoteSearch(id: string, controller: AbortController) {
  activeRemoteSearchId.value = id
  const offsets = { logs: 0, previews: 0, finals: 0 }
  const reportedTermErrors = new Set<number>()
  let lastStatus: RemoteStatus | null = null
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

    if (delta.status !== lastStatus) {
      if (delta.status === 'PENDING') appendLog('Na fila: aguardando o worker do PC pegar a busca...')
      lastStatus = delta.status
    }

    if (delta.stale) {
      const message = 'O worker parou de responder no meio da busca. Verifique o terminal do pnpm worker.'
      errorMessages.value.push(message)
      appendLog(`⚠ ${message}`)
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

async function runWorkerSearches(terms: string[]) {
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
      appendLog(`Busca enviada para o worker do PC (${terms.length} termo${terms.length === 1 ? '' : 's'}).`)
      if (workerStatus.value && !workerStatus.value.online) {
        appendLog('⚠ O worker do PC parece offline; a busca começa assim que o pnpm worker for iniciado.')
      }
    }
    catch (error: unknown) {
      const existingId = readConflictSearchId(error)
      if (!existingId) throw error
      appendLog(`⚠ ${readFetchError(error)} Acompanhando a busca existente.`)
      id = existingId
    }

    await followRemoteSearch(id, controller)
  }
  catch (error: unknown) {
    handleSearchError(error, controller)
  }
  finally {
    endSearch(controller)
  }
}

/** Ao abrir a tela (em qualquer aparelho), volta a acompanhar uma busca que ainda está na fila/rodando. */
async function resumeRemoteSearch() {
  if (isSearching.value || searchMode.value !== 'worker') return

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
  appendLog('Retomando a busca em andamento no worker do PC.')
  try {
    await followRemoteSearch(search.id, controller)
  }
  catch (error: unknown) {
    handleSearchError(error, controller)
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

function defaultSearchMode(): SearchMode {
  const host = window.location.hostname
  // Aberto no próprio PC/rede local: o navegador roda aqui mesmo. Domínio publicado: usa o worker.
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host.startsWith('192.168.') || host.startsWith('10.')
  return isLocal ? 'direct' : 'worker'
}

function loadSearchMode() {
  try {
    const stored = localStorage.getItem(SEARCH_MODE_STORAGE_KEY)
    searchMode.value = stored === 'worker' || stored === 'direct' ? stored : defaultSearchMode()
  }
  catch {
    searchMode.value = defaultSearchMode()
  }
}

function setSearchMode(mode: SearchMode) {
  if (isSearching.value || searchMode.value === mode) return
  searchMode.value = mode
  try {
    localStorage.setItem(SEARCH_MODE_STORAGE_KEY, mode)
  }
  catch {
    // Preferência auxiliar.
  }
  if (mode === 'worker') {
    void refreshWorkerStatus()
    void resumeRemoteSearch()
  }
}

async function runSearches(terms: string[]) {
  if (terms.length === 0 || isSearching.value) return
  if (searchMode.value === 'worker') await runWorkerSearches(terms)
  else await runDirectSearches(terms)
}

async function startSearch() {
  if (!canSearch.value) return
  const term = searchTerm.value.trim()
  saveRecentSearch(term)
  await runSearches([term])
}

async function searchAllRecent() {
  if (isSearching.value || recentSearches.value.length === 0) return
  await runSearches([...recentSearches.value])
}

async function stopSearch() {
  const remoteId = activeRemoteSearchId.value
  if (!remoteId) {
    searchAbortController.value?.abort()
    return
  }

  // No modo worker, parar = pedir cancelamento; o polling segue até o worker confirmar.
  cancelRequested.value = true
  try {
    await $fetch(`/api/marketplace/remote-searches/${remoteId}/cancel`, { method: 'POST' })
    appendLog('Cancelamento solicitado ao worker do PC...')
  }
  catch (error: unknown) {
    cancelRequested.value = false
    errorMessages.value.push(`Falha ao cancelar: ${readFetchError(error)}`)
  }
}

function relevanceVariant(level: MarketplaceResult['relevanceLevel']): 'success' | 'info' | 'warning' | 'danger' | 'muted' {
  return {
    alta: 'success',
    media: 'info',
    baixa: 'warning',
    descartar: 'danger',
  }[level] ?? 'muted'
}

function relevanceLabel(level: MarketplaceResult['relevanceLevel']): string {
  return {
    alta: 'Alta',
    media: 'Média',
    baixa: 'Baixa',
    descartar: 'Descartar',
  }[level] ?? level
}

onMounted(() => {
  loadRecentSearches()
  loadResultsCache()
  loadSearchMode()
  if (searchMode.value === 'worker') {
    void refreshWorkerStatus()
    void resumeRemoteSearch()
  }
  workerStatusTimer = setInterval(() => {
    if (searchMode.value === 'worker') void refreshWorkerStatus()
  }, WORKER_STATUS_POLL_MS)
})

onBeforeUnmount(() => {
  // Sair da tela só para o acompanhamento; no modo worker a busca continua no PC e pode ser retomada.
  searchAbortController.value?.abort()
  if (workerStatusTimer) clearInterval(workerStatusTimer)
})
</script>

<template>
  <div class="mx-auto flex max-w-7xl flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-bold text-strong">Facebook Marketplace</h1>
        <p class="mt-1 max-w-3xl text-[13px] leading-relaxed text-dim">
          Busca anúncios visíveis usando o perfil local do Playwright, com filtragem semântica e atualização em tempo real.
        </p>
      </div>
      <UiBadge variant="info" size="sm">{{ searchMode === 'worker' ? 'Execução no worker do PC' : 'Execução neste servidor' }}</UiBadge>
    </div>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)]">
      <UiCard class="p-4">
        <h2 class="text-[13px] font-semibold text-soft">Nova busca</h2>
        <p class="mt-1 text-[11.5px] leading-relaxed text-faint">
          Exemplos: rodas 5x112 audi · porta gol g6 · farol corolla 2015
        </p>

        <div class="mt-3 flex flex-col gap-2">
          <div class="grid grid-cols-2 gap-1.5">
            <UiButton type="button" size="xs" :variant="searchMode === 'worker' ? 'primary' : 'secondary'" :disabled="isSearching" @click="setSearchMode('worker')">
              Worker do PC
            </UiButton>
            <UiButton type="button" size="xs" :variant="searchMode === 'direct' ? 'primary' : 'secondary'" :disabled="isSearching" @click="setSearchMode('direct')">
              Este servidor
            </UiButton>
          </div>
          <p v-if="searchMode === 'worker'" class="flex items-start gap-1.5 text-[11px] leading-relaxed" :class="workerStatus?.online ? 'text-success' : 'text-warning'">
            <span class="mt-1.5 size-1.5 shrink-0 rounded-full" :class="workerStatus?.online ? 'bg-success' : 'bg-warning'" />
            <span>{{ workerStatusLabel }}</span>
          </p>
          <p v-else class="text-[11px] leading-relaxed text-faint">
            Abre o navegador na máquina onde este app está rodando. Use quando estiver acessando pelo próprio PC.
          </p>
        </div>

        <form class="mt-4 flex flex-col gap-3" @submit.prevent="startSearch">
          <UiInput v-model="searchTerm" maxlength="80" placeholder="Digite marca, modelo ou peça" :disabled="isSearching" />
          <UiButton v-if="!isSearching" type="submit" block variant="primary" size="md" :disabled="!canSearch">
            Buscar no Marketplace
          </UiButton>
          <UiButton v-else type="button" block variant="danger" size="md" :disabled="cancelRequested" @click="stopSearch">
            {{ cancelRequested ? 'Cancelando...' : 'Parar busca' }}
          </UiButton>
        </form>

        <div v-if="recentSearches.length > 0" class="mt-4 border-t border-line-soft pt-4">
          <div class="mb-2 flex items-center justify-between gap-2">
            <p class="text-[11.5px] font-semibold text-muted">Pesquisas recentes</p>
            <div class="flex items-center gap-1">
              <UiButton
                type="button"
                variant="secondary"
                size="xs"
                :disabled="isSearching"
                :title="`Buscar os ${recentSearches.length} termos em sequência e juntar os resultados`"
                @click="searchAllRecent"
              >
                Procurar tudo
              </UiButton>
              <UiButton type="button" variant="ghost" size="xs" :disabled="isSearching" @click="clearRecentSearches">
                Limpar
              </UiButton>
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <div v-for="recent in recentSearches" :key="recent" class="flex min-w-0 items-center rounded-control border border-line-soft bg-panel-soft">
              <button
                type="button"
                class="min-w-0 flex-1 truncate px-2.5 py-1.5 text-left text-[11.5px] text-dim hover:text-body disabled:cursor-not-allowed disabled:opacity-50"
                :title="`Usar pesquisa: ${recent}`"
                :disabled="isSearching"
                @click="useRecentSearch(recent)"
              >
                {{ recent }}
              </button>
              <button
                type="button"
                class="px-2 py-1.5 text-[13px] leading-none text-faint hover:text-danger"
                :aria-label="`Remover pesquisa ${recent}`"
                @click="removeRecentSearch(recent)"
              >
                ×
              </button>
            </div>
          </div>
          <p class="mt-2 text-[10.5px] text-faint">Salvas somente neste navegador.</p>
        </div>

        <div class="mt-4 border-t border-line-soft pt-4 text-[11.5px] leading-relaxed text-dim">
          <p class="font-semibold text-muted">Sessão do Facebook</p>
          <p class="mt-1">
            Na primeira execução, o Chromium pode abrir a tela de login. Faça a autenticação manualmente e acompanhe o terminal do Nuxt (ou do <code class="font-mono text-[10.5px]">pnpm worker</code>, no modo Worker do PC).
          </p>
          <p class="mt-2 text-warning">
            O perfil fica salvo em <code class="font-mono text-[10.5px]">data/facebook-profile</code>.
          </p>
        </div>
      </UiCard>

      <UiCard class="min-h-[520px] overflow-hidden">
        <div class="flex items-center justify-between border-b border-line bg-panel-muted px-3.5 py-2.5">
          <div>
            <h2 class="text-[13px] font-semibold text-soft">Resultados</h2>
            <p class="mt-0.5 text-[11px] text-faint">
              {{ resultCountLabel }}<template v-if="progressLabel"> · {{ progressLabel }}</template>
            </p>
          </div>
          <div class="flex flex-wrap items-center justify-end gap-1.5">
            <UiBadge v-if="isSearching" variant="info" size="xs">Buscando</UiBadge>
            <UiBadge v-else-if="cachedLabel" variant="muted" size="xs" title="Resultados salvos neste navegador">{{ cachedLabel }}</UiBadge>
            <UiBadge v-else-if="searchFinished" variant="success" size="xs">Concluída</UiBadge>
            <UiButton type="button" variant="ghost" size="xs" @click="openArchived">
              Arquivados
            </UiButton>
            <UiButton v-if="!isSearching && sortedResults.length > 0" type="button" variant="ghost" size="xs" title="Remove os resultados da tela e do cache deste navegador" @click="clearResults">
              Limpar lista
            </UiButton>
          </div>
        </div>

        <div v-if="errorMessages.length > 0" class="m-3 flex flex-col gap-1 rounded-control border border-danger-line bg-danger-bg px-3 py-2 text-[12px] leading-relaxed text-danger">
          <p v-for="(message, index) in errorMessages" :key="index">{{ message }}</p>
        </div>

        <div v-if="sortedResults.length > 0" class="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <article v-for="{ item, terms, previewTerms } in sortedResults" :key="item.url" class="overflow-hidden rounded-card border border-line-soft bg-panel-soft">
            <div v-if="item.image" class="aspect-[4/3] bg-canvas-deep">
              <img :src="item.image" :alt="item.titleRaw" class="size-full object-cover" loading="lazy">
            </div>
            <div v-else class="flex aspect-[4/3] items-center justify-center bg-canvas-deep text-3xl text-faint">🛒</div>
            <div class="flex flex-col gap-2 p-3">
              <div class="flex items-start justify-between gap-2">
                <h3 class="line-clamp-3 text-[13px] font-semibold leading-snug text-body">{{ item.titleRaw }}</h3>
                <div class="flex shrink-0 flex-col items-end gap-1">
                  <UiBadge :variant="relevanceVariant(item.relevanceLevel)" size="xs">{{ relevanceLabel(item.relevanceLevel) }}</UiBadge>
                  <UiBadge v-if="terms.length === 0" variant="muted" size="xs" title="Encontrado na coleta; ainda não validado pelo filtro final">Prévia</UiBadge>
                </div>
              </div>
              <p class="text-[14px] font-bold text-accent-soft">{{ item.priceRaw ?? 'Preço não identificado' }}</p>
              <p class="truncate text-[11.5px] text-dim">{{ item.locationRaw ?? 'Local não identificado' }}</p>
              <div v-if="isBatchSearch" class="flex flex-wrap gap-1">
                <span
                  v-for="foundTerm in [...terms, ...previewTerms]"
                  :key="foundTerm"
                  class="rounded-control border border-line-soft bg-canvas-deep px-1.5 py-0.5 text-[10px] text-dim"
                >
                  {{ foundTerm }}
                </span>
              </div>
              <p v-if="item.semanticReason" class="line-clamp-2 text-[10.5px] leading-relaxed text-faint">{{ item.semanticReason }}</p>
              <div class="mt-1 flex items-center justify-between gap-2">
                <a :href="item.url" target="_blank" rel="noopener noreferrer" class="text-[11.5px] font-semibold text-accent-soft hover:underline">
                  Abrir anúncio ↗
                </a>
                <UiButton
                  type="button"
                  variant="ghost"
                  size="xs"
                  :disabled="archivingUrls.has(item.url)"
                  title="Arquivar: o anúncio não aparece mais nas próximas buscas"
                  @click="archiveResult({ item, terms, previewTerms })"
                >
                  {{ archivingUrls.has(item.url) ? 'Arquivando...' : 'Arquivar' }}
                </UiButton>
              </div>
            </div>
          </article>
        </div>

        <div v-else-if="!isSearching && errorMessages.length === 0" class="flex min-h-[340px] items-center justify-center px-6 text-center">
          <div>
            <div class="text-4xl">🛒</div>
            <p class="mt-3 text-[13px] font-semibold text-soft">Nenhum resultado ainda</p>
            <p class="mt-1 max-w-sm text-[12px] leading-relaxed text-faint">Digite um termo e inicie a busca para ver os anúncios encontrados.</p>
          </div>
        </div>

        <div v-else-if="isSearching && sortedResults.length === 0" class="flex min-h-[340px] items-center justify-center px-6 text-center">
          <div>
            <span class="mx-auto block size-6 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />
            <p class="mt-3 text-[13px] font-semibold text-soft">Coletando anúncios...</p>
            <p class="mt-1 text-[12px] text-faint">Acompanhe o progresso no log abaixo.</p>
          </div>
        </div>
      </UiCard>
    </div>

    <UiCard class="overflow-hidden">
      <div class="flex items-center justify-between border-b border-line bg-panel-muted px-3.5 py-2">
        <span class="text-xs font-semibold text-muted">Log da busca</span>
        <span v-if="isSearching" class="text-[11px] text-info">stream ativo</span>
      </div>
      <div class="scrollbar-dark flex max-h-64 min-h-28 flex-col gap-0.5 overflow-y-auto px-3.5 py-2.5">
        <div v-if="logs.length === 0" class="py-5 text-center text-[12px] text-faint">Nenhuma execução iniciada.</div>
        <div v-for="(line, index) in logs" :key="index" class="font-mono text-[11px] leading-relaxed" :class="line.startsWith('✓') ? 'text-success' : line.startsWith('⚠') ? 'text-danger' : 'text-dim'">
          {{ line }}
        </div>
        <div v-if="isSearching" class="animate-pulse font-mono text-[11px] leading-relaxed text-dim">▌</div>
      </div>
    </UiCard>

    <UiDialog v-model:open="archivedDialogOpen" title="Anúncios arquivados" description="Arquivados não aparecem nas próximas buscas. Restaure para voltar a vê-los.">
      <div v-if="archivedError" class="mb-3 rounded-control border border-danger-line bg-danger-bg px-3 py-2 text-[12px] text-danger">
        {{ archivedError }}
      </div>
      <div v-if="archivedLoading && archivedItems.length === 0" class="py-8 text-center text-[12px] text-faint">Carregando...</div>
      <div v-else-if="archivedItems.length === 0" class="py-8 text-center text-[12px] text-faint">Nenhum anúncio arquivado.</div>
      <div v-else class="flex flex-col gap-2">
        <div v-for="archived in archivedItems" :key="archived.url" class="flex items-center gap-3 rounded-control border border-line-soft bg-panel-soft p-2">
          <img v-if="archived.image" :src="archived.image" :alt="archived.titleRaw" class="size-12 shrink-0 rounded-control object-cover" loading="lazy">
          <div v-else class="flex size-12 shrink-0 items-center justify-center rounded-control bg-canvas-deep text-lg text-faint">🛒</div>
          <div class="min-w-0 flex-1">
            <p class="truncate text-[12.5px] font-semibold text-body">{{ archived.titleRaw }}</p>
            <p class="truncate text-[11px] text-dim">
              {{ archived.priceRaw ?? 'Preço não identificado' }} · {{ archived.locationRaw ?? 'Local não identificado' }}
            </p>
            <p class="truncate text-[10.5px] text-faint">
              Arquivado em {{ formatArchivedAt(archived.archivedAt) }}<template v-if="archived.searchTerms.length"> · {{ archived.searchTerms.join(', ') }}</template>
            </p>
          </div>
          <div class="flex shrink-0 flex-col items-end gap-1">
            <a :href="archived.url" target="_blank" rel="noopener noreferrer" class="text-[11px] font-semibold text-accent-soft hover:underline">Abrir ↗</a>
            <UiButton type="button" variant="secondary" size="xs" :disabled="restoringUrls.has(archived.url)" @click="restoreArchived(archived.url)">
              Restaurar
            </UiButton>
          </div>
        </div>
      </div>
    </UiDialog>
  </div>
</template>
