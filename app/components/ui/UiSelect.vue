<script setup lang="ts">
const model = defineModel<string | number | null | undefined>()

withDefaults(defineProps<{
  size?: 'sm' | 'md'
}>(), {
  size: 'sm',
})
</script>

<template>
  <select
    v-model="model"
    :class="[
      'rounded-control border border-line bg-canvas text-body outline-none transition focus:border-accent',
      size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-[13px]',
    ]"
  >
    <slot />
  </select>
</template>
