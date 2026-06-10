<script setup lang="ts">
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui'
import type { Ref } from 'vue'
import type { AuctionComboRule, AuctionFilters } from '#shared/types/filters'
import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import type { VehicleDisplayRuleEvaluation } from '#shared/utils/vehicle-display-rules'

type VehicleListRecord = VehicleRecord & {
  displayRule?: VehicleDisplayRuleEvaluation
}

interface VehiclesResponse {
  vehicles: VehicleListRecord[]
  total: number
  rules: {
    enabled: boolean
    active: number
    hidden: number
  }
}

const ALL_SOURCES: { id: VehicleSource; label: string }[] = [
  { id: 'vs-veiculos', label: 'VS Veículos' },
  { id: 'sodre', label: 'Sodre' },
  { id: 'copart', label: 'Copart' },
  { id: 'favareto', label: 'Favareto' },
  { id: 'megaleiloes', label: 'MegaLeilões' },
  { id: 'lucinei', label: 'Lucinei' },
  { id: 'vardana', label: 'Vardana' },
  { id: 'claudio-kuss', label: 'C. Kuss' },
  { id: 'superbid', label: 'Superbid' },
  { id: 'leiloesjudiciais', label: 'Judiciais' },
  { id: 'vipleiloes', label: 'VIP' },
  { id: 'mgl', label: 'MGL' },
]

const BRAZIL_STATES = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
  'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]

const SORT_OPTIONS = [
  { value: 'recommended', label: 'Classificação' },
  { value: 'auction_date', label: 'Data do leilão' },
  { value: 'recent', label: 'Mais recentes' },
  { value: 'distance_pr', label: 'Mais próximo (PR)' },
  { value: 'small_damage', label: 'Pequena monta' },
  { value: 'fipe_asc', label: 'Maior margem' },
  { value: 'price_asc', label: 'Menor preço' },
  { value: 'price_desc', label: 'Maior preço' },
  { value: 'year_desc', label: 'Mais novos' },
  { value: 'km_asc', label: 'Menor km' },
]

const PRICE_MIN = 0
const PRICE_MAX = 300_000
const PRICE_STEP = 5_000
const YEAR_MIN = 2000
const YEAR_MAX = new Date().getFullYear() + 1

const sidebarOpen = ref(true)
const activeTab = ref<'display' | 'scraping'>('display')

const displaySources = ref<VehicleSource[]>([])
const displayStates = ref<string[]>([])
const displayCities = ref<string[]>([])
const cityInput = ref('')
const search = ref('')
const minPrice = ref<number | null>(null)
const maxPrice = ref<number | null>(null)
const minYear = ref<number | null>(null)
const maxYear = ref<number | null>(null)
const hasFipeOnly = ref(false)
const maxFipePct = ref<number | null>(null)
const sort = ref('recommended')
const page = ref(1)
const comboRules = ref<AuctionComboRule[]>([])
const rulesEnabled = ref(true)

const scrapeSources = ref<VehicleSource[]>([])
const isScraping = ref(false)
const scrapeLog = ref<string[]>([])
const showLog = ref(false)
const scrapeResult = ref<{ total: number; inserted: number; skipped: number; errors: Record<string, string> } | null>(null)
const sendingVehicles = ref<string[]>([])

const showRulesModal = ref(false)
const draftRules = ref<AuctionComboRule[]>([])
const savingRules = ref(false)

const query = computed(() => {
  const params: Record<string, unknown> = { page: page.value, limit: 50, sort: sort.value }
  if (displaySources.value.length > 0) params['sources'] = displaySources.value.join(',')
  if (displayStates.value.length > 0) params['states'] = displayStates.value.join(',')
  if (displayCities.value.length > 0) params['cities'] = displayCities.value.join(',')
  if (search.value.trim()) params['search'] = search.value.trim()
  if (minPrice.value != null) params['minPrice'] = minPrice.value
  if (maxPrice.value != null) params['maxPrice'] = maxPrice.value
  if (minYear.value != null) params['minYear'] = minYear.value
  if (maxYear.value != null) params['maxYear'] = maxYear.value
  if (hasFipeOnly.value) params['hasFipe'] = 'true'
  if (maxFipePct.value != null) params['maxFipePct'] = maxFipePct.value
  params['rules'] = rulesEnabled.value ? 'true' : 'false'
  return params
})

