<script setup lang="ts">
defineProps<{
  label?: string
}>()
</script>

<template>
  <label class="flex min-w-[140px] flex-col gap-1">
    <span v-if="label" class="text-[11px] font-medium text-muted">{{ label }}</span>
    <slot />
  </label>
</template>
