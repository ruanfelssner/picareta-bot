<script setup lang="ts">
const props = defineProps<{
  n: number
  sufficient: boolean
  minSample?: number
}>()

const label = computed(() => {
  if (props.n === 0) return 'sem dados'
  if (props.sufficient) return `n=${props.n} · amostra ok`
  return `n=${props.n} · baixa amostragem`
})

const variant = computed<'success' | 'warning' | 'danger'>(() => {
  if (props.n === 0) return 'danger'
  return props.sufficient ? 'success' : 'warning'
})
</script>

<template>
  <UiBadge :variant="variant" size="xs" :title="minSample ? `mínimo recomendado: n=${minSample}` : undefined">
    {{ label }}
  </UiBadge>
</template>
