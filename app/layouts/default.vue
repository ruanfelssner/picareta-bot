<script setup lang="ts">
const route = useRoute()
const showHeader = computed(() => !route.path.startsWith('/lance/'))
</script>

<template>
  <div class="flex min-h-screen flex-col">
    <nav v-if="showHeader" class="sticky top-0 z-[100] flex h-12 items-center gap-6 border-b border-line bg-panel px-5">
      <NuxtLink to="/" class="mr-2 text-[15px] font-semibold text-accent-soft">🚗 Buscador Leilões</NuxtLink>
      <div class="flex gap-1">
        <NuxtLink
          to="/"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          exact-active-class="bg-line text-accent-soft"
        >
          Painel
        </NuxtLink>
        <NuxtLink
          to="/cars"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          active-class="bg-line text-accent-soft"
        >
          Veículos
        </NuxtLink>
        <NuxtLink
          to="/scraping"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          active-class="bg-line text-accent-soft"
        >
          Scraping
        </NuxtLink>
        <NuxtLink
          to="/marketplace"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          active-class="bg-line text-accent-soft"
        >
          Marketplace
        </NuxtLink>
        <NuxtLink
          to="/live-history"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          active-class="bg-line text-accent-soft"
        >
          Histórico Live
        </NuxtLink>
        <NuxtLink
          to="/saves"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          active-class="bg-line text-accent-soft"
        >
          Favoritos
        </NuxtLink>
        <NuxtLink
          to="/admin/leiloes"
          class="rounded-md px-3.5 py-1.5 text-[13px] font-medium text-soft transition hover:bg-line hover:text-body"
          active-class="bg-line text-accent-soft"
        >
          Leilões
        </NuxtLink>
      </div>
    </nav>

    <main class="w-full flex-1 px-5 py-5">
      <slot />
    </main>
  </div>
</template>
