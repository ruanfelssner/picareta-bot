<script setup lang="ts">
import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '#shared/constants/sources'
import type { AuctionFilters } from '#shared/types/filters'
import type { VehicleSource } from '#shared/types/vehicle'

type ScrapeSourceStatus = 'idle' | 'running' | 'success' | 'error' | 'timeout' | 'cancelled'
type DamageLevel = 'small' | 'medium' | 'normal'
type PeriodFilter = 'upcoming' | 'today' | 'tomorrow' | 'past' | 'all'

interface CountsResponse {
  bySrc: Record<string, number>
  byState: Record<string, number>
  byDamage: Record<'all' | DamageLevel, number>
  byPeriod: Partial<Record<PeriodFilter, number>>
}

interface ScrapeResult {
  total: number
  inserted: number
  updated: number
  skipped: number
  skippedGeo?: number
  skippedExpiredNoSale?: number
  errors: Record<string, string>
}

interface FipeResult {
  total: number
  enriched: number
  failed: number
}

const SOURCE_LABELS: Partial<Record<VehicleSource, string>> = {
  'sodre': 'Sodre',
  'megaleiloes': 'MegaLeilões',
  'claudio-kuss': 'C. Kuss',
  'leiloesjudiciais': 'Judiciais',
  'vipleiloes': 'VIP',
  'ph-batidos': 'PH',
}

const ALL_SOURCES: { id: VehicleSource; label: string }[] = ACTIVE_AUCTION_SOURCES.map(source => ({
  id: source,
  label: SOURCE_LABELS[source] ?? SOURCE_META[source].name,
}))

const scrapeSources = ref<VehicleSource[]>(ALL_SOURCES.map(source => source.id))
const scrapeEnrichFipe = ref(true)
const isScraping = ref(false)
const scrapeLog = ref<string[]>([])
const scrapeResult = ref<ScrapeResult | null>(null)
const scrapeSourceStatuses = ref<Partial<Record<VehicleSource, ScrapeSourceStatus>>>({})
const scrapeAbortController = shallowRef<AbortController | null>(null)

const isEnrichingFipe = ref(false)
const fipeResetFailed = ref(false)
const fipeResult = ref<FipeResult | null>(null)

const { data: filtersData } = await useFetch<{ filters: AuctionFilters }>('/api/filters')
const { data: countsData, refresh: refreshCounts } = await useFetch<CountsResponse>('/api/vehicles/counts', {
  query: { period: 'all', showNoPhoto: 'true' },
})

const selectedSourceCount = computed(() => scrapeSources.value.length)
const allSourcesSelected = computed(() => selectedSourceCount.value === ALL_SOURCES.length)
const canStartScrape = computed(() => selectedSourceCount.value > 0 && !isScraping.value && !isEnrichingFipe.value)
const hasLog = computed(() => scrapeLog.value.length > 0)

const scrapeGeoFilterSummary = computed(() => {
  const filters = filtersData.value?.filters
  const states = filters?.states ?? []
  const cities = filters?.cities ?? []
  if (states.length === 0 && cities.length === 0) return 'todos os estados'

  const parts: string[] = []
  if (states.length > 0) parts.push(states.join(', '))
  if (cities.length > 0) parts.push(cities.join(', '))
  return parts.join(' · ')
})

const scrapeResultSummary = computed(() => {
  const result = scrapeResult.value
  if (!result) return ''

  const parts = [
    `${result.inserted} novo${result.inserted !== 1 ? 's' : ''}`,
    `${result.updated} atualizado${result.updated !== 1 ? 's' : ''}`,
  ]

  const skippedGeo = result.skippedGeo ?? 0
  const skippedExpiredNoSale = result.skippedExpiredNoSale ?? 0
  const skippedOther = Math.max(0, result.skipped - skippedGeo - skippedExpiredNoSale)
  if (skippedGeo > 0) parts.push(`${skippedGeo} fora da região (${scrapeGeoFilterSummary.value})`)
  if (skippedExpiredNoSale > 0) parts.push(`${skippedExpiredNoSale} vencido${skippedExpiredNoSale !== 1 ? 's' : ''} sem venda`)
  if (skippedOther > 0) parts.push(`${skippedOther} descartado${skippedOther !== 1 ? 's' : ''}`)

  return parts.join(' · ')
})

let countsRefreshTimer: ReturnType<typeof setTimeout> | null = null

function scheduleCountsRefresh() {
  if (countsRefreshTimer) return
  countsRefreshTimer = setTimeout(() => {
    countsRefreshTimer = null
    void refreshCounts()
  }, 900)
}

