<script setup lang="ts">
import type {
  CopartConditionalAttemptStatus,
  CopartConditionalCheckHistoryItem,
  CopartConditionalCheckHistoryResponse,
} from '#shared/types/copart-conditional-check'

type StatusFilter = 'all' | CopartConditionalAttemptStatus

const STATUS_OPTIONS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Todas' },
  { value: 'running', label: 'Em andamento' },
  { value: 'pending', label: 'Pendente' },
  { value: 'approved', label: 'Aprovada' },
  { value: 'refused', label: 'Recusada' },
  { value: 'error', label: 'Erro' },
  { value: 'skipped', label: 'Ignorada' },
]
const SUMMARY_OPTIONS = STATUS_OPTIONS.filter(
  (option): option is { value: CopartConditionalAttemptStatus; label: string } => option.value !== 'all',
)

const selectedStatus = ref<StatusFilter>('all')
const page = ref(1)
const requestPending = ref(false)
const requestedVehicleId = ref<string | null>(null)
const notice = ref<string | null>(null)
const noticeIsError = ref(false)

const query = computed(() => ({
  page: page.value,
  limit: 30,
  ...(selectedStatus.value !== 'all' ? { status: selectedStatus.value } : {}),
}))

const { data, pending, error, refresh } = await useFetch<CopartConditionalCheckHistoryResponse>('/api/conditional-history', {
  query,
  default: () => ({
    history: [],
    total: 0,
    page: 1,
    limit: 30,
    summary: { running: 0, pending: 0, approved: 0, refused: 0, error: 0, skipped: 0 },
  }),
})

const totalPages = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / (data.value?.limit ?? 30))))
const hasRunning = computed(() => (data.value?.summary.running ?? 0) > 0 || requestPending.value)

function statusLabel(status: CopartConditionalAttemptStatus): string {
  return STATUS_OPTIONS.find(option => option.value === status)?.label ?? status
}

function statusClass(status: CopartConditionalAttemptStatus): string {
  if (status === 'approved') return 'bg-success/15 text-success'
  if (status === 'refused') return 'bg-warning/15 text-warning'
  if (status === 'error') return 'bg-danger-bg text-danger'
  if (status === 'running') return 'bg-accent/15 text-accent'
  if (status === 'skipped') return 'bg-line text-muted'
  return 'bg-warning/10 text-warning'
}

