<script setup lang="ts">
import { SOURCE_META } from '#shared/constants/sources'
import type { VehicleRecord, VehicleSaleStatus } from '#shared/types/vehicle'
import { firstUsableVehicleImageUrl } from '#shared/utils/vehicle-images'
import type { VehicleDisplayRuleEvaluation } from '#shared/utils/vehicle-display-rules'

type VehicleCardVehicle = VehicleRecord & {
  displayRule?: VehicleDisplayRuleEvaluation | null
}

type EditableSaleStatus = 'unknown' | 'conditional' | 'sold'

const SALE_STATUS_OPTIONS: { value: EditableSaleStatus; label: string }[] = [
  { value: 'unknown', label: 'Disponível' },
  { value: 'conditional', label: 'Condicional' },
  { value: 'sold', label: 'Vendido' },
]

type FipeSuggestion = {
  brandCode: string
  brandName: string
  modelCode: string
  modelName: string
  yearCode: string
  yearName: string
  score: number
  price: number | null
  priceRaw: string | null
  codeFipe: string | null
  referenceMonth: string | null
  modelYear: number | null
  fuel: string | null
}

type FipeSuggestionsResponse = {
  query: {
    brand: string
    model: string
    year: number
  }
  suggestions: FipeSuggestion[]
}

type FipeApplyResponse = {
  vehicle: VehicleRecord
}

const props = withDefaults(defineProps<{
  vehicle: VehicleCardVehicle
  showSendButton?: boolean
  compact?: boolean
  refreshing?: boolean
  sending?: boolean
}>(), {
  showSendButton: true,
  compact: false,
  refreshing: false,
  sending: false,
})

const emit = defineEmits<{
  send: [vehicle: VehicleRecord]
  refresh: [vehicle: VehicleRecord]
  fipeUpdated: [vehicle: VehicleRecord]
}>()

const showFipeDialog = ref(false)
const fipeLoading = ref(false)
const fipeApplyingKey = ref<string | null>(null)
const fipeError = ref<string | null>(null)
const fipeSuggestions = ref<FipeSuggestion[]>([])
const fipeSearch = ref({
  brand: '',
  model: '',
  year: '',
})

type EditableField = 'price' | 'fipe'
const editingField = ref<EditableField | null>(null)
const editValue = ref('')
const editSaving = ref(false)
const editError = ref<string | null>(null)

const savingSaleStatus = ref(false)
const saleStatusError = ref<string | null>(null)

const saleStatus = computed(() => props.vehicle.saleStatus ?? 'unknown')
const isSold = computed(() => saleStatus.value === 'sold')
const isConditionalSale = computed(() => saleStatus.value === 'conditional')
const isNotSold = computed(() => saleStatus.value === 'not_sold')

const saleStatusModel = computed<EditableSaleStatus>({
  get: () => (isNotSold.value ? 'unknown' : (saleStatus.value as EditableSaleStatus)),
  set: (value) => { void updateSaleStatus(value) },
})
const soldPrice = computed(() => props.vehicle.soldPrice ?? (isSold.value ? props.vehicle.price : null))
const comparisonPrice = computed(() => soldPrice.value ?? props.vehicle.price)

const fipePercent = computed(() => {
  const price = comparisonPrice.value
  const { fipe } = props.vehicle
  if (price == null || fipe == null || fipe <= 0) return null
  return Math.round((price / fipe) * 100)
})

const fipeTier = computed<'success' | 'info' | 'danger' | null>(() => {
  const percent = fipePercent.value
  if (percent == null) return null
  if (percent <= 55) return 'success'
  if (percent <= 75) return 'info'
  return 'danger'
})

const priceFormatted = computed(() =>
  comparisonPrice.value != null
    ? `R$ ${comparisonPrice.value.toLocaleString('pt-BR')}`
    : '-',
)

const fipeFormatted = computed(() =>
  props.vehicle.fipe != null
    ? `R$ ${props.vehicle.fipe.toLocaleString('pt-BR')}`
    : null,
)