async function flushCountsRefresh() {
  if (countsRefreshTimer) {
    clearTimeout(countsRefreshTimer)
    countsRefreshTimer = null
  }
  await refreshCounts()
}

onBeforeUnmount(() => {
  if (countsRefreshTimer) clearTimeout(countsRefreshTimer)
  scrapeAbortController.value?.abort()
})

function sourceCount(id: string): number {
  return countsData.value?.bySrc[id] ?? 0
}

function toggleValue<T>(values: T[], value: T) {
  const i = values.indexOf(value)
  if (i === -1) values.push(value)
  else values.splice(i, 1)
}

function toggleScrapeSource(source: VehicleSource) {
  if (isScraping.value) return
  toggleValue(scrapeSources.value, source)
}

function selectAllSources() {
  if (isScraping.value) return
  scrapeSources.value = ALL_SOURCES.map(source => source.id)
}

function clearSources() {
  if (isScraping.value) return
  scrapeSources.value = []
}

function resetScrapeSourceStatuses() {
  const next: Partial<Record<VehicleSource, ScrapeSourceStatus>> = {}
  for (const source of scrapeSources.value) next[source] = 'idle'
  scrapeSourceStatuses.value = next
}

function scrapeSourceStatus(source: VehicleSource): ScrapeSourceStatus {
  return scrapeSourceStatuses.value[source] ?? 'idle'
}

function isScrapeSourceStatus(value: unknown): value is ScrapeSourceStatus {
  return value === 'running' || value === 'success' || value === 'error' || value === 'timeout' || value === 'cancelled'
}

function isVehicleSource(value: unknown): value is VehicleSource {
  return typeof value === 'string' && ALL_SOURCES.some(source => source.id === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object'
}

function setScrapeSourceStatus(payload: unknown) {
  if (!isRecord(payload)) return
  if (!isVehicleSource(payload.source) || !isScrapeSourceStatus(payload.status)) return
  scrapeSourceStatuses.value = {
    ...scrapeSourceStatuses.value,
    [payload.source]: payload.status,
  }
}

function markPendingScrapeSourcesCancelled() {
  const next = { ...scrapeSourceStatuses.value }
  for (const source of Object.keys(next) as VehicleSource[]) {
    const status = next[source]
    if (status === 'idle' || status === 'running') next[source] = 'cancelled'
  }
  scrapeSourceStatuses.value = next
}

function scrapeSourceStatusTitle(source: VehicleSource): string {
  const status = scrapeSourceStatus(source)
  if (status === 'running') return 'Rodando agora'
  if (status === 'success') return 'Fonte concluída'
  if (status === 'timeout') return 'Fonte parada por timeout'
  if (status === 'cancelled') return 'Fonte cancelada'
  if (status === 'error') return 'Fonte com erro'
  return 'Aguardando scraping'
}

function isScrapeSourceError(source: VehicleSource): boolean {
  const status = scrapeSourceStatus(source)
  return status === 'error' || status === 'timeout' || status === 'cancelled'
}

function stopScrape() {
  if (!isScraping.value) return
  scrapeLog.value.push('⚠ Parada solicitada pelo usuário.')
  markPendingScrapeSourcesCancelled()
  scrapeAbortController.value?.abort()
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readErrors(value: unknown): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!isRecord(value)) return errors
  for (const [key, message] of Object.entries(value)) {
    if (typeof message === 'string') errors[key] = message
  }
  return errors
}

function parseScrapeResult(payload: unknown): ScrapeResult | null {
  if (!isRecord(payload)) return null
  return {
    total: readNumber(payload.total),
    inserted: readNumber(payload.inserted),
    updated: readNumber(payload.updated),
    skipped: readNumber(payload.skipped),
    skippedGeo: readOptionalNumber(payload.skippedGeo),
    skippedExpiredNoSale: readOptionalNumber(payload.skippedExpiredNoSale),
    errors: readErrors(payload.errors),
  }
}

function parseFipeResult(payload: unknown): FipeResult | null {
  if (!isRecord(payload)) return null
  return {
    total: readNumber(payload.total),
    enriched: readNumber(payload.enriched),
    failed: readNumber(payload.failed),
  }
}

function readMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  return typeof payload.message === 'string' ? payload.message : null
}

function vehicleLogLine(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  const brand = typeof payload.brand === 'string' ? payload.brand : ''
  const model = typeof payload.model === 'string' ? payload.model : ''
  const year = typeof payload.year === 'number' ? ` ${payload.year}` : ''
  const price = typeof payload.price === 'number' ? ` · R$ ${payload.price.toLocaleString('pt-BR')}` : ''
  const label = `${brand} ${model}`.trim()
  return label ? `✓ ${label}${year}${price}` : null
}

