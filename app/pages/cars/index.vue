<script setup lang="ts">
import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '#shared/constants/sources'
import type { AuctionComboRule, AuctionFilters } from '#shared/types/filters'
import type { VehicleMarketAnalysis } from '#shared/types/market-analysis'
import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import type { VehicleDisplayRuleEvaluation } from '#shared/utils/vehicle-display-rules'

type VehicleListRecord = VehicleRecord & {
  displayRule?: VehicleDisplayRuleEvaluation
  marketAnalysis?: VehicleMarketAnalysis | null
}

type DamageLevel = 'small' | 'medium' | 'normal'
type PeriodFilter = 'upcoming' | 'today' | 'tomorrow' | 'past' | 'all'
type FipeFilter = 'all' | 'with' | 'without'
type SaleStatusLevel = 'available' | 'conditional' | 'sold'

interface VehiclesResponse {
  vehicles: VehicleListRecord[]
  total: number
  rules: {
    enabled: boolean
    active: number
    hidden: number
  }
}

const SOURCE_LABELS: Partial<Record<VehicleSource, string>> = {
  'sodre': 'Sodre',
  'megaleiloes': 'MegaLeilões',
  'claudio-kuss': 'C. Kuss',
  'leiloesjudiciais': 'Judiciais',
  'vipleiloes': 'VIP',
}

const ALL_SOURCES: { id: VehicleSource; label: string }[] = ACTIVE_AUCTION_SOURCES.map(source => ({
  id: source,
  label: SOURCE_LABELS[source] ?? SOURCE_META[source].name,
}))

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

const PERIOD_OPTIONS: { value: PeriodFilter; label: string }[] = [
  { value: 'upcoming', label: 'Próximos' },
  { value: 'past', label: 'Passados' },
  { value: 'all', label: 'Todos' },
]

const FIPE_OPTIONS: { value: FipeFilter; label: string }[] = [
  { value: 'all', label: 'Todos' },
  { value: 'with', label: 'Com FIPE' },
  { value: 'without', label: 'Sem FIPE' },
]

const SALE_STATUS_OPTIONS: { value: SaleStatusLevel; label: string }[] = [
  { value: 'available', label: 'Disponível' },
  { value: 'conditional', label: 'Condicional' },
  { value: 'sold', label: 'Vendido' },
]

const PRICE_MIN = 0
const PRICE_MAX = 300_000
const PRICE_STEP = 5_000
const YEAR_MIN = 2000
const YEAR_MAX = new Date().getFullYear() + 1

const route = useRoute()
const router = useRouter()

function qStr(key: string): string | undefined {
  const value = route.query[key]
  return Array.isArray(value) ? (value[0] ?? undefined) : (value ?? undefined)
}

