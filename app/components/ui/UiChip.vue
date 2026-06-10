<script setup lang="ts">
const props = withDefaults(defineProps<{
  active?: boolean
  type?: 'button' | 'submit' | 'reset'
}>(), {
  active: false,
  type: 'button',
})
</script>

<template>
  <button
    :type="type"
    :class="[
      'inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium transition',
      active
        ? 'border-accent bg-surface text-accent-soft'
        : 'border-line-soft bg-transparent text-dim hover:border-line-hover hover:text-soft',
    ]"
  >
    <slot />
  </button>
</template>
