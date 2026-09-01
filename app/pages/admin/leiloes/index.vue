<script setup lang="ts">
import type { BidRecord, PublicAuctionVehicle } from '#shared/types/auction'

type AuctionView = {
  auction: AuctionSummary
  vehicle: PublicAuctionVehicle | null
}

type AuctionSummary = {
  id: string
  vehicleId: string
  status: 'draft' | 'available' | 'finished'
  startingBid: number
  increment: number
  currentBid: number | null
  nextBid: number
  autoApproveBids: boolean
  publicUrl: string
  bidsCount: number
  pendingBids: number
  createdAt: string | null
}

type AuctionsResponse = { auctions: AuctionView[] }
type VehiclesResponse = { vehicles: (PublicAuctionVehicle & { scrapedAt: string | null })[] }
type BidsResponse = { bids: (BidRecord & { id: string; status: string; rejectionReason: string | null; createdAt: string })[] }
type CommunityResponse = { community: { name: string; zapiCommunityId: string; announcementGroupId: string; invitationLink: string | null } | null }

const filter = ref<'all' | 'draft' | 'available' | 'finished'>('all')
const filterOptions: { value: typeof filter.value; label: string }[] = [
  { value: 'all', label: 'Todos' }, { value: 'draft', label: 'Rascunhos' },
  { value: 'available', label: 'Em andamento' }, { value: 'finished', label: 'Finalizados' },
]
const selectedVehicleId = ref('')
const startingBid = ref<number | null>(null)
const increment = ref<number | null>(1000)
const autoApproveBids = ref(true)
const communityName = ref('Ofertas e Leilões Felssner Garage')
const communityId = ref('')
const announcementGroupId = ref('')
const expandedAuctionId = ref<string | null>(null)
const bidsByAuction = ref<Record<string, BidsResponse['bids']>>({})
const busy = ref<string | null>(null)
const feedback = ref('')

const { data: auctionsData, refresh: refreshAuctions } = await useFetch<AuctionsResponse>('/api/auctions')
const { data: vehiclesData } = await useFetch<VehiclesResponse>('/api/auctions/vehicles')
const { data: communityData, refresh: refreshCommunity } = await useFetch<CommunityResponse>('/api/auctions/community')

const auctions = computed(() => (auctionsData.value?.auctions ?? []).filter(({ auction }) => filter.value === 'all' || auction.status === filter.value))
const vehicles = computed(() => vehiclesData.value?.vehicles ?? [])
const community = computed(() => communityData.value?.community ?? null)

function setFilter(value: typeof filter.value) { filter.value = value }

