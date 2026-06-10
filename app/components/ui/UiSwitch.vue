<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui'

const model = defineModel<boolean>({ default: false })
</script>

<template>
  <SwitchRoot
    v-model="model"
    class="relative h-[15px] w-7 shrink-0 rounded-full border border-line-hover bg-line-soft transition data-[state=checked]:border-accent data-[state=checked]:bg-surface"
  >
    <SwitchThumb class="block size-[9px] translate-x-0.5 rounded-full bg-dim transition data-[state=checked]:translate-x-[13px] data-[state=checked]:bg-accent-soft" />
  </SwitchRoot>
</template>