function vehicleLabel(item: CopartConditionalCheckHistoryItem): string {
  const base = item.title || [item.brand, item.model].filter(Boolean).join(' ') || 'Lote sem identificação'
  return item.year && !base.includes(String(item.year)) ? `${base} ${item.year}` : base
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function formatDuration(value: number | null): string {
  if (value == null) return '—'
  if (value < 1000) return `${value} ms`
  return `${(value / 1000).toFixed(1).replace('.', ',')} s`
}

function setStatus(value: StatusFilter) {
  selectedStatus.value = value
  page.value = 1
}

function setPage(value: number) {
  page.value = Math.min(totalPages.value, Math.max(1, value))
}

async function runManual(vehicleId?: string) {
  if (requestPending.value) return
  requestPending.value = true
  requestedVehicleId.value = vehicleId ?? null
  notice.value = null
  noticeIsError.value = false
  try {
    const response = await $fetch<{ runId: string }>('/api/conditional-history/check', {
      method: 'POST',
      body: vehicleId ? { vehicleId } : {},
    })
    notice.value = vehicleId
      ? 'Nova tentativa enfileirada para este lote.'
      : 'Nova tentativa enfileirada para as condicionais pendentes.'
    if (response.runId) notice.value += ` Execução ${response.runId.slice(0, 8)}.`
    await refresh()
    setTimeout(() => void refresh(), 800)
  } catch (caught: unknown) {
    noticeIsError.value = true
    notice.value = caught instanceof Error ? caught.message : 'Não foi possível iniciar a tentativa manual.'
  } finally {
    requestPending.value = false
    requestedVehicleId.value = null
  }
}

let refreshTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  refreshTimer = setInterval(() => void refresh(), 15_000)
})
onBeforeUnmount(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<template>
  <div class="mx-auto flex max-w-7xl flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-bold text-strong">Condicionais Copart</h1>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-dim">
          Acompanhe cada tentativa automática ou manual de descobrir o desfecho de um lote condicional.
        </p>
      </div>
      <div class="flex gap-2">
        <UiButton variant="secondary" size="sm" :loading="pending" @click="refresh">
          Atualizar
        </UiButton>
        <UiButton variant="primary" size="sm" :loading="requestPending" @click="runManual()">
          Tentar pendentes agora
        </UiButton>
      </div>
    </div>

    <p v-if="notice" class="rounded-lg border px-3 py-2 text-[12px]" :class="noticeIsError ? 'border-danger/30 bg-danger-bg text-danger' : 'border-success/30 bg-success/10 text-success'">
      {{ notice }}
    </p>
    <p v-if="error" class="rounded-lg border border-danger/30 bg-danger-bg px-3 py-2 text-[12px] text-danger">
      Não foi possível carregar o histórico de tentativas.
    </p>

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      <UiCard v-for="option in SUMMARY_OPTIONS" :key="option.value" class="p-3">
        <p class="text-[10px] font-semibold uppercase tracking-wide text-faint">{{ option.label }}</p>
        <p class="mt-1 text-xl font-bold text-strong">{{ data?.summary[option.value] ?? 0 }}</p>
      </UiCard>
    </div>

    <UiCard class="p-3">
      <div class="flex flex-wrap items-center gap-1.5">
        <span class="mr-1 text-[11px] font-semibold text-faint">Filtrar:</span>
        <UiChip v-for="option in STATUS_OPTIONS" :key="option.value" :active="selectedStatus === option.value" @click="setStatus(option.value)">
          {{ option.label }}
        </UiChip>
        <span v-if="hasRunning" class="ml-auto text-[11px] font-medium text-accent">Atualização automática ativa</span>
      </div>
    </UiCard>

    <UiCard class="overflow-hidden">
      <div v-if="pending && !data?.history.length" class="p-8 text-center text-[13px] text-faint">Carregando tentativas...</div>
      <div v-else-if="!data?.history.length" class="p-8 text-center text-[13px] text-faint">Nenhuma tentativa registrada ainda.</div>
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[980px] text-left text-[12px]">
          <thead class="border-b border-line bg-panel-muted text-[10px] uppercase tracking-wide text-faint">
            <tr>
              <th class="px-3 py-2.5">Lote</th>
              <th class="px-3 py-2.5">Tentativa</th>
              <th class="px-3 py-2.5">Resultado</th>
              <th class="px-3 py-2.5">Data condicional</th>
              <th class="px-3 py-2.5">Nova data</th>
              <th class="px-3 py-2.5">Duração</th>
              <th class="px-3 py-2.5 text-right">Ação</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-line-soft">
            <tr v-for="item in data.history" :key="item.id" class="align-top hover:bg-panel-muted/40">
              <td class="max-w-[300px] px-3 py-3">
                <a :href="item.url" target="_blank" rel="noopener" class="font-semibold text-accent-soft hover:underline">{{ vehicleLabel(item) }}</a>
                <p class="mt-1 text-[11px] text-faint">Lote {{ item.lot || '—' }} · {{ item.url }}</p>
                <p v-if="item.error" class="mt-1 max-w-[280px] truncate text-[11px] text-danger" :title="item.error">{{ item.error }}</p>
              </td>
              <td class="whitespace-nowrap px-3 py-3 text-muted">
                <span class="font-semibold">{{ item.trigger === 'manual' ? 'Manual' : 'Automática' }}</span>
                <p class="mt-1 text-[10px] text-faint">{{ formatDate(item.startedAt) }}</p>
              </td>
              <td class="px-3 py-3">
                <span class="rounded-full px-2 py-1 text-[10px] font-bold" :class="statusClass(item.status)">{{ statusLabel(item.status) }}</span>
                <p v-if="item.statusRaw" class="mt-1 text-[10px] text-faint">{{ item.statusRaw }}</p>
              </td>
              <td class="whitespace-nowrap px-3 py-3 text-muted">{{ formatDate(item.originalAuctionDate) }}</td>
              <td class="whitespace-nowrap px-3 py-3 text-muted">{{ formatDate(item.nextAuctionDate) }}</td>
              <td class="whitespace-nowrap px-3 py-3 text-muted">{{ formatDuration(item.durationMs) }}</td>
              <td class="px-3 py-3 text-right">
                <UiButton v-if="item.status === 'pending' || item.status === 'error' || item.status === 'skipped'" variant="secondary" size="xs" :loading="requestedVehicleId === item.vehicleId" :disabled="requestPending" @click="runManual(item.vehicleId ?? undefined)">
                  Tentar
                </UiButton>
                <span v-else class="text-[11px] text-faint">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="data?.total" class="flex items-center justify-between border-t border-line px-3.5 py-2.5 text-[11px] text-faint">
        <span>{{ data.total }} tentativa(s)</span>
        <div class="flex items-center gap-2">
          <UiButton variant="ghost" size="xs" :disabled="page <= 1" @click="setPage(page - 1)">Anterior</UiButton>
          <span>Página {{ page }} de {{ totalPages }}</span>
          <UiButton variant="ghost" size="xs" :disabled="page >= totalPages" @click="setPage(page + 1)">Próxima</UiButton>
        </div>
      </div>
    </UiCard>
  </div>
</template>
