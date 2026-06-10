<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui'

const open = defineModel<boolean>('open', { default: false })

defineProps<{
  title?: string
  description?: string
}>()
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal>
      <DialogOverlay class="fixed inset-0 z-[1000] bg-black/65 backdrop-blur-[2px]" />
      <DialogContent
        data-ui-dialog-content
        class="fixed left-1/2 top-1/2 z-[1001] flex max-h-[88vh] w-[calc(100vw-40px)] max-w-[700px] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-panel border border-line bg-panel shadow-[0_20px_60px_rgba(0,0,0,0.5)] focus:outline-none"
      >
        <header class="flex shrink-0 items-start justify-between gap-3 border-b border-line px-5 pb-3.5 pt-[18px]">
          <div>
            <DialogTitle class="mb-1 text-base font-bold text-body">
              <slot name="title">{{ title }}</slot>
            </DialogTitle>
            <DialogDescription v-if="$slots.description || description" class="max-w-[480px] text-xs leading-snug text-muted">
              <slot name="description">{{ description }}</slot>
            </DialogDescription>
          </div>
          <DialogClose class="rounded px-1 text-[13px] text-dim transition hover:text-body" aria-label="Fechar">
            x
          </DialogClose>
        </header>

        <div class="flex-1 overflow-y-auto px-5 py-4">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="flex shrink-0 items-center justify-between border-t border-line px-5 py-3">
          <slot name="footer" />
        </footer>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
