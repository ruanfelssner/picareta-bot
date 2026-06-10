<script setup lang="ts">
const props = withDefaults(defineProps<{
  size?: 'full' | 'narrow'
}>(), {
  size: 'full',
})

const sizeClass = computed(() => props.size === 'narrow' ? 'max-w-[800px]' : 'max-w-none')
</script>

<template>
  <div :class="['w-full', sizeClass]">
    <slot />
  </div>
</template>
