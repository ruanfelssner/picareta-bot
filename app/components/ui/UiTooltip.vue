<script setup lang="ts">
import {
  TooltipArrow,
  TooltipContent,
  TooltipPortal,
  TooltipProvider,
  TooltipRoot,
  TooltipTrigger,
} from 'reka-ui'

withDefaults(defineProps<{
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  delayDuration?: number
}>(), {
  side: 'top',
  align: 'center',
  delayDuration: 180,
})
</script>

<template>
  <TooltipProvider :delay-duration="delayDuration">
    <TooltipRoot>
      <TooltipTrigger as-child>
        <slot />
      </TooltipTrigger>
      <TooltipPortal>
        <TooltipContent
          :side="side"
          :align="align"
          :side-offset="8"
          class="z-50 max-w-[280px] rounded-lg border border-line bg-canvas-deep px-3 py-2 text-[11.5px] leading-relaxed text-soft shadow-xl shadow-black/30"
        >
          <slot name="content" />
          <TooltipArrow class="fill-canvas-deep" />
        </TooltipContent>
      </TooltipPortal>
    </TooltipRoot>
  </TooltipProvider>
</template>