const { data, refresh } = await useFetch<VehiclesResponse>('/api/vehicles', { query })
const { data: countsData, refresh: refreshCounts } = await useFetch<{
  bySrc: Record<string, number>
  byState: Record<string, number>
}>('/api/vehicles/counts')
const { data: filtersData } = await useFetch<{ filters: AuctionFilters }>('/api/filters')

const vehicles = computed(() => data.value?.vehicles ?? [])
const total = computed(() => data.value?.total ?? 0)
const ruleSummary = computed(() => data.value?.rules ?? { enabled: rulesEnabled.value, active: 0, hidden: 0 })
const totalPages = computed(() => Math.ceil(total.value / 50))
const srcCount = (id: string) => countsData.value?.bySrc[id] ?? 0
const stateCount = (uf: string) => countsData.value?.byState[uf] ?? 0

watch(
  [search, minPrice, maxPrice, minYear, maxYear, hasFipeOnly, maxFipePct, displaySources, displayStates, displayCities, sort, rulesEnabled],
  () => { page.value = 1 },
)

watch(() => filtersData.value, (value) => {
  if (!value) return
  comboRules.value = (value.filters.comboRules ?? []).map(rule => ({ ...rule }))
}, { immediate: true })

const activeDisplayFilters = computed(() => {
  let count = 0
  if (displaySources.value.length > 0) count++
  if (displayStates.value.length > 0) count++
  if (displayCities.value.length > 0) count++
  if (search.value.trim()) count++
  if (minPrice.value != null || maxPrice.value != null) count++
  if (minYear.value != null || maxYear.value != null) count++
  if (hasFipeOnly.value || maxFipePct.value != null) count++
  if (rulesEnabled.value && comboRules.value.some(rule => rule.enabled)) count++
  return count
})

function toNullableNumber(value: string | number | null | undefined): number | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function toggleValue<T>(values: T[], value: T) {
  const i = values.indexOf(value)
  if (i === -1) values.push(value)
  else values.splice(i, 1)
}

function addDisplayCity() {
  const value = cityInput.value.trim()
  if (value && !displayCities.value.includes(value)) displayCities.value.push(value)
  cityInput.value = ''
}

function removeDisplayCity(city: string) {
  displayCities.value = displayCities.value.filter(item => item !== city)
}

function clearDisplayFilters() {
  displaySources.value = []
  displayStates.value = []
  displayCities.value = []
  search.value = ''
  minPrice.value = null
  maxPrice.value = null
  minYear.value = null
  maxYear.value = null
  hasFipeOnly.value = false
  maxFipePct.value = null
  sort.value = 'recommended'
  rulesEnabled.value = false
}

function openRulesModal() {
  draftRules.value = comboRules.value.map(rule => ({ ...rule }))
  showRulesModal.value = true
}

function addDraftRule() {
  draftRules.value.push({
    id: crypto.randomUUID(),
    enabled: true,
    mode: 'include',
    brand: null,
    model: null,
    text: null,
    minYear: null,
  })
}

function removeDraftRule(id: string) {
  draftRules.value = draftRules.value.filter(rule => rule.id !== id)
}

async function applyRules() {
  savingRules.value = true
  try {
    await $fetch('/api/filters', {
      method: 'PUT',
      body: { comboRules: draftRules.value },
    })
    comboRules.value = draftRules.value.map(rule => ({ ...rule }))
    await refresh()
    showRulesModal.value = false
  }
  catch {
    scrapeLog.value.push('⚠ Erro ao salvar regras de exibição')
    showLog.value = true
  }
  finally {
    savingRules.value = false
  }
}

function isSendingVehicle(id: string | undefined): boolean {
  return id != null && sendingVehicles.value.includes(id)
}

async function sendVehicle(vehicle: VehicleRecord) {
  const id = vehicle._id
  if (!id || isSendingVehicle(id)) return

  sendingVehicles.value = [...sendingVehicles.value, id]
  try {
    await $fetch(`/api/vehicles/${id}/send`, { method: 'POST' })
    await refresh()
    await refreshCounts()
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    scrapeLog.value.push(`⚠ Erro ao enviar: ${message.replace(/^.*?:\s*/, '').slice(0, 120)}`)
    showLog.value = true
  }
  finally {
    sendingVehicles.value = sendingVehicles.value.filter(item => item !== id)
  }
}