function normalizeText(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

const DAMAGE_ABBREVIATIONS: { pattern: RegExp; label: string }[] = [
  { pattern: /pequena/, label: 'P' },
  { pattern: /media/, label: 'M' },
  { pattern: /grande/, label: 'G' },
  { pattern: /sucata/, label: 'S' },
  { pattern: /perda\s+total/, label: 'PT' },
  { pattern: /irrecuper/, label: 'IRR' },
  { pattern: /normal/, label: 'N' },
]

const damageAbbrev = computed(() => {
  const raw = props.vehicle.damage
  if (!raw) return null
  const normalized = normalizeText(raw)
  const match = DAMAGE_ABBREVIATIONS.find(({ pattern }) => pattern.test(normalized))
  return match?.label ?? raw
})

const auctionDateFormatted = computed(() => {
  const date = props.vehicle.auctionDate
  if (!date) return null

  return new Date(date).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
})

const sourceMeta = computed(() => SOURCE_META[props.vehicle.source])
const sourceLabel = computed(() => sourceMeta.value?.name ?? props.vehicle.source)
const sourceBadgeStyle = computed(() => {
  const color = sourceMeta.value?.color ?? '#4f46e5'
  return {
    backgroundColor: `${color}1f`,
    borderColor: `${color}66`,
    color,
  }
})

const displayRule = computed(() => props.vehicle.displayRule ?? null)
const isHiddenByRules = computed(() => displayRule.value?.passes === false)
const imageUrl = computed(() => firstUsableVehicleImageUrl(props.vehicle.imageUrls))
const displayRuleTitle = computed(() =>
  isHiddenByRules.value ? 'Oculto pelas regras de exibição' : 'Exibido pelas regras de exibição',
)
const displayRuleReasons = computed(() => {
  const reasons = displayRule.value?.reasons ?? []
  return reasons.length > 0 ? reasons : ['Sem detalhe de avaliação disponível.']
})
const isSentToWhatsapp = computed(() => props.vehicle.status === 'sent' || props.vehicle.status === 'favorite')
const auctionStatus = computed(() => props.vehicle.auctionStatus ?? 'unknown')
const isAuctionFinished = computed(() => auctionStatus.value === 'finished')
const isAuctionFuture = computed(() => auctionStatus.value === 'future')
const auctionStatusRaw = computed(() => props.vehicle.auctionStatusRaw ?? null)
const auctionStatusRawNormalized = computed(() =>
  (auctionStatusRaw.value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase(),
)
const auctionStatusLabel = computed(() => {
  if (isSold.value) return null
  if (isConditionalSale.value) return null
  if (isNotSold.value) return 'Não vendido'
  if (isAuctionFinished.value && auctionStatusRawNormalized.value.includes('venda finalizada')) return 'Venda finalizada'
  if (isAuctionFinished.value) return 'Finalizado'
  if (isAuctionFuture.value) return 'Venda futura'
  return null
})
const auctionStatusTitle = computed(() => auctionStatusRaw.value ?? auctionStatusLabel.value ?? undefined)
const auctionStatusBadgeVariant = computed<'success' | 'warning' | 'danger' | 'info'>(() =>
  isSold.value ? 'success' : isNotSold.value ? 'danger' : isAuctionFinished.value || isConditionalSale.value ? 'warning' : 'info',
)
const canSendToWhatsapp = computed(() => !isAuctionFinished.value || isSold.value)
const sendButtonTitle = computed(() => {
  if (isSold.value) return 'Enviar resultado vendido via WhatsApp'
  if (isAuctionFinished.value) return 'Leilão finalizado'
  return isSentToWhatsapp.value ? 'Enviar novamente via WhatsApp' : 'Enviar via WhatsApp'
})

function fipeSuggestionKey(suggestion: FipeSuggestion): string {
  return `${suggestion.brandCode}|${suggestion.modelCode}|${suggestion.yearCode}`
}

function formatMoney(value: number | null): string {
  return value != null ? `R$ ${value.toLocaleString('pt-BR')}` : 'Sem preço'
}

function suggestionFipePercent(suggestion: FipeSuggestion): string | null {
  if (props.vehicle.price == null || suggestion.price == null || suggestion.price <= 0) return null
  return `${Math.round((props.vehicle.price / suggestion.price) * 100)}% da FIPE`
}

function extractErrorMessage(error: unknown): string {
  if (error != null && typeof error === 'object') {
    const record = error as Record<string, unknown>
    const data = record['data']
    if (data != null && typeof data === 'object') {
      const dataRecord = data as Record<string, unknown>
      if (typeof dataRecord['message'] === 'string') return dataRecord['message']
      if (typeof dataRecord['statusMessage'] === 'string') return dataRecord['statusMessage']
    }
    if (typeof record['statusMessage'] === 'string') return record['statusMessage']
    if (typeof record['message'] === 'string') return record['message']
  }
  return error instanceof Error ? error.message : String(error)
}

async function fetchFipeSuggestions() {
  const id = props.vehicle._id
  if (!id) {
    fipeError.value = 'Veículo sem ID para atualizar FIPE.'
    return
  }

  const brand = fipeSearch.value.brand.trim()
  const model = fipeSearch.value.model.trim()
  const year = Number(fipeSearch.value.year)

  if (!brand || !model || !Number.isFinite(year) || year <= 0) {
    fipeError.value = 'Informe marca, modelo e ano para consultar.'
    fipeSuggestions.value = []
    return
  }

  fipeLoading.value = true
  fipeError.value = null
  fipeSuggestions.value = []

  try {
    const response = await $fetch<FipeSuggestionsResponse>(`/api/vehicles/${id}/fipe-suggestions`, {
      query: {
        brand,
        model,
        year,
        limit: 6,
      },
    })
    fipeSuggestions.value = response.suggestions
    if (response.suggestions.length === 0) fipeError.value = 'Nenhuma sugestão encontrada.'
  }
  catch (error: unknown) {
    fipeError.value = extractErrorMessage(error)
  }
  finally {
    fipeLoading.value = false
  }
}

function openFipeDialog() {
  fipeSearch.value = {
    brand: props.vehicle.brand ?? '',
    model: props.vehicle.model ?? '',
    year: props.vehicle.year != null ? String(props.vehicle.year) : '',
  }
  fipeError.value = null
  fipeSuggestions.value = []
  showFipeDialog.value = true
  void fetchFipeSuggestions()
}

async function applyFipeSuggestion(suggestion: FipeSuggestion) {
  const id = props.vehicle._id
  if (!id) {
    fipeError.value = 'Veículo sem ID para atualizar FIPE.'
    return
  }

  const key = fipeSuggestionKey(suggestion)
  fipeApplyingKey.value = key
  fipeError.value = null

  try {
    const response = await $fetch<FipeApplyResponse>(`/api/vehicles/${id}/fipe`, {
      method: 'POST',
      body: {
        brandCode: suggestion.brandCode,
        brandName: suggestion.brandName,
        modelCode: suggestion.modelCode,
        modelName: suggestion.modelName,
        yearCode: suggestion.yearCode,
        yearName: suggestion.yearName,
      },
    })
    emit('fipeUpdated', response.vehicle)
    showFipeDialog.value = false
  }
  catch (error: unknown) {
    fipeError.value = extractErrorMessage(error)
  }
  finally {
    fipeApplyingKey.value = null
  }
}

function startEditField(field: EditableField) {
  const current = field === 'price' ? comparisonPrice.value : props.vehicle.fipe
  editingField.value = field
  editValue.value = current != null ? String(current) : ''
  editError.value = null
}

function cancelEditField() {
  editingField.value = null
  editValue.value = ''
  editError.value = null
}

async function saveEditField() {
  const field = editingField.value
  if (!field || editSaving.value) return

  const id = props.vehicle._id
  if (!id) {
    editError.value = 'Veículo sem ID.'
    return
  }

  const raw = editValue.value.trim().replace(/\./g, '').replace(',', '.')
  const value = raw === '' ? null : Number(raw)
  if (value != null && (!Number.isFinite(value) || value < 0)) {
    editError.value = 'Valor inválido.'
    return
  }

  editSaving.value = true
  editError.value = null

  const bodyKey = field === 'price' && isSold.value ? 'soldPrice' : field

  try {
    const response = await $fetch<FipeApplyResponse>(`/api/vehicles/${id}/edit`, {
      method: 'PATCH',
      body: { [bodyKey]: value },
    })
    emit('fipeUpdated', response.vehicle)
    editingField.value = null
    editValue.value = ''
  }
  catch (error: unknown) {
    editError.value = extractErrorMessage(error)
  }
  finally {
    editSaving.value = false
  }
}

async function updateSaleStatus(value: EditableSaleStatus) {
  const id = props.vehicle._id
  if (!id || savingSaleStatus.value) return

  savingSaleStatus.value = true
  saleStatusError.value = null

  try {
    const response = await $fetch<FipeApplyResponse>(`/api/vehicles/${id}/edit`, {
      method: 'PATCH',
      body: { saleStatus: value satisfies VehicleSaleStatus },
    })
    emit('fipeUpdated', response.vehicle)
  }
  catch (error: unknown) {
    saleStatusError.value = extractErrorMessage(error)
  }
  finally {
    savingSaleStatus.value = false
  }
}

</script>

<template>
  <article
    :class="[
      'relative flex flex-col overflow-visible rounded-card border bg-panel transition hover:border-line-strong',
      vehicle.status === 'favorite' ? 'border-accent shadow-[0_0_0_1px_rgba(79,70,229,0.13)]' : 'border-line',
      isSentToWhatsapp && 'opacity-75 saturate-75 hover:opacity-100 hover:saturate-100',
      isAuctionFinished && 'grayscale saturate-0 opacity-70',
      isHiddenByRules && 'border-warning bg-warning-bg/20 opacity-80 hover:border-warning',
    ]"
  >
    <a :href="vehicle.url" target="_blank" class="relative block shrink-0 overflow-hidden rounded-t-card">
      <img
        v-if="imageUrl"
        :src="imageUrl"
        :alt="`${vehicle.brand} ${vehicle.model}`"
        :class="['block w-full object-cover bg-canvas', compact ? 'h-28' : 'h-64']"
        loading="lazy"
        referrerpolicy="no-referrer"
      />
      <div
        v-else
        :class="[
          'flex w-full flex-col items-center justify-center gap-1 bg-panel-soft text-xs text-dim',
          compact ? 'h-28' : 'h-37.5',
        ]"
      >
        <svg viewBox="0 0 64 40" class="h-8 w-12 text-line-strong" aria-hidden="true">
          <path
            fill="currentColor"
            d="M11 28h3a6 6 0 0 0 12 0h12a6 6 0 0 0 12 0h3a3 3 0 0 0 3-3v-6a5 5 0 0 0-3.7-4.8l-7.8-2.1-7-7.1A7 7 0 0 0 32.5 3H22.4a8 8 0 0 0-6.7 3.6L11.8 13H9a5 5 0 0 0-5 5v7a3 3 0 0 0 3 3h4Zm9 3.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Zm24 0a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7ZM20.1 8.8A3.8 3.8 0 0 1 23.3 7h9.2c.8 0 1.5.3 2.1.9L39.7 13H16.9l3.2-4.2Z"
          />
        </svg>
        <span>sem foto</span>
      </div>

      <UiBadge
        v-if="fipePercent != null && fipeTier"
        :variant="fipeTier"
        class="absolute right-2 top-2 backdrop-blur"
      >
        {{ fipePercent }}%
      </UiBadge>

      <UiBadge
        v-if="auctionStatusLabel"
        :variant="auctionStatusBadgeVariant"
        class="absolute left-2 top-2 backdrop-blur"
        :title="auctionStatusTitle"
      >
        {{ auctionStatusLabel }}
      </UiBadge>

      <UiButton
        v-if="showSendButton"
        variant="whatsapp"
        size="icon"
        :loading="sending"
        :disabled="sending"
        :class="[
          'group absolute bottom-3 right-3 z-10 transition enabled:hover:scale-105',
          isSentToWhatsapp && 'opacity-60 shadow-none enabled:hover:opacity-100',
        ]"
        :title="sendButtonTitle"
        :aria-label="sendButtonTitle"
        @click.prevent="emit('send', vehicle)"
      >
        <template v-if="!sending">
          <svg
            viewBox="0 0 24 24"
            :class="['size-4.5', isSentToWhatsapp ? 'hidden group-hover:block' : 'block']"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
          </svg>
          <svg
            v-if="isSentToWhatsapp"
            viewBox="0 0 24 24"
            class="size-4.5 group-hover:hidden"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4.5 12.75l6 6 9-13.5" />
          </svg>
        </template>
      </UiButton>
    </a>

    <div class="flex flex-1 flex-col gap-1.5 px-3 pb-3.5 pt-3">
      <div class="flex flex-wrap gap-1">
        <span
          class="rounded border px-1.5 py-0.5 text-[10.5px] font-medium leading-tight"
          :style="sourceBadgeStyle"
        >
          {{ sourceLabel }}
        </span>
        <span
          v-if="damageAbbrev"
          class="rounded bg-danger-bg px-1.5 py-0.5 text-[10.5px] font-medium text-danger"
          :title="vehicle.damage ?? undefined"
        >
          {{ damageAbbrev }}
        </span>
        <span
          v-if="auctionStatusLabel"
          :class="[
            'rounded px-1.5 py-0.5 text-[10.5px] font-semibold',
            isAuctionFinished ? 'bg-warning-bg text-warning' : 'bg-surface text-accent-hover',
          ]"
          :title="auctionStatusTitle"
        >
          {{ auctionStatusLabel }}
        </span>
        <select
          v-model="saleStatusModel"
          :disabled="savingSaleStatus"
          title="Alterar status de venda"
          class="rounded border border-line-soft bg-canvas px-1 py-0.5 text-[10.5px] font-semibold text-dim outline-none transition focus:border-accent disabled:opacity-50"
          @click.stop
        >
          <option v-for="option in SALE_STATUS_OPTIONS" :key="option.value" :value="option.value">
            {{ option.label }}
          </option>
        </select>
        <span v-if="isHiddenByRules" class="rounded bg-warning-bg px-1.5 py-0.5 text-[10.5px] font-semibold text-warning">
          Oculto
        </span>
        <UiTooltip v-if="displayRule" side="bottom" align="start">
          <button
            type="button"
            :aria-label="displayRuleTitle"
            :class="[
              'inline-flex size-4.75 items-center justify-center rounded-full border text-[11px] font-bold leading-none transition',
              isHiddenByRules
                ? 'border-warning/60 bg-warning-bg text-warning hover:border-warning'
                : 'border-line bg-surface text-dim hover:border-line-hover hover:text-soft',
            ]"
          >
            ?
          </button>
          <template #content>
            <div class="flex flex-col gap-1.5">
              <p :class="['font-semibold', isHiddenByRules ? 'text-warning' : 'text-soft']">
                {{ displayRuleTitle }}
              </p>
              <ul class="flex list-disc flex-col gap-1 pl-4">
                <li v-for="reason in displayRuleReasons" :key="reason">
                  {{ reason }}
                </li>
              </ul>
              <p class="border-t border-line pt-1 text-[10.5px] text-dim">
                {{ displayRule.activeRuleCount }} regra(s) ativa(s):
                {{ displayRule.includeRuleCount }} incluir ·
                {{ displayRule.excludeRuleCount }} excluir
              </p>
            </div>
          </template>
        </UiTooltip>
      </div>
      <p v-if="saleStatusError" class="text-[10.5px] font-medium text-danger">
        {{ saleStatusError }}
      </p>

      <a :href="vehicle.url" target="_blank" class="block text-[13px] font-semibold leading-snug text-body transition hover:text-accent-soft">
        {{ vehicle.brand }} {{ vehicle.model }}
        <span v-if="vehicle.year" class="ml-0.5 font-normal text-dim">{{ vehicle.year }}</span>
      </a>

      <div class="flex flex-col gap-0.5">
        <div class="flex flex-wrap items-baseline gap-2">
          <div v-if="editingField === 'price'" class="flex items-center gap-1" @click.stop>
            <input
              v-model="editValue"
              type="text"
              inputmode="decimal"
              autofocus
              class="w-24 rounded-control border border-accent bg-panel-soft px-1.5 py-0.5 text-sm font-bold text-strong outline-none"
              @keydown.enter.prevent="saveEditField"
              @keydown.esc.prevent="cancelEditField"
            />
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success transition hover:bg-success/25 disabled:opacity-40"
              title="Salvar"
              :disabled="editSaving"
              @click="saveEditField"
            >
              ✓
            </button>
            <button
              type="button"
              class="flex size-5 shrink-0 items-center justify-center rounded-full bg-danger-bg text-danger transition hover:bg-danger-bg/70"
              title="Cancelar"
              @click="cancelEditField"
            >
              ✕
            </button>
          </div>
          <span
            v-else
            class="cursor-text text-base font-extrabold text-strong"
            title="Duplo clique para editar o preço"
            @dblclick="startEditField('price')"
          >
            {{ priceFormatted }}
          </span>

          <UiBadge v-if="fipePercent != null && fipeTier" :variant="fipeTier">
            {{ fipePercent }}% da FIPE
          </UiBadge>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-dim">FIPE</span>

          <div v-if="editingField === 'fipe'" class="flex items-center gap-1" @click.stop>
            <input
              v-model="editValue"
              type="text"
              inputmode="decimal"
              autofocus
              class="w-22 rounded-control border border-accent bg-panel-soft px-1.5 py-0.5 text-[11.5px] text-body outline-none"
              @keydown.enter.prevent="saveEditField"
              @keydown.esc.prevent="cancelEditField"
            />
            <button
              type="button"
              class="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-success/15 text-[10px] text-success transition hover:bg-success/25 disabled:opacity-40"
              title="Salvar"
              :disabled="editSaving"
              @click="saveEditField"
            >
              ✓
            </button>
            <button
              type="button"
              class="flex size-4.5 shrink-0 items-center justify-center rounded-full bg-danger-bg text-[10px] text-danger transition hover:bg-danger-bg/70"
              title="Cancelar"
              @click="cancelEditField"
            >
              ✕
            </button>
          </div>
          <span
            v-else
            class="cursor-text text-[11.5px] text-muted"
            title="Duplo clique para editar a FIPE"
            @dblclick="startEditField('fipe')"
          >
            {{ fipeFormatted ?? 'não consultada' }}
          </span>

          <UiButton v-if="editingField !== 'fipe'" variant="ghost" size="xs" class="ml-auto" @click.prevent="openFipeDialog">
            {{ fipeFormatted ? 'trocar' : 'consultar FIPE' }}
          </UiButton>
        </div>
        <div v-if="editError" class="text-[10.5px] font-medium text-danger">
          {{ editError }}
        </div>
      </div>

      <div class="mt-0.5 flex items-center gap-1.5">
        <div class="flex flex-1 flex-wrap gap-1.5 text-[10.5px] text-dim">
          <span v-if="vehicle.yard">📍 {{ vehicle.yard }}</span>
          <span v-if="vehicle.lot">Lote {{ vehicle.lot }}</span>
          <span v-if="vehicle.km">{{ vehicle.km }} km</span>
          <span v-if="auctionDateFormatted">🗓 {{ auctionDateFormatted }}</span>
        </div>
        <button
          type="button"
          :disabled="refreshing"
          class="shrink-0 rounded p-1 text-dim transition hover:bg-surface hover:text-soft disabled:opacity-40"
          title="Atualizar dados da fonte"
          @click.prevent="emit('refresh', vehicle)"
        >
          <svg
            viewBox="0 0 20 20"
            class="size-3.5"
            :class="refreshing && 'animate-spin'"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4a8 8 0 1 1 0 12M4 4v4h4" />
          </svg>
        </button>
      </div>
    </div>
  </article>

  <UiDialog v-model:open="showFipeDialog" title="Ajustar FIPE">
    <template #description>
      Consulte sugestões pela FIPE e aplique a opção correta para este veículo.
    </template>

    <form class="mb-4 grid gap-2 sm:grid-cols-[1fr_1fr_96px_auto]" @submit.prevent="fetchFipeSuggestions">
      <label class="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-dim">
        Marca
        <UiInput v-model="fipeSearch.brand" size="sm" placeholder="Marca" />
      </label>
      <label class="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-dim">
        Modelo
        <UiInput v-model="fipeSearch.model" size="sm" placeholder="Modelo" />
      </label>
      <label class="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wider text-dim">
        Ano
        <UiInput v-model="fipeSearch.year" size="sm" inputmode="numeric" placeholder="Ano" />
      </label>
      <div class="flex items-end">
        <UiButton type="submit" variant="primary" size="sm" :loading="fipeLoading" :disabled="fipeLoading">
          Buscar
        </UiButton>
      </div>
    </form>

    <div v-if="fipeError" class="mb-3 rounded-control border border-danger-line bg-danger-bg px-3 py-2 text-xs text-danger">
      {{ fipeError }}
    </div>

    <div v-if="fipeLoading" class="rounded-control border border-line bg-panel-soft px-3 py-4 text-center text-xs text-dim">
      Consultando FIPE...
    </div>

    <div v-else-if="fipeSuggestions.length > 0" class="flex flex-col gap-2">
      <div
        v-for="suggestion in fipeSuggestions"
        :key="fipeSuggestionKey(suggestion)"
        class="rounded-control border border-line bg-panel-soft px-3 py-2.5"
      >
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-semibold leading-snug text-body">
              {{ suggestion.brandName }} {{ suggestion.modelName }}
            </div>
            <div class="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px] text-dim">
              <span>{{ suggestion.yearName }}</span>
              <span v-if="suggestion.codeFipe">Código {{ suggestion.codeFipe }}</span>
              <span v-if="suggestion.fuel">{{ suggestion.fuel }}</span>
              <span v-if="suggestion.referenceMonth">{{ suggestion.referenceMonth }}</span>
            </div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-sm font-extrabold text-strong">{{ formatMoney(suggestion.price) }}</div>
            <div v-if="suggestionFipePercent(suggestion)" class="text-[11px] text-dim">
              {{ suggestionFipePercent(suggestion) }}
            </div>
          </div>
        </div>

        <div class="mt-2 flex justify-end">
          <UiButton
            variant="secondary"
            size="xs"
            :loading="fipeApplyingKey === fipeSuggestionKey(suggestion)"
            :disabled="fipeApplyingKey != null"
            @click="applyFipeSuggestion(suggestion)"
          >
            Aplicar esta FIPE
          </UiButton>
        </div>
      </div>
    </div>

    <div v-else class="rounded-control border border-line bg-panel-soft px-3 py-4 text-center text-xs text-dim">
      Ajuste marca, modelo ou ano e clique em buscar.
    </div>
  </UiDialog>
</template>