function qNum(key: string): number | null {
  const raw = qStr(key)
  if (raw == null || raw === '') return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function qList<T extends string>(key: string): T[] {
  const raw = qStr(key)
  return raw ? (raw.split(',').map(v => v.trim()).filter(Boolean) as T[]) : []
}

function qBool(key: string, fallback: boolean): boolean {
  const raw = qStr(key)
  return raw == null ? fallback : raw === 'true'
}

function qEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = qStr(key)
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

const sidebarOpen = ref(true)

const displaySources = ref<VehicleSource[]>(qList<VehicleSource>('sources'))
const displayStates = ref<string[]>(qList('states'))
const displayCities = ref<string[]>(qList('cities'))
const cityInput = ref('')
const search = ref(qStr('search') ?? '')
const minPrice = ref<number | null>(qNum('minPrice'))
const maxPrice = ref<number | null>(qNum('maxPrice'))
const minYear = ref<number | null>(qNum('minYear'))
const maxYear = ref<number | null>(qNum('maxYear'))
const fipeFilter = ref<FipeFilter>(qEnum<FipeFilter>('fipeFilter', ['all', 'with', 'without'], 'all'))
const maxFipePct = ref<number | null>(qNum('maxFipePct'))
const sort = ref(qStr('sort') ?? 'recommended')
const period = ref<PeriodFilter>(qEnum<PeriodFilter>('period', ['upcoming', 'today', 'tomorrow', 'past', 'all'], 'upcoming'))
const page = ref(qNum('page') ?? 1)
const comboRules = ref<AuctionComboRule[]>([])
const rulesEnabled = ref(qBool('rules', true))
const displayDamageLevels = ref<DamageLevel[]>(qList<DamageLevel>('damageLevels'))
const displaySaleStatuses = ref<SaleStatusLevel[]>(qStr('saleStatus') != null ? qList<SaleStatusLevel>('saleStatus') : ['available'])

const operationLog = ref<string[]>([])
const showLog = ref(false)
const sendingVehicles = ref<string[]>([])
const deletingVehicles = ref<string[]>([])
const selectedIds = ref<Set<string>>(new Set())
const bulkDeleting = ref(false)

const showNoPhoto = ref(qBool('showNoPhoto', true))
const refreshingVehicleId = ref<string | null>(null)
const isRefreshingAll = ref(false)
const lastRefreshedAt = ref<Date | null>(null)

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
  if (fipeFilter.value !== 'all') params['fipeFilter'] = fipeFilter.value
  if (maxFipePct.value != null) params['maxFipePct'] = maxFipePct.value
  params['period'] = period.value
  if (displayDamageLevels.value.length > 0) params['damageLevels'] = displayDamageLevels.value.join(',')
  if (displaySaleStatuses.value.length > 0) params['saleStatus'] = displaySaleStatuses.value.join(',')
  params['showNoPhoto'] = showNoPhoto.value ? 'true' : 'false'
  params['rules'] = rulesEnabled.value ? 'true' : 'false'
  return params
})

const { data: filtersData } = await useFetch<{ filters: AuctionFilters }>('/api/filters')
comboRules.value = (filtersData.value?.filters.comboRules ?? []).map(rule => ({ ...rule }))
if (qStr('states') == null) displayStates.value = [...(filtersData.value?.filters.states ?? [])]
if (qStr('cities') == null) displayCities.value = [...(filtersData.value?.filters.cities ?? [])]

const { data, refresh } = await useFetch<VehiclesResponse>('/api/vehicles', { query })
const { data: countsData, refresh: refreshCounts } = await useFetch<{
  bySrc: Record<string, number>
  byState: Record<string, number>
  byDamage: Record<'all' | DamageLevel, number>
  byPeriod: Partial<Record<PeriodFilter, number>>
  byFipe: Record<FipeFilter, number>
  byStatus: Record<'all' | SaleStatusLevel, number>
}>('/api/vehicles/counts', { query })

const vehicles = computed(() => data.value?.vehicles ?? [])
const total = computed(() => data.value?.total ?? 0)
const ruleSummary = computed(() => data.value?.rules ?? { enabled: rulesEnabled.value, active: 0, hidden: 0 })
const totalPages = computed(() => Math.ceil(total.value / 50))
const srcCount = (id: string) => countsData.value?.bySrc[id] ?? 0
const stateCount = (uf: string) => countsData.value?.byState[uf] ?? 0
const damageCount = (level: 'all' | DamageLevel) => countsData.value?.byDamage?.[level] ?? 0
const periodCount = (value: PeriodFilter) => countsData.value?.byPeriod?.[value] ?? 0
const fipeCount = (value: FipeFilter) => countsData.value?.byFipe?.[value] ?? 0
const statusCount = (value: 'all' | SaleStatusLevel) => countsData.value?.byStatus?.[value] ?? 0

const selectedCount = computed(() => selectedIds.value.size)
const allSelected = computed(() =>
  vehicles.value.length > 0 && vehicles.value.every(v => v._id && selectedIds.value.has(v._id)),
)

function isSelected(id: string | undefined): boolean {
  return id != null && selectedIds.value.has(id)
}

function toggleSelect(vehicle: VehicleRecord) {
  const id = vehicle._id
  if (!id) return
  const next = new Set(selectedIds.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selectedIds.value = next
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set()
    return
  }
  selectedIds.value = new Set(vehicles.value.map(v => v._id).filter((id): id is string => !!id))
}

