<script setup lang="ts">
import { SOURCE_META } from '#shared/constants/sources'
import type { VehicleRecord, VehicleSaleStatus, VehicleSource } from '#shared/types/vehicle'

type PeriodFilter = 'today' | '7d' | '30d' | 'all'
type SortOption = 'recent' | 'price_desc' | 'price_asc' | 'fipe_asc'

interface LiveHistoryResponse {
  vehicles: VehicleRecord[]
  total: number
}

const LIVE_SOURCES: { id: VehicleSource; label: string }[] = [
  { id: 'copart', label: SOURCE_META.copart.name },
  { id: 'vipleiloes', label: SOURCE_META.vipleiloes.name },
  { id: 'sodre', label: SOURCE_META.sodre.name },
]

const SALE_STATUS_OPTIONS: { value: VehicleSaleStatus; label: string }[] = [
  { value: 'sold', label: 'Vendido' },
  { value: 'conditional', label: 'Condicional' },
  { value: 'not_sold', label: 'Não vendido' },
]

const PERIOD_OPTIONS: { value: PeriodFilter; label: string }[] = [
  { value: 'today', label: 'Hoje' },
  { value: '7d', label: '7 dias' },
  { value: '30d', label: '30 dias' },
  { value: 'all', label: 'Tudo' },
]

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'recent', label: 'Mais recentes' },
  { value: 'price_desc', label: 'Maior lance' },
  { value: 'price_asc', label: 'Menor lance' },
  { value: 'fipe_asc', label: 'Maior margem FIPE' },
]

const BRAZIL_STATES = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
  'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]

const route = useRoute()
const router = useRouter()

function qStr(key: string): string | undefined {
  const value = route.query[key]
  return Array.isArray(value) ? (value[0] ?? undefined) : (value ?? undefined)
}

function qList<T extends string>(key: string): T[] {
  const raw = qStr(key)
  return raw ? (raw.split(',').map(v => v.trim()).filter(Boolean) as T[]) : []
}

function qEnum<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  const raw = qStr(key)
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback
}

function qBool(key: string, fallback: boolean): boolean {
  const raw = qStr(key)
  return raw == null ? fallback : raw === 'true'
}

const search = ref(qStr('search') ?? '')
const sources = ref<VehicleSource[]>(qList<VehicleSource>('sources'))
const states = ref<string[]>(qList('states'))
const saleStatuses = ref<VehicleSaleStatus[]>(qList<VehicleSaleStatus>('saleStatus'))
const period = ref<PeriodFilter>(qEnum<PeriodFilter>('period', ['today', '7d', '30d', 'all'], 'all'))
const sort = ref<SortOption>(qEnum<SortOption>('sort', ['recent', 'price_desc', 'price_asc', 'fipe_asc'], 'recent'))
const onlyExtension = ref(qBool('onlyExtension', false))
const page = ref(1)

const LIMIT = 50

const query = computed(() => {
  const params: Record<string, unknown> = { page: page.value, limit: LIMIT, sort: sort.value, period: period.value }
  if (sources.value.length > 0) params['sources'] = sources.value.join(',')
  if (states.value.length > 0) params['states'] = states.value.join(',')
  if (saleStatuses.value.length > 0) params['saleStatus'] = saleStatuses.value.join(',')
  if (search.value.trim()) params['search'] = search.value.trim()
  if (onlyExtension.value) params['onlyExtension'] = 'true'
  return params
})

const { data, refresh, status } = await useFetch<LiveHistoryResponse>('/api/vehicles/live-history', { query })

const vehicles = computed(() => data.value?.vehicles ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / LIMIT)))

function toggleValue<T>(values: T[], value: T) {
  const i = values.indexOf(value)
  if (i === -1) values.push(value)
  else values.splice(i, 1)
}

watch([search, sources, states, saleStatuses, period, sort, onlyExtension], () => { page.value = 1 })

watch(query, (newQuery) => {
  router.replace({ query: newQuery as Record<string, string> })
})

const activeFilters = computed(() => {
  let count = 0
  if (search.value.trim()) count++
  if (sources.value.length > 0) count++
  if (states.value.length > 0) count++
  if (saleStatuses.value.length > 0) count++
  if (period.value !== 'all') count++
  if (onlyExtension.value) count++
  return count
})

