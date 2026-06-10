<script setup lang="ts">
const model = defineModel<string | number | null | undefined>()

withDefaults(defineProps<{
  size?: 'sm' | 'md'
}>(), {
  size: 'md',
})
</script>

<template>
  <input
    v-model="model"
    :class="[
      'w-full rounded-control border border-line-soft bg-panel-soft text-body outline-none transition placeholder:text-faint focus:border-accent',
      size === 'sm' ? 'px-2.5 py-1.5 text-xs' : 'px-3 py-2 text-[13px]',
    ]"
  />
</template>