function clearSelection() {
  selectedIds.value = new Set()
}

async function bulkDeleteSelected() {
  const ids = [...selectedIds.value]
  if (ids.length === 0 || bulkDeleting.value) return
  if (!window.confirm(`Excluir ${ids.length} veículo${ids.length !== 1 ? 's' : ''} selecionado${ids.length !== 1 ? 's' : ''}? Essa ação não pode ser desfeita.`)) return

  bulkDeleting.value = true
  try {
    await $fetch<{ deletedCount: number }>('/api/vehicles/bulk-delete', {
      method: 'POST',
      body: { ids },
    })
    clearSelection()
    await refresh()
    await refreshCounts()
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    operationLog.value.push(`⚠ Erro ao excluir selecionados: ${message.replace(/^.*?:\s*/, '').slice(0, 120)}`)
    showLog.value = true
  }
  finally {
    bulkDeleting.value = false
  }
}

watch(page, () => clearSelection())

watch(
  [search, minPrice, maxPrice, minYear, maxYear, fipeFilter, maxFipePct, displaySources, displayStates, displayCities, sort, period, rulesEnabled, displayDamageLevels, displaySaleStatuses, showNoPhoto],
  () => { page.value = 1 },
)

watch(query, (newQuery) => {
  router.replace({ query: newQuery as Record<string, string> })
})

async function refreshAll() {
  if (isRefreshingAll.value) return
  isRefreshingAll.value = true
  try {
    await Promise.all([refresh(), refreshCounts()])
    lastRefreshedAt.value = new Date()
  }
  finally {
    isRefreshingAll.value = false
  }
}

onMounted(() => {
  lastRefreshedAt.value = new Date()
})

const lastRefreshedFormatted = computed(() => {
  if (!lastRefreshedAt.value) return null
  return lastRefreshedAt.value.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
})

const activeDisplayFilters = computed(() => {
  let count = 0
  if (displaySources.value.length > 0) count++
  if (displayStates.value.length > 0) count++
  if (displayCities.value.length > 0) count++
  if (search.value.trim()) count++
  if (minPrice.value != null || maxPrice.value != null) count++
  if (minYear.value != null || maxYear.value != null) count++
  if (fipeFilter.value !== 'all' || maxFipePct.value != null) count++
  if (rulesEnabled.value && comboRules.value.some(rule => rule.enabled)) count++
  if (period.value !== 'all') count++
  if (displayDamageLevels.value.length > 0) count++
  if (displaySaleStatuses.value.length > 0) count++
  if (!showNoPhoto.value) count++
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
  fipeFilter.value = 'all'
  maxFipePct.value = null
  sort.value = 'recommended'
  period.value = 'all'
  rulesEnabled.value = false
  displayDamageLevels.value = []
  displaySaleStatuses.value = []
  showNoPhoto.value = true
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
    operationLog.value.push('⚠ Erro ao salvar regras de exibição')
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
    operationLog.value.push(`⚠ Erro ao enviar: ${message.replace(/^.*?:\s*/, '').slice(0, 120)}`)
    showLog.value = true
  }
  finally {
    sendingVehicles.value = sendingVehicles.value.filter(item => item !== id)
  }
}

function isDeletingVehicle(id: string | undefined): boolean {
  return id != null && deletingVehicles.value.includes(id)
}

async function deleteVehicle(vehicle: VehicleRecord) {
  const id = vehicle._id
  if (!id || isDeletingVehicle(id)) return

  deletingVehicles.value = [...deletingVehicles.value, id]
  try {
    await $fetch(`/api/vehicles/${id}`, { method: 'DELETE' })
    await refresh()
    await refreshCounts()
  }
  catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    operationLog.value.push(`⚠ Erro ao excluir: ${message.replace(/^.*?:\s*/, '').slice(0, 120)}`)
    showLog.value = true
  }
  finally {
    deletingVehicles.value = deletingVehicles.value.filter(item => item !== id)
  }
}

async function handleFipeUpdated() {
  await refresh()
  await refreshCounts()
}