async function assertOk(response: Response) {
  if (response.ok) return
  const text = await response.text().catch(() => '')
  throw new Error(text.trim() || `HTTP ${response.status}`)
}

async function readSse(response: Response, handlers: Record<string, (payload: unknown) => Promise<void> | void>) {
  await assertOk(response)

  if (!response.body) {
    scrapeLog.value.push('⚠ Resposta sem stream de eventos.')
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let currentEvent = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed.startsWith('event: ')) {
        currentEvent = trimmed.slice(7)
      }
      else if (trimmed.startsWith('data: ')) {
        try {
          const payload: unknown = JSON.parse(trimmed.slice(6))
          await handlers[currentEvent]?.(payload)
        }
        catch {
          // SSE event ignored when payload is not valid JSON.
        }
        currentEvent = ''
      }
    }
  }
}

async function startScrape() {
  if (!canStartScrape.value) return
  isScraping.value = true
  scrapeLog.value = []
  scrapeResult.value = null
  fipeResult.value = null
  resetScrapeSourceStatuses()
  const controller = new AbortController()
  scrapeAbortController.value = controller

  try {
    const response = await fetch('/api/vehicles/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sources: [...scrapeSources.value],
        enrichFipe: scrapeEnrichFipe.value,
      }),
      signal: controller.signal,
    })

    await readSse(response, {
      vehicle: (payload) => {
        const line = vehicleLogLine(payload)
        if (line) scrapeLog.value.push(line)
        scheduleCountsRefresh()
      },
      log: (payload) => {
        const message = readMessage(payload)
        if (message) scrapeLog.value.push(message)
      },
      source: setScrapeSourceStatus,
      done: async (payload) => {
        scrapeResult.value = parseScrapeResult(payload)
        await flushCountsRefresh()
      },
      error: (payload) => {
        const message = readMessage(payload)
        if (message) scrapeLog.value.push(`⚠ ${message}`)
      },
    })
  }
  catch (error: unknown) {
    if (controller.signal.aborted) {
      markPendingScrapeSourcesCancelled()
      scrapeLog.value.push('⚠ Scraping interrompido.')
    }
    else {
      scrapeLog.value.push(`⚠ Erro: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  finally {
    isScraping.value = false
    if (scrapeAbortController.value === controller) scrapeAbortController.value = null
  }
}

async function startFipeEnrich() {
  if (isEnrichingFipe.value || isScraping.value) return
  isEnrichingFipe.value = true
  fipeResult.value = null
  scrapeResult.value = null
  scrapeLog.value = []

  try {
    const response = await fetch('/api/vehicles/enrich-fipe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reset: fipeResetFailed.value }),
    })

    await readSse(response, {
      log: (payload) => {
        const message = readMessage(payload)
        if (message) scrapeLog.value.push(message)
      },
      done: async (payload) => {
        fipeResult.value = parseFipeResult(payload)
        await refreshCounts()
      },
      error: (payload) => {
        const message = readMessage(payload)
        if (message) scrapeLog.value.push(`⚠ ${message}`)
      },
    })
  }
  catch (error: unknown) {
    scrapeLog.value.push(`⚠ Erro FIPE: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isEnrichingFipe.value = false
  }
}

function goToCars() {
  void navigateTo('/cars')
}
</script>

<template>
  <div class="mx-auto flex max-w-6xl flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-bold text-strong">Scraping</h1>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-dim">
          Rode os scrapers selecionados, acompanhe o log em tempo real e deixe a tela de veículos só para análise e envio.
        </p>
      </div>
      <UiButton variant="secondary" size="sm" @click="goToCars">
        Ver veículos
      </UiButton>
    </div>

    <div class="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(320px,0.8fr)]">
      <UiCard class="p-4">
        <div class="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 class="text-[13px] font-semibold text-soft">Fontes</h2>
            <p class="mt-1 text-[11.5px] text-faint">Região de exibição/envio: {{ scrapeGeoFilterSummary }}</p>
          </div>
          <div class="flex gap-2">
            <UiButton variant="secondary" size="xs" :disabled="isScraping || allSourcesSelected" @click="selectAllSources">
              Todas
            </UiButton>
            <UiButton variant="dashed" size="xs" :disabled="isScraping || selectedSourceCount === 0" @click="clearSources">
              Limpar
            </UiButton>
          </div>
        </div>

        <div class="flex flex-wrap gap-1.5">
          <UiChip
            v-for="source in ALL_SOURCES"
            :key="source.id"
            :active="scrapeSources.includes(source.id)"
            :class="isScraping && 'pointer-events-none opacity-70'"
            @click="toggleScrapeSource(source.id)"
          >
            {{ source.label }}
            <span v-if="sourceCount(source.id) > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
              {{ sourceCount(source.id) }}
            </span>
            <span
              v-if="scrapeSourceStatus(source.id) === 'running'"
              class="inline-block size-3 shrink-0 animate-spin rounded-full border border-accent/30 border-t-accent"
              :title="scrapeSourceStatusTitle(source.id)"
            />
            <span
              v-else-if="scrapeSourceStatus(source.id) === 'success'"
              class="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-success/15 text-[9px] font-bold text-success"
              :title="scrapeSourceStatusTitle(source.id)"
            >
              ✓
            </span>
            <span
              v-else-if="isScrapeSourceError(source.id)"
              class="inline-flex size-3.5 shrink-0 items-center justify-center rounded-full bg-danger-bg text-[9px] font-bold text-danger"
              :title="scrapeSourceStatusTitle(source.id)"
            >
              !
            </span>
          </UiChip>
        </div>

        <p v-if="selectedSourceCount === 0" class="mt-3 text-[12px] font-medium text-warning">
          Selecione pelo menos uma fonte para iniciar.
        </p>
      </UiCard>

      <UiCard class="p-4">
        <h2 class="mb-3 text-[13px] font-semibold text-soft">Execução</h2>

        <label
          class="mb-3 flex cursor-pointer select-none items-center justify-between gap-3 text-[12px] font-semibold text-muted"
          :class="isScraping && 'pointer-events-none opacity-60'"
        >
          <span>Buscar FIPE após scraping</span>
          <UiSwitch v-model="scrapeEnrichFipe" />
        </label>

        <UiButton v-if="!isScraping" block variant="primary" size="md" :disabled="!canStartScrape" @click="startScrape">
          Scrapar agora
        </UiButton>
        <UiButton v-else block variant="danger" size="md" @click="stopScrape">
          <span class="inline-block size-3.5 animate-spin rounded-full border-2 border-danger/30 border-t-danger" />
          Parar scraping
        </UiButton>

        <div class="mt-4 border-t border-line-soft pt-4">
          <div class="mb-2 flex items-center justify-between gap-3">
            <h3 class="text-[12px] font-semibold text-muted">FIPE pendentes</h3>
            <label class="flex cursor-pointer select-none items-center gap-2 text-[11.5px] text-soft">
              <span>Reintentar falhas</span>
              <UiSwitch v-model="fipeResetFailed" />
            </label>
          </div>
          <UiButton block variant="secondary" size="md" :loading="isEnrichingFipe" :disabled="isScraping || isEnrichingFipe" @click="startFipeEnrich">
            {{ isEnrichingFipe ? 'Buscando FIPE...' : 'Buscar FIPE pendentes' }}
          </UiButton>
          <p v-if="fipeResult" class="mt-2 text-[11.5px] text-faint">
            {{ fipeResult.enriched }} encontrado(s) · {{ fipeResult.failed }} sem match · {{ fipeResult.total }} total
          </p>
        </div>
      </UiCard>
    </div>

    <UiCard class="overflow-hidden">
      <div class="flex items-center justify-between border-b border-line bg-panel-muted px-3.5 py-2">
        <span class="text-xs font-semibold text-muted">Log do scraping</span>
        <span v-if="scrapeResult" class="text-xs font-semibold text-success">
          {{ scrapeResultSummary }}
        </span>
      </div>
      <div class="scrollbar-dark flex max-h-[460px] min-h-60 flex-col gap-0.5 overflow-y-auto px-3.5 py-2.5">
        <div v-if="!hasLog && !isScraping && !isEnrichingFipe" class="py-12 text-center text-[12.5px] text-faint">
          Nenhuma execução iniciada.
        </div>
        <div
          v-for="(line, index) in scrapeLog"
          :key="index"
          class="font-mono text-[11px] leading-relaxed"
          :class="line.startsWith('✓') ? 'text-success' : line.startsWith('⚠') ? 'text-danger' : 'text-dim'"
        >
          {{ line }}
        </div>
        <div v-if="isScraping || isEnrichingFipe" class="animate-pulse font-mono text-[11px] leading-relaxed text-dim">▌</div>
      </div>
    </UiCard>
  </div>
</template>
