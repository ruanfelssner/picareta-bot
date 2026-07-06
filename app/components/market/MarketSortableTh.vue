<script setup lang="ts">
const props = withDefaults(defineProps<{
  label: string
  column: string
  activeColumn: string
  direction: 'asc' | 'desc'
  align?: 'left' | 'right'
}>(), {
  align: 'left',
})

const emit = defineEmits<{
  sort: [column: string]
}>()

const isActive = computed(() => props.activeColumn === props.column)
</script>

<template>
  <th
    class="cursor-pointer select-none whitespace-nowrap pb-1.5 pr-3 text-[10.5px] font-semibold uppercase tracking-wide transition hover:text-soft"
    :class="[align === 'right' ? 'text-right' : 'text-left', isActive ? 'text-accent-soft' : 'text-faint']"
    @click="emit('sort', column)"
  >
    <span class="inline-flex items-center gap-1" :class="align === 'right' && 'flex-row-reverse'">
      {{ label }}
      <span class="text-[9px]" :class="!isActive && 'opacity-40'">
        {{ isActive ? (direction === 'asc' ? '▲' : '▼') : '↕' }}
      </span>
    </span>
  </th>
</template>
