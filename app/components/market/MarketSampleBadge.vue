<script setup lang="ts">
const props = withDefaults(defineProps<{
  n: number
  sufficient: boolean
  minSample?: number
  compact?: boolean
}>(), {
  compact: false,
})

const label = computed(() => {
  if (props.n === 0) return 'sem dados'
  if (props.compact) return `n=${props.n}`
  if (props.sufficient) return `n=${props.n} · amostra ok`
  return `n=${props.n} · baixa amostragem`
})

const title = computed(() => {
  const parts: string[] = []
  if (props.minSample != null) parts.push(`mínimo recomendado: n=${props.minSample}`)
  if (props.compact && props.n > 0) parts.push(props.sufficient ? 'amostra ok' : 'baixa amostragem')
  return parts.length > 0 ? parts.join(' · ') : undefined
})

const variant = computed<'success' | 'warning' | 'danger'>(() => {
  if (props.n === 0) return 'danger'
  return props.sufficient ? 'success' : 'warning'
})
</script>

<template>
  <UiBadge :variant="variant" size="xs" :title="title">
    {{ label }}
  </UiBadge>
</template>