async function refreshVehicle(vehicle: VehicleRecord) {
  const id = vehicle._id
  if (!id || refreshingVehicleId.value) return
  refreshingVehicleId.value = id
  operationLog.value = []
  showLog.value = true

  try {
    const response = await $fetch<{ vehicle: VehicleRecord; logs: string[] }>(`/api/vehicles/${id}/refresh`, {
      method: 'POST',
    })
    operationLog.value.push(...response.logs)
    operationLog.value.push(`✓ ${response.vehicle.brand} ${response.vehicle.model} atualizado.`)
    await refresh()
    await refreshCounts()
  }
  catch (error: unknown) {
    operationLog.value.push(`⚠ Erro: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    refreshingVehicleId.value = null
  }
}
</script>

<template>
  <div class="flex flex-col gap-3">

    <div class="flex items-start gap-3">
      <Transition name="slide-left">
        <aside
          v-if="sidebarOpen"
          class="sticky top-16 flex max-h-[calc(100vh-80px)] w-66 shrink-0 flex-col overflow-hidden rounded-card border border-line bg-panel"
        >
          <div class="scrollbar-dark flex-1 overflow-y-auto px-3 py-2.5">
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
                <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
                  Tipo de monta
                  <button
                    v-if="displayDamageLevels.length > 0"
                    class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300"
                    @click="displayDamageLevels = []"
                  >
                    limpar
                  </button>
                </div>
                <div class="flex flex-wrap gap-1">
                  <UiChip :active="displayDamageLevels.length === 0" @click="displayDamageLevels = []">
                    Todas
                    <span v-if="damageCount('all') > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ damageCount('all') }}
                    </span>
                  </UiChip>
                  <UiChip :active="displayDamageLevels.includes('small')" @click="toggleValue(displayDamageLevels, 'small')">
                    Pequena
                    <span v-if="damageCount('small') > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ damageCount('small') }}
                    </span>
                  </UiChip>
                  <UiChip :active="displayDamageLevels.includes('medium')" @click="toggleValue(displayDamageLevels, 'medium')">
                    Média
                    <span v-if="damageCount('medium') > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ damageCount('medium') }}
                    </span>
                  </UiChip>
                  <UiChip :active="displayDamageLevels.includes('normal')" @click="toggleValue(displayDamageLevels, 'normal')">
                    Normal
                    <span v-if="damageCount('normal') > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ damageCount('normal') }}
                    </span>
                  </UiChip>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
                  Status
                  <button
                    v-if="displaySaleStatuses.length > 0"
                    class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300"
                    @click="displaySaleStatuses = []"
                  >
                    limpar
                  </button>
                </div>
                <div class="flex flex-wrap gap-1">
                  <UiChip :active="displaySaleStatuses.length === 0" @click="displaySaleStatuses = []">
                    Todos
                    <span v-if="statusCount('all') > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ statusCount('all') }}
                    </span>
                  </UiChip>
                  <UiChip
                    v-for="option in SALE_STATUS_OPTIONS"
                    :key="option.value"
                    :active="displaySaleStatuses.includes(option.value)"
                    @click="toggleValue(displaySaleStatuses, option.value)"
                  >
                    {{ option.label }}
                    <span v-if="statusCount(option.value) > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ statusCount(option.value) }}
                    </span>
                  </UiChip>
                </div>
              </div>


              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">Período</div>
                <div class="flex flex-wrap gap-1">
                  <UiChip
                    v-for="option in PERIOD_OPTIONS"
                    :key="option.value"
                    :active="period === option.value"
                    @click="period = option.value"
                  >
                    {{ option.label }}
                    <span v-if="periodCount(option.value) > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ periodCount(option.value) }}
                    </span>
                  </UiChip>
                </div>
              </div>

              <div class="border-b border-canvas py-2">
                <label class="flex cursor-pointer select-none items-center justify-between text-[11px] font-semibold text-muted">
                  <span>Incluir sem foto</span>
                  <UiSwitch v-model="showNoPhoto" />
                </label>
              </div>

              <div class="border-b border-canvas py-2">
                <div class="mb-1.5 text-[11px] font-semibold text-muted">FIPE</div>
                <div class="flex flex-wrap gap-1">
                  <UiChip
                    v-for="option in FIPE_OPTIONS"
                    :key="option.value"
                    :active="fipeFilter === option.value"
                    @click="fipeFilter = option.value"
                  >
                    {{ option.label }}
                    <span v-if="fipeCount(option.value) > 0" class="rounded bg-[#1a1c35] px-1 text-[9.5px] font-bold text-accent">
                      {{ fipeCount(option.value) }}
                    </span>
                  </UiChip>
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

              <!-- <div class="border-b border-canvas py-2">
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
              </div> -->

              
              <div v-if="activeDisplayFilters > 0" class="py-2">
                <UiButton block variant="dashed" size="sm" @click="clearDisplayFilters">
                  Limpar todos os filtros
                </UiButton>
              </div>
          </div>
        </aside>
      </Transition>

      <main class="min-w-0 flex-1 gap-3">

        <div class="mb-3 flex flex-wrap items-center justify-end gap-2">
          <span v-if="lastRefreshedFormatted" class="text-[11px] text-faint">Atualizado às {{ lastRefreshedFormatted }}</span>
          <UiButton variant="secondary" size="sm" :loading="isRefreshingAll" :disabled="isRefreshingAll" @click="refreshAll">
            Atualizar
          </UiButton>
        </div>

        <div v-if="vehicles.length > 0" class="mb-3 flex flex-wrap items-center gap-3 rounded-card border border-line bg-panel px-3.5 py-2.5">
          <label class="flex cursor-pointer select-none items-center gap-1.5 text-[12.5px] font-medium text-soft">
            <input type="checkbox" class="accent-accent" :checked="allSelected" @change="toggleSelectAll" />
            Selecionar todos desta página ({{ vehicles.length }})
          </label>
          <template v-if="selectedCount > 0">
            <span class="text-[12.5px] text-dim">{{ selectedCount }} selecionado{{ selectedCount !== 1 ? 's' : '' }}</span>
            <UiButton variant="danger" size="sm" :loading="bulkDeleting" :disabled="bulkDeleting" @click="bulkDeleteSelected">
              Excluir selecionados
            </UiButton>
            <button class="text-[12px] text-dim hover:text-body" @click="clearSelection">
              limpar seleção
            </button>
          </template>
        </div>

        <div v-if="vehicles.length > 0" key="vehicle-grid" class="grid grid-cols-4 gap-3">
          <VehicleCard
            v-for="vehicle in vehicles"
            :key="vehicle._id"
            :vehicle="vehicle"
            :sending="isSendingVehicle(vehicle._id)"
            :refreshing="refreshingVehicleId === vehicle._id"
            :deleting="isDeletingVehicle(vehicle._id)"
            :selected="isSelected(vehicle._id)"
            :show-refresh-button="vehicle.source === 'vipleiloes'"
            :compact="false"
            @send="sendVehicle"
            @refresh="refreshVehicle"
            @fipe-updated="handleFipeUpdated"
            @delete="deleteVehicle"
            @toggle-select="toggleSelect"
          />
        </div>
        <div v-else key="vehicle-empty" class="px-5 py-15 text-center text-sm text-faint">
          Nenhum veículo. Ajuste os filtros ou rode o scraping na página Scraping.
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
          <span class="text-xs font-semibold text-muted">Log da operação</span>
          <div class="flex items-center gap-3">
            <button class="px-1 text-[13px] text-dim hover:text-body" @click="showLog = false">x</button>
          </div>
        </div>
        <div class="scrollbar-dark flex max-h-55 flex-col gap-0.5 overflow-y-auto px-3.5 py-2.5">
          <div
            v-for="(line, index) in operationLog"
            :key="index"
            class="font-mono text-[11px] leading-relaxed"
            :class="line.startsWith('✓') ? 'text-success' : line.startsWith('⚠') ? 'text-danger' : 'text-dim'"
          >
            {{ line }}
          </div>
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
                  class="min-w-22.5"
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
