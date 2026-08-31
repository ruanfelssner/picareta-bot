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

type SseHandler = (payload: unknown) => void

const RECENT_SEARCHES_STORAGE_KEY = 'bot-anuncios.marketplace.recent-searches.v1'
const MAX_RECENT_SEARCHES = 8

const searchTerm = ref('')
const recentSearches = ref<string[]>([])
const isSearching = ref(false)
const logs = ref<string[]>([])
const results = ref<MarketplaceResult[]>([])
const errorMessage = ref<string | null>(null)
const searchFinished = ref(false)
const searchAbortController = shallowRef<AbortController | null>(null)

const resultCountLabel = computed(() => {
  const count = results.value.length
  return `${count} resultado${count === 1 ? '' : 's'}`
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readMessage(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.message !== 'string') return null
  return payload.message
}

function readResult(payload: unknown): MarketplaceResult | null {
  if (!isRecord(payload) || !isRecord(payload.item)) return null
  const item = payload.item
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

function appendLog(message: string) {
  if (!message) return
  logs.value.push(message)
  if (logs.value.length > 250) logs.value.splice(0, logs.value.length - 250)
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

async function startSearch() {
  if (!canSearch.value) return

  const term = searchTerm.value.trim()
  const controller = new AbortController()
  searchAbortController.value = controller
  isSearching.value = true
  searchFinished.value = false
  errorMessage.value = null
  logs.value = []
  results.value = []
  saveRecentSearch(term)

  try {
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
        if (message) appendLog(message)
      },
      result: (payload) => {
        const item = readResult(payload)
        if (item) results.value.push(item)
      },
      done: () => {
        searchFinished.value = true
        appendLog(`✓ Busca finalizada: ${resultCountLabel.value}.`)
      },
      error: (payload) => {
        const message = readMessage(payload) ?? 'Falha na busca do Marketplace.'
        errorMessage.value = message
        appendLog(`⚠ ${message}`)
      },
    })
  }
  catch (error: unknown) {
    if (controller.signal.aborted) {
      appendLog('⚠ Busca interrompida.')
    }
    else {
      const message = error instanceof Error ? error.message : String(error)
      errorMessage.value = message
      appendLog(`⚠ ${message}`)
    }
  }
  finally {
    isSearching.value = false
    if (searchAbortController.value === controller) searchAbortController.value = null
  }
}

function stopSearch() {
  searchAbortController.value?.abort()
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

onMounted(loadRecentSearches)
onBeforeUnmount(stopSearch)
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
      <UiBadge variant="info" size="sm">Execução local</UiBadge>
    </div>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)]">
      <UiCard class="p-4">
        <h2 class="text-[13px] font-semibold text-soft">Nova busca</h2>
        <p class="mt-1 text-[11.5px] leading-relaxed text-faint">
          Exemplos: rodas 5x112 audi · porta gol g6 · farol corolla 2015
        </p>

        <form class="mt-4 flex flex-col gap-3" @submit.prevent="startSearch">
          <UiInput v-model="searchTerm" maxlength="80" placeholder="Digite marca, modelo ou peça" :disabled="isSearching" />
          <UiButton v-if="!isSearching" type="submit" block variant="primary" size="md" :disabled="!canSearch">
            Buscar no Marketplace
          </UiButton>
          <UiButton v-else type="button" block variant="danger" size="md" @click="stopSearch">
            Parar busca
          </UiButton>
        </form>

        <div v-if="recentSearches.length > 0" class="mt-4 border-t border-line-soft pt-4">
          <div class="mb-2 flex items-center justify-between gap-2">
            <p class="text-[11.5px] font-semibold text-muted">Pesquisas recentes</p>
            <UiButton type="button" variant="ghost" size="xs" @click="clearRecentSearches">
              Limpar
            </UiButton>
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
            Na primeira execução, o Chromium pode abrir a tela de login. Faça a autenticação manualmente e acompanhe o terminal do Nuxt.
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
            <p class="mt-0.5 text-[11px] text-faint">{{ resultCountLabel }}</p>
          </div>
          <UiBadge v-if="searchFinished" variant="success" size="xs">Concluída</UiBadge>
          <UiBadge v-else-if="isSearching" variant="info" size="xs">Buscando</UiBadge>
        </div>

        <div v-if="errorMessage" class="m-3 rounded-control border border-danger-line bg-danger-bg px-3 py-2 text-[12px] leading-relaxed text-danger">
          {{ errorMessage }}
        </div>

        <div v-if="results.length > 0" class="grid gap-3 p-3 sm:grid-cols-2 xl:grid-cols-3">
          <article v-for="item in results" :key="item.url" class="overflow-hidden rounded-card border border-line-soft bg-panel-soft">
            <div v-if="item.image" class="aspect-[4/3] bg-canvas-deep">
              <img :src="item.image" :alt="item.titleRaw" class="size-full object-cover" loading="lazy">
            </div>
            <div v-else class="flex aspect-[4/3] items-center justify-center bg-canvas-deep text-3xl text-faint">🛒</div>
            <div class="flex flex-col gap-2 p-3">
              <div class="flex items-start justify-between gap-2">
                <h3 class="line-clamp-3 text-[13px] font-semibold leading-snug text-body">{{ item.titleRaw }}</h3>
                <UiBadge :variant="relevanceVariant(item.relevanceLevel)" size="xs">{{ relevanceLabel(item.relevanceLevel) }}</UiBadge>
              </div>
              <p class="text-[14px] font-bold text-accent-soft">{{ item.priceRaw ?? 'Preço não identificado' }}</p>
              <p class="truncate text-[11.5px] text-dim">{{ item.locationRaw ?? 'Local não identificado' }}</p>
              <p v-if="item.semanticReason" class="line-clamp-2 text-[10.5px] leading-relaxed text-faint">{{ item.semanticReason }}</p>
              <a :href="item.url" target="_blank" rel="noopener noreferrer" class="mt-1 text-[11.5px] font-semibold text-accent-soft hover:underline">
                Abrir anúncio ↗
              </a>
            </div>
          </article>
        </div>

        <div v-else-if="!isSearching && !errorMessage" class="flex min-h-[340px] items-center justify-center px-6 text-center">
          <div>
            <div class="text-4xl">🛒</div>
            <p class="mt-3 text-[13px] font-semibold text-soft">Nenhum resultado ainda</p>
            <p class="mt-1 max-w-sm text-[12px] leading-relaxed text-faint">Digite um termo e inicie a busca para ver os anúncios encontrados.</p>
          </div>
        </div>

        <div v-else-if="isSearching && results.length === 0" class="flex min-h-[340px] items-center justify-center px-6 text-center">
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
  </div>
</template>