async function startScrape() {
  if (isScraping.value) return
  isScraping.value = true
  scrapeLog.value = []
  scrapeResult.value = null
  showLog.value = true

  try {
    const body = scrapeSources.value.length > 0
      ? JSON.stringify({ sources: scrapeSources.value })
      : '{}'

    const response = await fetch('/api/vehicles/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!response.body) return

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
            const payload = JSON.parse(trimmed.slice(6))
            if (currentEvent === 'vehicle') {
              const price = payload.price != null ? ` · R$ ${payload.price.toLocaleString('pt-BR')}` : ''
              scrapeLog.value.push(`✓ ${payload.brand} ${payload.model} ${payload.year ?? ''}${price}`)
            }
            else if (currentEvent === 'log') {
              scrapeLog.value.push(payload.message)
            }
            else if (currentEvent === 'done') {
              scrapeResult.value = payload
              await refresh()
              await refreshCounts()
            }
            else if (currentEvent === 'error') {
              scrapeLog.value.push(`⚠ ${payload.message}`)
            }
          }
          catch {
            // SSE event ignored when payload is not valid JSON.
          }
          currentEvent = ''
        }
      }
    }
  }
  catch (error: unknown) {
    scrapeLog.value.push(`⚠ Erro: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    isScraping.value = false
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">

    <div class="flex items-start gap-3">
      <Transition name="slide-left">
        <aside
          v-if="sidebarOpen"
          class="sticky top-16 flex max-h-[calc(100vh-80px)] w-[264px] shrink-0 flex-col overflow-hidden rounded-card border border-line bg-panel"
        >
          <TabsRoot v-model="activeTab">
            <TabsList class="flex shrink-0 border-b border-line">
              <TabsTrigger
                value="display"
                class="mb-[-1px] flex flex-1 items-center justify-center gap-1.5 border-b-2 border-transparent bg-transparent px-3 py-2.5 text-xs font-semibold text-dim transition hover:bg-[#1f2333] hover:text-soft data-[state=active]:border-accent data-[state=active]:text-accent-soft"
              >
                Exibição
                <UiBadge v-if="activeDisplayFilters > 0" size="xs">{{ activeDisplayFilters }}</UiBadge>
              </TabsTrigger>
              <TabsTrigger
                value="scraping"
                class="mb-[-1px] flex flex-1 items-center justify-center gap-1.5 border-b-2 border-transparent bg-transparent px-3 py-2.5 text-xs font-semibold text-dim transition hover:bg-[#1f2333] hover:text-soft data-[state=active]:border-accent data-[state=active]:text-accent-soft"
              >
                Scraping
              </TabsTrigger>
            </TabsList>
          </TabsRoot>

          <div class="scrollbar-dark flex-1 overflow-y-auto px-3 py-2.5">
            <template v-if="activeTab === 'display'">
              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
                  Fontes
                  <button v-if="displaySources.length > 0" class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300" @click="displaySources = []">
                    limpar
                  </button>
                </div>
                <div class="flex flex-wrap gap-1">
                  <UiChip :active="displaySources.length === 0" @click="displaySources = []">Todas</UiChip>
                  <UiChip
                    v-for="source in ALL_SOURCES"
                    :key="source.id"
                    :active="displaySources.includes(source.id)"
                    @click="toggleValue(displaySources, source.id)"
                  >
                    {{ source.label }}
                    <span v-if="srcCount(source.id) > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ srcCount(source.id) }}
                    </span>
                  </UiChip>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">Buscar</div>
                <UiInput v-model="search" size="sm" type="text" placeholder="Marca ou modelo..." />
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">Preço (R$)</div>
                <div class="flex items-center gap-1.5">
                  <UiInput :model-value="minPrice ?? ''" size="sm" type="number" placeholder="Mín" @update:model-value="minPrice = toNullableNumber($event)" />
                  <span class="shrink-0 text-xs text-faint">-</span>
                  <UiInput :model-value="maxPrice ?? ''" size="sm" type="number" placeholder="Máx" @update:model-value="maxPrice = toNullableNumber($event)" />
                </div>
                <UiSlider
                  :min="PRICE_MIN"
                  :max="PRICE_MAX"
                  :step="PRICE_STEP"
                  :model-value-min="minPrice"
                  :model-value-max="maxPrice"
                  @update:model-value-min="minPrice = $event"
                  @update:model-value-max="maxPrice = $event"
                />
                <div class="mt-px flex items-center justify-between text-[10px] text-disabled">
                  <span>0</span>
                  <span v-if="minPrice != null || maxPrice != null" class="font-semibold text-accent">
                    {{ minPrice != null ? `R$ ${minPrice.toLocaleString('pt-BR')}` : 'sem mín' }}
                    -
                    {{ maxPrice != null ? `R$ ${maxPrice.toLocaleString('pt-BR')}` : 'sem máx' }}
                  </span>
                  <span>300k</span>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">Ano</div>
                <div class="flex items-center gap-1.5">
                  <UiInput :model-value="minYear ?? ''" size="sm" type="number" placeholder="2000" @update:model-value="minYear = toNullableNumber($event)" />
                  <span class="shrink-0 text-xs text-faint">-</span>
                  <UiInput :model-value="maxYear ?? ''" size="sm" type="number" placeholder="2025" @update:model-value="maxYear = toNullableNumber($event)" />
                </div>
                <UiSlider
                  :min="YEAR_MIN"
                  :max="YEAR_MAX"
                  :step="1"
                  :model-value-min="minYear"
                  :model-value-max="maxYear"
                  @update:model-value-min="minYear = $event"
                  @update:model-value-max="maxYear = $event"
                />
                <div class="mt-px flex items-center justify-between text-[10px] text-disabled">
                  <span>{{ YEAR_MIN }}</span>
                  <span v-if="minYear != null || maxYear != null" class="font-semibold text-accent">
                    {{ minYear ?? YEAR_MIN }} - {{ maxYear ?? YEAR_MAX }}
                  </span>
                  <span>{{ YEAR_MAX }}</span>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">FIPE</div>
                <label class="flex cursor-pointer select-none items-center gap-1.5 text-xs text-soft">
                  <input v-model="hasFipeOnly" type="checkbox" class="accent-accent" />
                  <span>Apenas com FIPE</span>
                </label>
                <div v-if="hasFipeOnly" class="mt-1.5 flex items-center gap-1.5">
                  <span class="shrink-0 text-xs text-faint">Máx %</span>
                  <UiInput :model-value="maxFipePct ?? ''" size="sm" type="number" placeholder="75" @update:model-value="maxFipePct = toNullableNumber($event)" />
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">Ordenar</div>
                <div class="mb-0.5 flex flex-col gap-px">
                  <UiSelect v-model="sort">
                    <option
                      v-for="option in SORT_OPTIONS"
                      :key="option.value"
                      :value="option.value"
                    >
                      {{ option.label }}
                    </option>
                  </UiSelect>
                </div>
                <p class="mt-1 text-[10.5px] leading-normal text-faint">
                  Classificação: data do leilão, sem foto por último, recentes, PR, pequena monta e margem.
                </p>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
                  Estados
                  <button v-if="displayStates.length > 0" class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300" @click="displayStates = []">
                    limpar
                  </button>
                </div>
                <p class="mt-1 text-[10.5px] leading-normal text-faint">Vazio = todos os estados.</p>
                <div class="mt-1 flex flex-wrap gap-1">
                  <button
                    v-for="uf in BRAZIL_STATES"
                    :key="uf"
                    class="flex min-w-9 flex-col items-center rounded border px-1 py-1 text-[10.5px] font-semibold leading-none transition"
                    :class="displayStates.includes(uf)
                      ? 'border-accent bg-surface text-accent-soft'
                      : 'border-line-soft bg-transparent text-dim hover:border-line-hover hover:text-soft'"
                    @click="toggleValue(displayStates, uf)"
                  >
                    {{ uf }}
                    <span v-if="stateCount(uf) > 0" class="mt-0.5 text-[8.5px] font-bold text-dim">{{ stateCount(uf) }}</span>
                  </button>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">Cidades</div>
                <div class="mb-1.5 flex gap-1.5">
                  <UiInput v-model="cityInput" size="sm" placeholder="ex: Curitiba" @keydown.enter.prevent="addDisplayCity" />
                  <UiButton variant="primary" size="sm" @click="addDisplayCity">+</UiButton>
                </div>
                <div class="flex flex-wrap gap-1">
                  <span v-for="city in displayCities" :key="city" class="flex items-center gap-1 rounded bg-surface px-2 py-1 text-[11px] text-accent-soft">
                    {{ city }}
                    <button class="p-0 text-[10px] text-dim hover:text-danger" @click="removeDisplayCity(city)">x</button>
                  </span>
                  <span v-if="displayCities.length === 0" class="text-[11px] text-line-soft">nenhuma</span>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
                  Regras de exibição
                  <UiSwitch v-model="rulesEnabled" :title="rulesEnabled ? 'Desativar regras' : 'Ativar regras'" />
                </div>
                <UiButton :class="!rulesEnabled && 'opacity-45'" block variant="secondary" size="sm" @click="openRulesModal">
                  Gerenciar regras
                  <UiBadge v-if="comboRules.some(rule => rule.enabled)" size="xs">
                    {{ comboRules.filter(rule => rule.enabled).length }}
                  </UiBadge>
                </UiButton>
                <p class="mt-1 text-[10.5px] leading-normal text-faint">
                  {{ rulesEnabled ? 'Includes definem a lista; excludes removem dela.' : 'Regras desativadas - exibindo todos.' }}
                </p>
              </div>

              <div v-if="activeDisplayFilters > 0" class="py-2">
                <UiButton block variant="dashed" size="sm" @click="clearDisplayFilters">
                  Limpar todos os filtros
                </UiButton>
              </div>
            </template>

            <template v-else>
              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
                  Fontes a scrapar
                  <button v-if="scrapeSources.length > 0" class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300" @click="scrapeSources = []">
                    todas
                  </button>
                </div>
                <p class="mt-1 text-[10.5px] leading-normal text-faint">Vazio = roda todos os scrapers.</p>
                <div class="mt-1.5 flex flex-wrap gap-1">
                  <UiChip
                    v-for="source in ALL_SOURCES"
                    :key="source.id"
                    :active="scrapeSources.includes(source.id)"
                    @click="toggleValue(scrapeSources, source.id)"
                  >
                    {{ source.label }}
                    <span v-if="srcCount(source.id) > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ srcCount(source.id) }}
                    </span>
                  </UiChip>
                </div>
              </div>

              <div class="py-2">
                <UiButton block variant="primary" size="md" :loading="isScraping" :disabled="isScraping" @click="startScrape">
                  {{ isScraping ? 'Scraping...' : 'Scrapar agora' }}
                </UiButton>
              </div>
            </template>
          </div>
        </aside>
      </Transition>

      <main class="min-w-0 flex-1 gap-3">
        

        <div v-if="vehicles.length > 0" class="grid grid-cols-4 gap-3">
          <VehicleCard
            v-for="vehicle in vehicles"
            :key="vehicle._id"
            :vehicle="vehicle"
            :show-send-button="!isSendingVehicle(vehicle._id)"
            @send="sendVehicle"
            :compact="false"
          />
        </div>
        <div v-else class="px-5 py-[60px] text-center text-sm text-faint">
          Nenhum veículo. Ajuste os filtros ou execute um scraping.
        </div>
        <div class="flex items-center gap-3">

      <span class="flex-1 text-center text-[13px] text-dim">
        {{ vehicles.length !== total ? `${vehicles.length} de ` : '' }}{{ total.toLocaleString('pt-BR') }} veículo{{ total !== 1 ? 's' : '' }}
        <span v-if="rulesEnabled && ruleSummary.hidden > 0" class="text-warning">
          · {{ ruleSummary.hidden }} oculto{{ ruleSummary.hidden !== 1 ? 's' : '' }} pelas regras
        </span>
      </span>
          
            <div v-if="totalPages > 1" class="mb-3.5 flex items-center justify-end gap-2.5 text-[13px] text-soft">
              <UiButton variant="secondary" size="icon" :disabled="page === 1" @click="page--">‹</UiButton>
              <span>{{ page }} / {{ totalPages }}</span>
              <UiButton variant="secondary" size="icon" :disabled="page === totalPages" @click="page++">›</UiButton>
            </div>
        </div>
      </main>
    </div>

    <Transition name="slide-up">
      <div v-if="showLog" class="mt-1 overflow-hidden rounded-card border border-line bg-canvas-deep">
        <div class="flex items-center justify-between border-b border-line bg-panel-muted px-3.5 py-2">
          <span class="text-xs font-semibold text-muted">Log do scrape</span>
          <div class="flex items-center gap-3">
            <span v-if="scrapeResult" class="text-xs font-semibold text-success">
              {{ scrapeResult.inserted }} novo{{ scrapeResult.inserted !== 1 ? 's' : '' }} ·
              {{ scrapeResult.skipped }} filtrado{{ scrapeResult.skipped !== 1 ? 's' : '' }}
            </span>
            <button class="px-1 text-[13px] text-dim hover:text-body" @click="showLog = false">x</button>
          </div>
        </div>
        <div class="scrollbar-dark flex max-h-[220px] flex-col gap-0.5 overflow-y-auto px-3.5 py-2.5">
          <div
            v-for="(line, index) in scrapeLog"
            :key="index"
            class="font-mono text-[11px] leading-relaxed"
            :class="line.startsWith('✓') ? 'text-success' : line.startsWith('⚠') ? 'text-danger' : 'text-dim'"
          >
            {{ line }}
          </div>
          <div v-if="isScraping" class="animate-pulse font-mono text-[11px] leading-relaxed text-dim">▌</div>
        </div>
      </div>
    </Transition>

    <Transition name="modal">
      <UiDialog
        v-if="showRulesModal"
        v-model:open="showRulesModal"
        title="Regras de Exibição"
        description="Regras de inclusão definem o que aparece; regras de exclusão removem mesmo quando uma inclusão casar."
      >
        <div v-if="draftRules.length === 0" class="px-5 py-9 text-center text-[13px] text-dim">
          Nenhuma regra. Use "Nova regra" abaixo para começar.
        </div>

        <div v-else class="flex flex-col gap-2.5">
          <div
            v-for="(rule, index) in draftRules"
            :key="rule.id"
            :class="['overflow-hidden rounded-lg border border-line-soft bg-panel-soft transition', !rule.enabled && 'opacity-45']"
          >
            <div class="flex items-center gap-2.5 border-b border-line-soft bg-panel-muted px-3.5 py-2.5">
              <span class="min-w-5 text-[11px] font-bold text-faint">#{{ index + 1 }}</span>
              <div class="flex overflow-hidden rounded border border-line">
                <button
                  class="px-3 py-1 text-[11px] font-semibold transition hover:bg-[#1e2235] hover:text-soft"
                  :class="rule.mode === 'include' ? 'bg-surface text-accent-soft' : 'bg-transparent text-dim'"
                  @click="rule.mode = 'include'"
                >
                  Incluir
                </button>
                <button
                  class="px-3 py-1 text-[11px] font-semibold transition hover:bg-[#1e2235] hover:text-soft"
                  :class="rule.mode === 'exclude' ? 'bg-danger-bg text-danger' : 'bg-transparent text-dim'"
                  @click="rule.mode = 'exclude'"
                >
                  Excluir
                </button>
              </div>
              <label class="flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted">
                <UiSwitch v-model="rule.enabled" />
                <span>Ativa</span>
              </label>
              <UiButton class="ml-auto" variant="danger" size="xs" @click="removeDraftRule(rule.id)">
                Remover
              </UiButton>
            </div>

            <div class="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2.5 px-3.5 py-3">
              <UiField label="Marca">
                <UiInput
                  :model-value="rule.brand ?? ''"
                  size="sm"
                  placeholder="VOLKSWAGEN"
                  @update:model-value="rule.brand = String($event ?? '').toUpperCase() || null"
                />
              </UiField>
              <UiField label="Modelo">
                <UiInput
                  :model-value="rule.model ?? ''"
                  size="sm"
                  placeholder="GOL"
                  @update:model-value="rule.model = String($event ?? '').toUpperCase() || null"
                />
              </UiField>
              <UiField label="Texto no título">
                <UiInput
                  :model-value="rule.text ?? ''"
                  size="sm"
                  placeholder="qualquer trecho"
                  @update:model-value="rule.text = String($event ?? '') || null"
                />
              </UiField>
              <UiField label="Ano mín">
                <UiInput
                  :model-value="rule.minYear ?? ''"
                  class="min-w-[90px]"
                  size="sm"
                  type="number"
                  placeholder="2015"
                  @update:model-value="rule.minYear = toNullableNumber($event)"
                />
              </UiField>
            </div>
          </div>
        </div>

        <template #footer>
          <UiButton variant="dashed" size="sm" @click="addDraftRule">
            + Nova regra
          </UiButton>
          <div class="flex gap-2">
            <UiButton variant="secondary" size="md" @click="showRulesModal = false">
              Cancelar
            </UiButton>
            <UiButton variant="primary" size="md" :loading="savingRules" :disabled="savingRules" @click="applyRules">
              {{ savingRules ? 'Salvando...' : 'Aplicar' }}
            </UiButton>
          </div>
        </template>
      </UiDialog>
    </Transition>
  </div>
</template>
