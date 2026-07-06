<script setup lang="ts">
const props = defineProps<{
  level: 'alta' | 'media' | 'baixa' | 'insuficiente'
}>()

const LABELS = {
  alta: 'Alta oportunidade',
  media: 'Oportunidade média',
  baixa: 'Baixa oportunidade',
  insuficiente: 'Dados insuficientes',
} as const

const VARIANTS = {
  alta: 'success',
  media: 'info',
  baixa: 'warning',
  insuficiente: 'danger',
} as const

const label = computed(() => LABELS[props.level])
const variant = computed(() => VARIANTS[props.level])
</script>

<template>
  <UiBadge :variant="variant" size="xs">{{ label }}</UiBadge>
</template>
