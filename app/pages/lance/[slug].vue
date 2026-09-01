<script setup lang="ts">
import type { PublicAuctionVehicle, PublicBid } from '#shared/types/auction'

type PublicAuction = {
  auction: { id: string; status: 'draft' | 'available' | 'finished'; startingBid: number; increment: number; currentBid: number | null; nextBid: number; publicSlug: string; bidsCount: number }
  vehicle: PublicAuctionVehicle
  bids: PublicBid[]
}

const route = useRoute()
const slug = String(route.params.slug)
const bidderName = ref('')
const sessionId = ref('')
const showConfirm = ref(false)
const submitting = ref(false)
const feedback = ref<{ kind: 'success' | 'info' | 'error'; text: string } | null>(null)
const { data, error, refresh } = await useFetch<PublicAuction>(`/api/public/auctions/${encodeURIComponent(slug)}`)
let refreshTimer: number | undefined

onMounted(() => {
  const key = 'auction-bidder-session'
  sessionId.value = sessionStorage.getItem(key) ?? crypto.randomUUID()
  sessionStorage.setItem(key, sessionId.value)
  refreshTimer = window.setInterval(() => refresh(), 10_000)
})
onBeforeUnmount(() => {
  if (refreshTimer != null) window.clearInterval(refreshTimer)
})

const auction = computed(() => data.value?.auction)
const vehicle = computed(() => data.value?.vehicle)
const canBid = computed(() => auction.value?.status === 'available' && bidderName.value.trim().length >= 2)

