<script setup lang="ts">
const props = defineProps<{
  value: number | null
}>()

const width = computed(() => (props.value != null ? Math.min(100, Math.max(3, props.value)) : 0))

const tone = computed<'success' | 'info' | 'danger' | 'muted'>(() => {
  if (props.value == null) return 'muted'
  if (props.value <= 55) return 'success'
  if (props.value <= 75) return 'info'
  return 'danger'
})

const barClass = computed(() => ({
  success: 'bg-success',
  info: 'bg-info',
  danger: 'bg-danger',
  muted: 'bg-line',
}[tone.value]))

const textClass = computed(() => ({
  success: 'text-success',
  info: 'text-info',
  danger: 'text-danger',
  muted: 'text-faint',
}[tone.value]))
</script>

<template>
  <div class="flex items-center gap-2">
    <div class="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-surface">
      <div v-if="value != null" class="h-full rounded-full transition-all" :class="barClass" :style="{ width: `${width}%` }" />
    </div>
    <span class="text-tabular shrink-0 font-semibold" :class="textClass">
      {{ value != null ? `${value.toLocaleString('pt-BR')}%` : '—' }}
    </span>
  </div>
</template>
