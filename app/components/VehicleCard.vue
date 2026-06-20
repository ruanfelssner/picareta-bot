<script setup lang="ts">
import { SOURCE_META } from '#shared/constants/sources'
import type { VehicleRecord } from '#shared/types/vehicle'
import { firstUsableVehicleImageUrl } from '#shared/utils/vehicle-images'
import type { VehicleDisplayRuleEvaluation } from '#shared/utils/vehicle-display-rules'

type VehicleCardVehicle = VehicleRecord & {
  displayRule?: VehicleDisplayRuleEvaluation | null
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
}>()

const fipePercent = computed(() => {
  const { price, fipe } = props.vehicle
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
  props.vehicle.price != null
    ? `R$ ${props.vehicle.price.toLocaleString('pt-BR')}`
    : '-',
)

const fipeFormatted = computed(() =>
  props.vehicle.fipe != null
    ? `R$ ${props.vehicle.fipe.toLocaleString('pt-BR')}`
    : null,
)

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
const sendButtonTitle = computed(() => isSentToWhatsapp.value ? 'Enviar novamente via WhatsApp' : 'Enviar via WhatsApp')

</script>

<template>
  <article
    :class="[
      'relative flex flex-col overflow-visible rounded-card border bg-panel transition hover:border-line-strong',
      vehicle.status === 'favorite' ? 'border-accent shadow-[0_0_0_1px_rgba(79,70,229,0.13)]' : 'border-line',
      isSentToWhatsapp && 'opacity-75 saturate-75 hover:opacity-100 hover:saturate-100',
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

      <UiButton
        v-if="showSendButton"
        variant="whatsapp"
        size="icon"
        :loading="sending"
        :disabled="sending"
        :class="[
          'absolute bottom-3 right-3 z-10 transition enabled:hover:scale-105',
          isSentToWhatsapp && 'opacity-60 shadow-none enabled:hover:opacity-100',
        ]"
        :title="sendButtonTitle"
        :aria-label="sendButtonTitle"
        @click.prevent="emit('send', vehicle)"
      >
        <svg v-if="!sending" viewBox="0 0 24 24" class="size-4.5" fill="currentColor" aria-hidden="true">
          <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z" />
        </svg>
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
        <span v-if="vehicle.damage" class="rounded bg-danger-bg px-1.5 py-0.5 text-[10.5px] font-medium text-danger">
          {{ vehicle.damage }}
        </span>
        <span v-if="isSentToWhatsapp" class="rounded bg-surface px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-hover">
          WhatsApp enviado
        </span>
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

      <a :href="vehicle.url" target="_blank" class="block text-[13px] font-semibold leading-snug text-body transition hover:text-accent-soft">
        {{ vehicle.brand }} {{ vehicle.model }}
        <span v-if="vehicle.year" class="ml-0.5 font-normal text-dim">{{ vehicle.year }}</span>
      </a>

      <div class="flex flex-col gap-0.5">
        <div class="flex flex-wrap items-baseline gap-2">
          <span class="text-base font-extrabold text-strong">{{ priceFormatted }}</span>
          <UiBadge v-if="fipePercent != null && fipeTier" :variant="fipeTier">
            {{ fipePercent }}% da FIPE
          </UiBadge>
        </div>
        <div v-if="fipeFormatted" class="flex items-center gap-1.5">
          <span class="text-[10px] font-semibold uppercase tracking-wider text-dim">FIPE</span>
          <span class="text-[11.5px] text-muted">{{ fipeFormatted }}</span>
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
</template>
