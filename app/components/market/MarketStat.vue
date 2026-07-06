<script setup lang="ts">
defineProps<{
  label: string
  value: string
  hint?: string
}>()
</script>

<template>
  <div class="flex flex-col gap-1 rounded-card border border-line bg-panel px-4 py-3">
    <span class="text-tabular text-xl font-bold text-strong">{{ value }}</span>
    <span class="text-[11px] font-medium text-faint">{{ label }}</span>
    <span v-if="hint" class="text-[10.5px] leading-snug text-dim">{{ hint }}</span>
  </div>
</template>
