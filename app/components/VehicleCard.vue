<script setup lang="ts">
import { SOURCE_META } from '#shared/constants/sources'
import type { VehicleRecord } from '#shared/types/vehicle'

const props = withDefaults(defineProps<{
  vehicle: VehicleRecord
  showSendButton?: boolean
  compact?: boolean
}>(), {
  showSendButton: true,
  compact: false,
})

const emit = defineEmits<{
  send: [vehicle: VehicleRecord]
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
</script>

<template>
  <article
    :class="[
      'relative flex flex-col overflow-visible rounded-card border bg-panel transition hover:border-line-strong',
      vehicle.status === 'favorite' ? 'border-accent shadow-[0_0_0_1px_rgba(79,70,229,0.13)]' : 'border-line',
    ]"
  >
    <a :href="vehicle.url" target="_blank" class="relative block shrink-0 overflow-hidden rounded-t-card">
      <img
        v-if="vehicle.imageUrls?.[0]"
        :src="vehicle.imageUrls[0]"
        :alt="`${vehicle.brand} ${vehicle.model}`"
        :class="['block w-full object-cover bg-canvas', compact ? 'h-28' : 'h-64']"
        loading="lazy"
      />
      <div
        v-else
        :class="[
          'flex w-full flex-col items-center justify-center gap-1 bg-panel-soft text-xs text-dim',
          compact ? 'h-28' : 'h-[150px]',
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
        v-if="showSendButton && vehicle.status === 'scraped'"
        variant="whatsapp"
        size="icon"
        class="absolute bottom-3 right-3 z-10 transition enabled:hover:scale-105"
        title="Enviar via WhatsApp"
        @click.prevent="emit('send', vehicle)"
      >
        <svg viewBox="0 0 24 24" class="size-[18px]" fill="currentColor" aria-hidden="true">
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
        <span v-if="vehicle.status === 'favorite'" class="rounded bg-surface px-1.5 py-0.5 text-[10.5px] font-semibold text-accent-hover">
          Enviado
        </span>
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
          <span class="text-[10px] font-semibold uppercase tracking-[0.05em] text-dim">FIPE</span>
          <span class="text-[11.5px] text-muted">{{ fipeFormatted }}</span>
        </div>
      </div>

      <div class="mt-0.5 flex flex-wrap gap-1.5 text-[10.5px] text-dim">
        <span v-if="vehicle.yard">📍 {{ vehicle.yard }}</span>
        <span v-if="vehicle.lot">Lote {{ vehicle.lot }}</span>
        <span v-if="vehicle.km">{{ vehicle.km }} km</span>
        <span v-if="auctionDateFormatted">🗓 {{ auctionDateFormatted }}</span>
      </div>
    </div>
  </article>
</template>