function money(value: number | null | undefined): string {
  if (value == null) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function date(value: string): string {
  return new Date(value).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
}

function errorMessage(): string {
  const raw = error.value as unknown as { data?: { message?: string }; message?: string } | null
  return raw?.data?.message ?? raw?.message ?? 'Leilão não encontrado.'
}

function askForBid() {
  if (!canBid.value) return
  showConfirm.value = true
}

async function submitBid() {
  submitting.value = true
  feedback.value = null
  try {
    const result = await $fetch<{ accepted: boolean; bid: { amount: number } }>(`/api/public/auctions/${encodeURIComponent(slug)}/bids`, { method: 'POST', body: { name: bidderName.value, sessionId: sessionId.value } })
    showConfirm.value = false
    feedback.value = result.accepted
      ? { kind: 'success', text: `Lance confirmado! Seu lance de ${money(result.bid.amount)} foi registrado e você é o maior lance atualmente.` }
      : { kind: 'info', text: `Lance recebido! Seu lance de ${money(result.bid.amount)} foi enviado para análise.` }
    await refresh()
  } catch (requestError) {
    feedback.value = { kind: 'error', text: errorMessageFrom(requestError) }
    showConfirm.value = false
    await refresh()
  } finally { submitting.value = false }
}

function errorMessageFrom(value: unknown): string {
  if (value && typeof value === 'object') {
    const item = value as { data?: { message?: string }; message?: string }
    return item.data?.message ?? item.message ?? 'Não foi possível registrar o lance.'
  }
  return 'Não foi possível registrar o lance.'
}

useHead(() => ({ title: vehicle.value ? `Lance — ${vehicle.value.brand} ${vehicle.value.model}` : 'Leilão de veículos' }))
</script>

<template>
  <main class="mx-auto max-w-2xl py-2 sm:py-8">
    <div v-if="error" class="rounded-card border border-danger-line bg-danger-bg p-6 text-center text-danger">{{ errorMessage() }}</div>
    <div v-else-if="!auction || !vehicle" class="rounded-card border border-line bg-panel p-6 text-center text-muted">Carregando leilão…</div>
    <div v-else class="space-y-4">
      <header class="rounded-card border border-line bg-panel p-5">
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft">Felssner Garage · Leilão</p>
        <h1 class="mt-2 text-2xl font-bold text-strong">{{ vehicle.brand }} {{ vehicle.model }}{{ vehicle.year ? ` ${vehicle.year}` : '' }}</h1>
        <div class="mt-2 flex flex-wrap gap-2 text-xs text-muted"><span v-if="vehicle.year">{{ vehicle.year }}</span><span v-if="vehicle.km">{{ vehicle.km }} km</span><span v-if="vehicle.fuel">{{ vehicle.fuel }}</span></div>
        <img v-if="vehicle.imageUrls[0]" :src="vehicle.imageUrls[0]" class="mt-4 aspect-[16/10] w-full rounded-control object-cover" alt="Foto do veículo">
        <div v-else class="mt-4 flex aspect-[16/10] items-center justify-center rounded-control bg-panel-soft text-sm text-muted">Foto não disponível</div>
      </header>

      <p v-if="auction.status === 'draft'" class="rounded-card border border-warning/30 bg-warning-bg p-4 text-sm text-warning">Este veículo ainda não está disponível para lances.</p>
      <p v-else-if="auction.status === 'finished'" class="rounded-card border border-line bg-panel p-4 text-sm text-muted"><strong class="text-soft">Leilão finalizado.</strong> Esta página continua disponível para consulta.</p>
      <p v-if="feedback" :class="['rounded-card border p-4 text-sm', feedback.kind === 'success' && 'border-success/30 bg-success-bg text-success', feedback.kind === 'info' && 'border-info/30 bg-info-bg text-info', feedback.kind === 'error' && 'border-danger-line bg-danger-bg text-danger']">{{ feedback.text }}</p>

      <section class="rounded-card border border-line bg-panel p-5">
        <div class="grid grid-cols-2 gap-4 text-center">
          <div><p class="text-xs font-semibold uppercase tracking-wide text-muted">Maior lance</p><p class="mt-1 text-2xl font-bold text-strong">{{ money(auction.currentBid) }}</p></div>
          <div><p class="text-xs font-semibold uppercase tracking-wide text-muted">Próximo lance</p><p class="mt-1 text-2xl font-bold text-accent-soft">{{ money(auction.nextBid) }}</p></div>
        </div>
        <p class="mt-3 text-center text-xs text-muted">Incrementos de {{ money(auction.increment) }} · {{ auction.bidsCount }} lance{{ auction.bidsCount === 1 ? '' : 's' }}</p>
        <div v-if="auction.status === 'available'" class="mt-5 space-y-3">
          <UiField label="Seu nome"><UiInput v-model="bidderName" maxlength="80" placeholder="Como devemos identificar você?" @keyup.enter="askForBid" /></UiField>
          <UiButton variant="primary" size="md" block :disabled="!canBid" @click="askForBid">Dar lance de {{ money(auction.nextBid) }}</UiButton>
        </div>
      </section>

      <section v-if="data?.bids.length" class="rounded-card border border-line bg-panel p-5">
        <h2 class="font-semibold text-strong">Últimos lances</h2>
        <div class="mt-2 divide-y divide-line-soft"><div v-for="bid in data.bids" :key="bid.id" class="flex items-center justify-between py-2 text-sm"><span class="text-soft">{{ bid.bidderName }}</span><span class="text-right"><strong class="block text-strong">{{ money(bid.amount) }}</strong><small class="text-muted">{{ date(bid.createdAt) }}</small></span></div></div>
      </section>
    </div>

    <UiDialog v-model:open="showConfirm" title="Confirmar lance" description="O valor será calculado novamente pelo servidor no momento da confirmação.">
      <div v-if="auction" class="space-y-2 text-sm text-muted"><p>Veículo: <strong class="text-soft">{{ vehicle?.brand }} {{ vehicle?.model }}</strong></p><p>Seu lance: <strong class="text-lg text-accent-soft">{{ money(auction.nextBid) }}</strong></p><p>Nome: <strong class="text-soft">{{ bidderName }}</strong></p></div>
      <template #footer><div class="flex w-full justify-end gap-2"><UiButton @click="showConfirm = false">Cancelar</UiButton><UiButton variant="primary" :loading="submitting" @click="submitBid">Confirmar lance</UiButton></div></template>
    </UiDialog>
  </main>
</template>
