<script setup lang="ts">
const props = withDefaults(defineProps<{
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'dashed' | 'whatsapp'
  size?: 'xs' | 'sm' | 'md' | 'icon'
  type?: 'button' | 'submit' | 'reset'
  active?: boolean
  block?: boolean
  loading?: boolean
  disabled?: boolean
}>(), {
  variant: 'secondary',
  size: 'sm',
  type: 'button',
  active: false,
  block: false,
  loading: false,
  disabled: false,
})

const variantClass = computed(() => {
  if (props.active) return 'border-accent bg-surface text-accent-soft'

  return {
    primary: 'border-transparent bg-accent text-white enabled:hover:bg-accent-hover',
    secondary: 'border-line bg-panel text-muted enabled:hover:border-line-hover enabled:hover:bg-surface-hover enabled:hover:text-soft',
    ghost: 'border-transparent bg-transparent text-muted enabled:hover:bg-surface enabled:hover:text-soft',
    danger: 'border-danger-line bg-transparent text-muted enabled:hover:border-danger enabled:hover:bg-danger-bg enabled:hover:text-danger',
    dashed: 'border-dashed border-line-hover bg-transparent text-dim enabled:hover:border-danger enabled:hover:text-danger',
    whatsapp: 'border-transparent bg-whatsapp text-white shadow-[0_3px_10px_rgba(37,211,102,0.45)] enabled:hover:bg-whatsapp-hover enabled:hover:shadow-[0_4px_14px_rgba(37,211,102,0.6)]',
  }[props.variant]
})

const sizeClass = computed(() => ({
  xs: 'min-h-6 px-2 text-[11px]',
  sm: 'min-h-8 px-3 text-xs',
  md: 'min-h-9 px-5 text-[13px]',
  icon: 'size-8 p-0 text-sm',
})[props.size])
</script>

<template>
  <button
    :type="type"
    :disabled="disabled || loading"
    :class="[
      'inline-flex items-center justify-center gap-2 rounded-control border font-semibold transition disabled:opacity-50',
      sizeClass,
      variantClass,
      block && 'w-full',
      variant === 'whatsapp' && 'rounded-full',
    ]"
  >
    <span
      v-if="loading"
      class="inline-block size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
    />
    <slot />
  </button>
</template>
