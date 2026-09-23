<script setup lang="ts">
const route = useRoute()
const showHeader = computed(() => !route.path.startsWith('/lance/'))

const navLinks = [
  { to: '/', label: 'Painel', exact: true },
  { to: '/cars', label: 'Veículos' },
  { to: '/scraping', label: 'Scraping' },
  { to: '/marketplace', label: 'Marketplace' },
  { to: '/live-history', label: 'Histórico Live' },
  { to: '/saves', label: 'Favoritos' },
  { to: '/admin/leiloes', label: 'Leilões' },
]
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <!-- Mobile: marca em cima e abas roláveis embaixo. Desktop: tudo numa linha. -->
    <nav v-if="showHeader" class="sticky top-0 z-[100] border-b border-line bg-panel/95 backdrop-blur md:flex md:h-12 md:items-center md:gap-6 md:px-5">
      <div class="flex h-11 items-center px-4 md:h-auto md:px-0">
        <NuxtLink to="/" class="text-[15px] font-semibold text-accent-soft">🚗 Buscador Leilões</NuxtLink>
      </div>
      <div class="flex gap-1 overflow-x-auto px-3 pb-2 scrollbar-none md:p-0 [&::-webkit-scrollbar]:hidden">
        <NuxtLink
          v-for="link in navLinks"
          :key="link.to"
          :to="link.to"
          class="shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body md:px-3.5"
          :active-class="link.exact ? undefined : 'bg-line text-accent-soft'"
          :exact-active-class="link.exact ? 'bg-line text-accent-soft' : undefined"
        >
          {{ link.label }}
        </NuxtLink>
      </div>
    </nav>

    <main class="w-full flex-1 px-4 py-4 sm:px-5 sm:py-5">
      <slot />
    </main>
  </div>
</template>
