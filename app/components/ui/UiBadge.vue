<script setup lang="ts">
const props = withDefaults(defineProps<{
  variant?: 'accent' | 'success' | 'info' | 'warning' | 'danger' | 'muted'
  size?: 'xs' | 'sm'
}>(), {
  variant: 'accent',
  size: 'sm',
})

const variantClass = computed(() => ({
  accent: 'bg-accent text-white',
  success: 'bg-success-bg text-success',
  info: 'bg-info-bg text-info',
  warning: 'bg-warning-bg text-warning',
  danger: 'bg-danger-bg text-danger',
  muted: 'bg-surface text-accent-soft',
})[props.variant])

const sizeClass = computed(() => props.size === 'xs'
  ? 'min-h-4 min-w-4 px-1 text-[9px]'
  : 'min-h-[18px] min-w-[18px] px-1.5 text-[10px]')
</script>

<template>
  <span :class="['inline-flex items-center justify-center rounded-full font-bold leading-none', sizeClass, variantClass]">
    <slot />
  </span>
</template>
