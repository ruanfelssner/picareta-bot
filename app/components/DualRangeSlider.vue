<script setup lang="ts">
withDefaults(defineProps<{
  min: number
  max: number
  step?: number
  modelValueMin: number | null
  modelValueMax: number | null
}>(), {
  step: 1,
})

defineEmits<{
  'update:modelValueMin': [value: number | null]
  'update:modelValueMax': [value: number | null]
}>()
</script>

<template>
  <UiSlider
    :min="min"
    :max="max"
    :step="step"
    :model-value-min="modelValueMin"
    :model-value-max="modelValueMax"
    @update:model-value-min="$emit('update:modelValueMin', $event)"
    @update:model-value-max="$emit('update:modelValueMax', $event)"
  />
</template>