function money(value: number | null | undefined): string {
  if (value == null) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function date(value: string | null | undefined): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function messageFrom(error: unknown): string {
  if (error && typeof error === 'object') {
    const data = (error as { data?: { message?: string }; message?: string }).data
    return data?.message ?? (error as { message?: string }).message ?? 'Não foi possível concluir a ação.'
  }
  return 'Não foi possível concluir a ação.'
}

async function runAction(key: string, action: () => Promise<void>) {
  busy.value = key
  feedback.value = ''
  try { await action(); await refreshAuctions() }
  catch (error) { feedback.value = messageFrom(error) }
  finally { busy.value = null }
}

async function createAuction() {
  if (!selectedVehicleId.value || startingBid.value == null || increment.value == null) {
    feedback.value = 'Selecione um veículo e informe os valores do leilão.'
    return
  }
  await runAction('create', async () => {
    await $fetch('/api/auctions', { method: 'POST', body: { vehicleId: selectedVehicleId.value, startingBid: startingBid.value, increment: increment.value, autoApproveBids: autoApproveBids.value } })
    selectedVehicleId.value = ''
    startingBid.value = null
    feedback.value = 'Rascunho criado.'
  })
}

async function publish(id: string) {
  await runAction(`publish-${id}`, async () => {
    await $fetch(`/api/auctions/${id}/publish`, { method: 'POST' })
    feedback.value = 'Leilão publicado e evento enviado para a fila do WhatsApp.'
  })
}

async function saveDraft(item: AuctionView) {
  await runAction(`save-${item.auction.id}`, async () => {
    await $fetch(`/api/auctions/${item.auction.id}`, {
      method: 'PATCH',
      body: {
        vehicleId: item.auction.vehicleId,
        startingBid: item.auction.startingBid,
        increment: item.auction.increment,
        autoApproveBids: item.auction.autoApproveBids,
      },
    })
    feedback.value = 'Configuração do rascunho salva.'
  })
}

async function finish(id: string) {
  if (!window.confirm('Finalizar este leilão? Novos lances serão bloqueados.')) return
  await runAction(`finish-${id}`, async () => {
    await $fetch(`/api/auctions/${id}/finish`, { method: 'POST' })
    feedback.value = 'Leilão finalizado.'
  })
}

async function toggleBids(id: string) {
  if (expandedAuctionId.value === id) { expandedAuctionId.value = null; return }
  expandedAuctionId.value = id
  if (bidsByAuction.value[id]) return
  try {
    const result = await $fetch<BidsResponse>(`/api/auctions/${id}/bids`)
    bidsByAuction.value[id] = result.bids
  } catch (error) { feedback.value = messageFrom(error) }
}

async function bidAction(id: string, action: 'accept' | 'reject') {
  await runAction(`${action}-${id}`, async () => {
    await $fetch(`/api/auctions/bids/${id}/${action}`, { method: 'POST' })
    for (const key of Object.keys(bidsByAuction.value)) delete bidsByAuction.value[key]
    feedback.value = action === 'accept' ? 'Lance aceito e publicado no WhatsApp.' : 'Lance recusado.'
  })
}

async function copyLink(path: string) {
  const url = `${window.location.origin}${path}`
  await navigator.clipboard.writeText(url)
  feedback.value = 'Link público copiado.'
}

async function saveCommunity() {
  await runAction('community', async () => {
    await $fetch('/api/auctions/community', { method: 'POST', body: { name: communityName.value, zapiCommunityId: communityId.value || undefined, announcementGroupId: announcementGroupId.value || undefined } })
    await refreshCommunity()
    feedback.value = 'Comunidade salva. Os próximos avisos usarão o grupo configurado.'
  })
}

async function generateInvitationLink() {
  await runAction('invitation-link', async () => {
    await $fetch('/api/auctions/community/invitation-link', { method: 'POST' })
    await refreshCommunity()
    feedback.value = 'Link de convite gerado.'
  })
}

async function copyInvitationLink() {
  if (!community.value?.invitationLink) return
  await navigator.clipboard.writeText(community.value.invitationLink)
  feedback.value = 'Link de convite copiado.'
}
</script>

<template>
  <div class="mx-auto max-w-6xl space-y-5">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p class="text-xs font-semibold uppercase tracking-[0.16em] text-accent-soft">Operação</p>
        <h1 class="mt-1 text-2xl font-bold text-strong">Leilões</h1>
        <p class="mt-1 text-sm text-muted">Publique veículos, acompanhe lances e finalize a disputa.</p>
      </div>
      <NuxtLink to="/cars" class="text-xs text-accent-soft hover:text-strong">Voltar para veículos →</NuxtLink>
    </header>

    <p v-if="feedback" class="rounded-control border border-info/30 bg-info-bg px-3 py-2 text-sm text-info">{{ feedback }}</p>

    <UiCard class="p-4">
      <div class="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold text-strong">Novo leilão</h2>
          <p class="text-xs text-muted">O cadastro começa como rascunho e já recebe uma URL pública.</p>
        </div>
        <UiBadge variant="muted">POC</UiBadge>
      </div>
      <div class="grid gap-3 md:grid-cols-[minmax(0,2fr)_1fr_1fr_auto] md:items-end">
        <UiField label="Veículo">
          <UiSelect v-model="selectedVehicleId" size="md">
            <option value="">Selecione um veículo</option>
            <option v-for="vehicle in vehicles" :key="vehicle.id" :value="vehicle.id">
              {{ vehicle.brand }} {{ vehicle.model }}{{ vehicle.year ? ` ${vehicle.year}` : '' }}
            </option>
          </UiSelect>
        </UiField>
        <UiField label="Valor inicial (R$)"><UiInput v-model="startingBid" type="number" min="1" /></UiField>
        <UiField label="Incremento (R$)"><UiInput v-model="increment" type="number" min="1" /></UiField>
        <UiButton variant="primary" :loading="busy === 'create'" @click="createAuction">Criar rascunho</UiButton>
      </div>
      <label class="mt-3 flex items-center gap-2 text-xs text-muted">
        <UiSwitch v-model="autoApproveBids" /> Aceitar lances automaticamente
      </label>
    </UiCard>

    <UiCard class="p-4">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 class="font-semibold text-strong">WhatsApp / Comunidade</h2>
          <p class="text-xs text-muted">Se os IDs ficarem vazios, o botão tenta criar a comunidade na Z-API.</p>
        </div>
        <UiBadge v-if="community" variant="success">Configurada</UiBadge>
        <UiBadge v-else variant="warning">Pendente</UiBadge>
      </div>
      <div v-if="community" class="mt-3 grid gap-2 text-xs text-muted md:grid-cols-3">
        <span>Nome: <strong class="text-soft">{{ community.name }}</strong></span>
        <span>Comunidade: <strong class="text-soft">{{ community.zapiCommunityId }}</strong></span>
        <span>Grupo de avisos: <strong class="text-soft">{{ community.announcementGroupId }}</strong></span>
      </div>
      <div v-if="community" class="mt-3 flex flex-wrap items-center gap-2 border-t border-line-soft pt-3">
        <UiButton size="xs" :loading="busy === 'invitation-link'" @click="generateInvitationLink">{{ community.invitationLink ? 'Gerar novo link' : 'Gerar link de convite' }}</UiButton>
        <UiButton v-if="community.invitationLink" size="xs" @click="copyInvitationLink">Copiar link</UiButton>
        <a v-if="community.invitationLink" :href="community.invitationLink" target="_blank" rel="noopener" class="max-w-full truncate text-xs text-accent-soft hover:text-strong">{{ community.invitationLink }}</a>
      </div>
      <details class="mt-3">
        <summary class="cursor-pointer text-xs font-semibold text-accent-soft">Configurar comunidade</summary>
        <div class="mt-3 grid gap-3 md:grid-cols-3">
          <UiField label="Nome"><UiInput v-model="communityName" /></UiField>
          <UiField label="ID da comunidade (opcional)"><UiInput v-model="communityId" /></UiField>
          <UiField label="ID do grupo de avisos (opcional)"><UiInput v-model="announcementGroupId" /></UiField>
        </div>
        <UiButton class="mt-3" :loading="busy === 'community'" @click="saveCommunity">Salvar comunidade</UiButton>
      </details>
    </UiCard>

    <div class="flex flex-wrap gap-2">
      <UiChip v-for="item in filterOptions" :key="item.value" :active="filter === item.value" @click="setFilter(item.value)">{{ item.label }}</UiChip>
    </div>

    <div v-if="auctions.length === 0" class="rounded-card border border-dashed border-line p-8 text-center text-sm text-muted">Nenhum leilão neste filtro.</div>
    <div v-for="item in auctions" :key="item.auction.id" class="rounded-card border border-line bg-panel p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex min-w-0 gap-3">
          <img v-if="item.vehicle?.imageUrls[0]" :src="item.vehicle.imageUrls[0]" class="size-16 rounded-control object-cover" alt="">
          <div>
            <h2 class="font-semibold text-strong">{{ item.vehicle ? `${item.vehicle.brand} ${item.vehicle.model} ${item.vehicle.year ?? ''}` : 'Veículo indisponível' }}</h2>
            <p class="mt-1 text-xs text-muted">{{ item.vehicle?.km ? `${item.vehicle.km} km · ` : '' }}{{ date(item.auction.createdAt) }}</p>
          </div>
        </div>
        <UiBadge :variant="item.auction.status === 'available' ? 'success' : item.auction.status === 'finished' ? 'muted' : 'warning'">{{ item.auction.status === 'available' ? 'Em andamento' : item.auction.status === 'finished' ? 'Finalizado' : 'Rascunho' }}</UiBadge>
      </div>
      <div class="mt-4 grid grid-cols-2 gap-3 border-y border-line-soft py-3 text-xs md:grid-cols-5">
        <span><b class="block text-muted">Maior lance</b><strong class="text-sm text-strong">{{ money(item.auction.currentBid) }}</strong></span>
        <span><b class="block text-muted">Próximo lance</b><strong class="text-sm text-accent-soft">{{ money(item.auction.nextBid) }}</strong></span>
        <span><b class="block text-muted">Incremento</b><strong class="text-sm text-soft">{{ money(item.auction.increment) }}</strong></span>
        <span><b class="block text-muted">Lances</b><strong class="text-sm text-soft">{{ item.auction.bidsCount }} <small v-if="item.auction.pendingBids">({{ item.auction.pendingBids }} pend.)</small></strong></span>
        <span><b class="block text-muted">Aprovação</b><strong class="text-sm text-soft">{{ item.auction.autoApproveBids ? 'Automática' : 'Manual' }}</strong></span>
      </div>
      <div class="mt-3 flex flex-wrap gap-2">
        <UiButton size="xs" @click="toggleBids(item.auction.id)">{{ expandedAuctionId === item.auction.id ? 'Ocultar lances' : 'Ver lances' }}</UiButton>
        <UiButton size="xs" @click="copyLink(item.auction.publicUrl)">Copiar link</UiButton>
        <UiButton v-if="item.auction.status === 'draft'" size="xs" variant="primary" :loading="busy === `publish-${item.auction.id}`" @click="publish(item.auction.id)">Publicar</UiButton>
        <UiButton v-if="item.auction.status === 'available'" size="xs" variant="danger" :loading="busy === `finish-${item.auction.id}`" @click="finish(item.auction.id)">Finalizar</UiButton>
        <NuxtLink :to="item.auction.publicUrl" target="_blank" class="inline-flex min-h-6 items-center rounded-control border border-line px-2 text-[11px] font-semibold text-accent-soft">Abrir página</NuxtLink>
      </div>
      <details v-if="item.auction.status === 'draft'" class="mt-3 border-t border-line-soft pt-3">
        <summary class="cursor-pointer text-xs font-semibold text-accent-soft">Editar configuração</summary>
        <div class="mt-3 grid gap-3 md:grid-cols-[minmax(0,2fr)_1fr_1fr_auto_auto] md:items-end">
          <UiField label="Veículo"><UiSelect v-model="item.auction.vehicleId" size="md"><option v-for="vehicle in vehicles" :key="vehicle.id" :value="vehicle.id">{{ vehicle.brand }} {{ vehicle.model }}{{ vehicle.year ? ` ${vehicle.year}` : '' }}</option></UiSelect></UiField>
          <UiField label="Valor inicial (R$)"><UiInput v-model="item.auction.startingBid" type="number" min="1" /></UiField>
          <UiField label="Incremento (R$)"><UiInput v-model="item.auction.increment" type="number" min="1" /></UiField>
          <label class="flex items-center gap-2 pb-2 text-xs text-muted"><UiSwitch v-model="item.auction.autoApproveBids" /> Aprovação automática</label>
          <UiButton size="xs" :loading="busy === `save-${item.auction.id}`" @click="saveDraft(item)">Salvar</UiButton>
        </div>
      </details>
      <div v-if="expandedAuctionId === item.auction.id" class="mt-4 border-t border-line-soft pt-3">
        <p v-if="!bidsByAuction[item.auction.id]" class="text-xs text-muted">Carregando lances…</p>
        <p v-else-if="bidsByAuction[item.auction.id].length === 0" class="text-xs text-muted">Nenhum lance registrado.</p>
        <div v-for="bid in bidsByAuction[item.auction.id]" v-else :key="bid.id" class="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft py-2 text-xs last:border-0">
          <span><strong class="text-soft">{{ bid.bidderName }}</strong> · {{ date(bid.createdAt) }}<small v-if="bid.rejectionReason" class="ml-2 text-danger">{{ bid.rejectionReason }}</small></span>
          <span class="flex items-center gap-2"><strong class="text-strong">{{ money(bid.amount) }}</strong><UiBadge :variant="bid.status === 'accepted' ? 'success' : bid.status === 'rejected' ? 'danger' : 'warning'" size="xs">{{ bid.status === 'accepted' ? 'Aceito' : bid.status === 'rejected' ? 'Recusado' : 'Pendente' }}</UiBadge><template v-if="bid.status === 'pending'"><UiButton size="xs" variant="primary" :loading="busy === `accept-${bid.id}`" @click="bidAction(bid.id, 'accept')">Aceitar</UiButton><UiButton size="xs" variant="danger" :loading="busy === `reject-${bid.id}`" @click="bidAction(bid.id, 'reject')">Recusar</UiButton></template></span>
        </div>
      </div>
    </div>
  </div>
</template>
