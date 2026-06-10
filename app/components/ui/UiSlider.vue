<script setup lang="ts">
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui'

const props = withDefaults(defineProps<{
  min: number
  max: number
  step?: number
  modelValueMin: number | null
  modelValueMax: number | null
}>(), {
  step: 1,
})

const emit = defineEmits<{
  'update:modelValueMin': [value: number | null]
  'update:modelValueMax': [value: number | null]
}>()

const sliderValue = computed<number[]>({
  get() {
    return [props.modelValueMin ?? props.min, props.modelValueMax ?? props.max]
  },
  set(value) {
    const [rawMin = props.min, rawMax = props.max] = value
    const safeMin = Math.min(rawMin, rawMax - props.step)
    const safeMax = Math.max(rawMax, safeMin + props.step)

    emit('update:modelValueMin', safeMin <= props.min ? null : safeMin)
    emit('update:modelValueMax', safeMax >= props.max ? null : safeMax)
  },
})
</script>

<template>
  <SliderRoot
    v-model="sliderValue"
    class="relative my-1.5 flex h-6 w-full touch-none select-none items-center"
    :min="min"
    :max="max"
    :step="step"
    :min-steps-between-thumbs="1"
  >
    <SliderTrack class="relative h-1 grow overflow-hidden rounded-full bg-line-soft">
      <SliderRange class="absolute h-full rounded-full bg-accent" />
    </SliderTrack>
    <SliderThumb
      v-for="(_, index) in sliderValue"
      :key="index"
      class="block size-3.5 rounded-full border-2 border-accent bg-panel transition hover:bg-accent-soft focus:outline-none focus:ring-2 focus:ring-accent/30"
      aria-label="Valor do filtro"
    />
  </SliderRoot>
</template>
