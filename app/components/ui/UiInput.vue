<script setup lang="ts">
const model = defineModel<string | number | null | undefined>()

withDefaults(defineProps<{
  size?: 'sm' | 'md' | 'lg'
}>(), {
  size: 'md',
})
</script>

<template>
  <input
    v-model="model"
    :class="[
      'w-full rounded-control border border-line-soft bg-panel-soft text-body outline-none transition placeholder:text-faint focus:border-accent',
      {
        sm: 'px-2.5 py-1.5 text-xs',
        md: 'px-3 py-2 text-[13px]',
        // 16px no mobile evita o zoom automático do iOS ao focar o campo.
        lg: 'min-h-11 px-3.5 py-2 text-base sm:text-sm',
      }[size],
    ]"
  />
</template>