function clearFilters() {
  search.value = ''
  sources.value = []
  states.value = []
  saleStatuses.value = []
  period.value = 'all'
  sort.value = 'recent'
  onlyExtension.value = false
}

function saleStatusBadgeClass(status: VehicleSaleStatus): string {
  if (status === 'sold') return 'bg-success-bg text-success'
  if (status === 'conditional') return 'bg-warning-bg text-warning'
  if (status === 'not_sold') return 'bg-danger-bg text-danger'
  return 'bg-surface text-accent-soft'
}

function saleStatusLabel(status: VehicleSaleStatus): string {
  return SALE_STATUS_OPTIONS.find(option => option.value === status)?.label ?? status
}

function fipePercent(vehicle: VehicleRecord): number | null {
  if (vehicle.price == null || vehicle.fipe == null || vehicle.fipe <= 0) return null
  return Math.round((vehicle.price / vehicle.fipe) * 100)
}

function formatCurrency(value: number | null): string {
  return value != null ? `R$ ${value.toLocaleString('pt-BR')}` : '-'
}

function formatDateTime(value: Date | string | null): string {
  if (!value) return '-'
  const date = new Date(value)
  return date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div class="flex items-start gap-3">
    <aside class="sticky top-16 flex max-h-[calc(100vh-80px)] w-66 shrink-0 flex-col overflow-hidden rounded-card border border-line bg-panel">
      <div class="scrollbar-dark flex-1 overflow-y-auto px-3 py-2.5">
        <div class="border-b border-canvas py-2">
          <div class="mb-1.5 text-[11px] font-semibold text-muted">Buscar</div>
          <UiInput v-model="search" size="sm" type="text" placeholder="Marca, modelo ou comitente..." />
        </div>

        <div class="border-b border-canvas py-2">
          <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
            Origem
            <button v-if="sources.length > 0" class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300" @click="sources = []">
              limpar
            </button>
          </div>
          <div class="flex flex-wrap gap-1">
            <UiChip :active="sources.length === 0" @click="sources = []">Todas</UiChip>
            <UiChip
              v-for="source in LIVE_SOURCES"
              :key="source.id"
              :active="sources.includes(source.id)"
              @click="toggleValue(sources, source.id)"
            >
              {{ source.label }}
            </UiChip>
          </div>
        </div>

        <div class="border-b border-canvas py-2">
          <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
            Status
            <button v-if="saleStatuses.length > 0" class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300" @click="saleStatuses = []">
              limpar
            </button>
          </div>
          <div class="flex flex-wrap gap-1">
            <UiChip :active="saleStatuses.length === 0" @click="saleStatuses = []">Todos</UiChip>
            <UiChip
              v-for="option in SALE_STATUS_OPTIONS"
              :key="option.value"
              :active="saleStatuses.includes(option.value)"
              @click="toggleValue(saleStatuses, option.value)"
            >
              {{ option.label }}
            </UiChip>
          </div>
        </div>

        <div class="border-b border-canvas py-2">
          <label class="flex cursor-pointer select-none items-center justify-between text-[11px] font-semibold text-muted" title="Mostra só registros gravados pelo POST de ingestão da extensão (marcados via collectedVia). Sem isso, um mesmo source também inclui o que o scraper automático já capturou com resultado final.">
            <span>Somente extensão (ao vivo)</span>
            <UiSwitch v-model="onlyExtension" />
          </label>
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
            </UiChip>
          </div>
        </div>

        <div class="border-b border-canvas py-2">
          <div class="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-muted">
            Estados
            <button v-if="states.length > 0" class="p-0 text-[10.5px] font-medium text-red-500 hover:text-red-300" @click="states = []">
              limpar
            </button>
          </div>
          <p class="mt-1 text-[10.5px] leading-normal text-faint">Vazio = todos os estados.</p>
          <div class="mt-1 flex flex-wrap gap-1">
            <button
              v-for="uf in BRAZIL_STATES"
              :key="uf"
              class="flex min-w-9 flex-col items-center rounded border px-1 py-1 text-[10.5px] font-semibold leading-none transition"
              :class="states.includes(uf)
                ? 'border-accent bg-surface text-accent-soft'
                : 'border-line-soft bg-transparent text-dim hover:border-line-hover hover:text-soft'"
              @click="toggleValue(states, uf)"
            >
              {{ uf }}
            </button>
          </div>
        </div>

        <div class="border-b border-canvas py-2">
          <div class="mb-1.5 text-[11px] font-semibold text-muted">Ordenar</div>
          <UiSelect v-model="sort">
            <option v-for="option in SORT_OPTIONS" :key="option.value" :value="option.value">
              {{ option.label }}
            </option>
          </UiSelect>
        </div>

        <div v-if="activeFilters > 0" class="py-2">
          <UiButton block variant="dashed" size="sm" @click="clearFilters">
            Limpar todos os filtros
          </UiButton>
        </div>
      </div>
    </aside>

    <main class="min-w-0 flex-1">
      <div class="mb-3 flex items-center justify-between">
        <span class="text-[13px] text-dim">
          {{ total.toLocaleString('pt-BR') }} evento{{ total !== 1 ? 's' : '' }} capturado{{ total !== 1 ? 's' : '' }} pela extensão
        </span>
        <UiButton variant="secondary" size="sm" :loading="status === 'pending'" :disabled="status === 'pending'" @click="refresh">
          Atualizar
        </UiButton>
      </div>

      <div v-if="vehicles.length > 0" class="overflow-x-auto rounded-card border border-line bg-panel">
        <table class="min-w-[1200px] w-full text-left text-[12.5px]">
          <thead>
            <tr class="border-b border-line bg-panel-muted text-[11px] font-semibold uppercase text-muted">
              <th class="px-3 py-2">Origem</th>
              <th class="px-3 py-2">Veículo</th>
              <th class="px-3 py-2">Lote</th>
              <th class="px-3 py-2">Monta</th>
              <th class="px-3 py-2">Local</th>
              <th class="px-3 py-2">Comitente</th>
              <th class="px-3 py-2">Status</th>
              <th class="px-3 py-2">Lance</th>
              <th class="px-3 py-2">FIPE %</th>
              <th class="px-3 py-2">Capturado em</th>
              <th class="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="vehicle in vehicles" :key="vehicle._id" class="border-b border-canvas last:border-0 hover:bg-panel-muted">
              <td class="px-3 py-2 text-soft">{{ SOURCE_META[vehicle.source]?.name ?? vehicle.source }}</td>
              <td class="px-3 py-2 font-medium text-body">
                {{ vehicle.brand }} {{ vehicle.model }} <span v-if="vehicle.year" class="text-dim">{{ vehicle.year }}</span>
              </td>
              <td class="px-3 py-2 text-dim">{{ vehicle.lot ?? '-' }}</td>
              <td class="px-3 py-2 text-dim">{{ vehicle.damage ?? '-' }}</td>
              <td class="px-3 py-2 text-dim">{{ vehicle.state ?? vehicle.yard ?? '-' }}</td>
              <td class="max-w-52 truncate px-3 py-2 text-dim" :title="vehicle.consignor ?? undefined">{{ vehicle.consignor ?? '-' }}</td>
              <td class="px-3 py-2">
                <span :class="['rounded px-1.5 py-0.5 text-[10.5px] font-semibold', saleStatusBadgeClass(vehicle.saleStatus)]">
                  {{ saleStatusLabel(vehicle.saleStatus) }}
                </span>
              </td>
              <td class="px-3 py-2 text-soft">{{ formatCurrency(vehicle.price) }}</td>
              <td class="px-3 py-2 text-dim">{{ fipePercent(vehicle) != null ? `${fipePercent(vehicle)}%` : '-' }}</td>
              <td class="px-3 py-2 text-dim">{{ formatDateTime(vehicle.saleStatusCheckedAt ?? vehicle.auctionStatusCheckedAt ?? vehicle.auctionDate ?? vehicle.scrapedAt) }}</td>
              <td class="px-3 py-2 text-right">
                <a :href="vehicle.url" target="_blank" rel="noopener" class="text-accent-soft hover:underline">Abrir</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="px-5 py-15 text-center text-sm text-faint">
        Nenhum evento capturado ainda. Ajuste os filtros ou rode a extensão em um leilão ao vivo.
      </div>

      <div v-if="totalPages > 1" class="mt-3 flex items-center justify-end gap-2.5 text-[13px] text-soft">
        <UiButton variant="secondary" size="icon" :disabled="page === 1" @click="page--">‹</UiButton>
        <span>{{ page }} / {{ totalPages }}</span>
        <UiButton variant="secondary" size="icon" :disabled="page === totalPages" @click="page++">›</UiButton>
      </div>
    </main>
  </div>
</template>
