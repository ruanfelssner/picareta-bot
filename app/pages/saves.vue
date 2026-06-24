<script setup lang="ts">
import type { FavoriteRecord, VehicleRecord } from '#shared/types/vehicle'

type FavoriteListRecord = FavoriteRecord & {
  currentVehicle?: VehicleRecord | null
}

const page = ref(1)

const { data, refresh } = await useFetch<{ favorites: FavoriteListRecord[]; total: number }>('/api/favorites', {
  query: computed(() => ({ page: page.value, limit: 50 })),
})

const favorites = computed(() => data.value?.favorites ?? [])
const total = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 50))

const editing = ref<string | null>(null)
const editForm = ref({ soldPrice: '', soldAt: '', soldFipe: '', notes: '' })
const saving = ref(false)

function openEdit(fav: FavoriteRecord) {
  editing.value = fav._id!
  editForm.value = {
    soldPrice: fav.soldPrice != null ? String(fav.soldPrice) : '',
    soldAt: fav.soldAt ? new Date(fav.soldAt).toISOString().slice(0, 10) : '',
    soldFipe: fav.soldFipe != null ? String(fav.soldFipe) : '',
    notes: fav.notes ?? '',
  }
}

function closeEdit() {
  editing.value = null
}

async function saveEdit(id: string) {
  saving.value = true
  try {
    const body: Record<string, unknown> = {
      soldPrice: editForm.value.soldPrice ? Number(editForm.value.soldPrice) : null,
      soldAt: editForm.value.soldAt || null,
      soldFipe: editForm.value.soldFipe ? Number(editForm.value.soldFipe) : null,
      notes: editForm.value.notes || null,
    }
    await $fetch(`/api/favorites/${id}`, { method: 'PATCH', body })
    await refresh()
    editing.value = null
  }
  catch {
    // Keep the existing silent behavior.
  }
  finally {
    saving.value = false
  }
}

function priceAt(fav: FavoriteRecord) {
  return fav.priceAtSend != null ? `R$ ${fav.priceAtSend.toLocaleString('pt-BR')}` : '-'
}

function fipeAt(fav: FavoriteRecord) {
  return fav.fipeAtSend != null ? `R$ ${fav.fipeAtSend.toLocaleString('pt-BR')}` : null
}

function currentPriceStr(fav: FavoriteListRecord) {
  const price = fav.currentVehicle?.price
  return price != null ? `R$ ${price.toLocaleString('pt-BR')}` : null
}

function currentFipeStr(fav: FavoriteListRecord) {
  const fipe = fav.currentVehicle?.fipe
  return fipe != null ? `R$ ${fipe.toLocaleString('pt-BR')}` : null
}

function currentFipePercent(fav: FavoriteListRecord) {
  const price = fav.currentVehicle?.price
  const fipe = fav.currentVehicle?.fipe
  if (price == null || fipe == null || fipe <= 0) return null
  return Math.round((price / fipe) * 100)
}

function priceChanged(fav: FavoriteListRecord) {
  const price = fav.currentVehicle?.price
  return price != null && fav.priceAtSend != null && price !== fav.priceAtSend
}

function soldPriceStr(fav: FavoriteRecord) {
  return fav.soldPrice != null ? `R$ ${fav.soldPrice.toLocaleString('pt-BR')}` : null
}

function sentDateStr(fav: FavoriteRecord) {
  return new Date(fav.sentAt).toLocaleDateString('pt-BR')
}

function fipeVariant(percent: number): 'success' | 'warning' | 'danger' {
  if (percent <= 55) return 'success'
  if (percent <= 75) return 'warning'
  return 'danger'
}
</script>

<template>
  <div>
    <div class="mb-5 flex items-center gap-3.5">
      <h1 class="text-lg font-bold text-body">Favoritos</h1>
      <span class="text-[13px] text-muted">{{ total }} registro(s)</span>
    </div>

    <div v-if="favorites.length === 0" class="px-[60px] py-[60px] text-center text-muted">
      Nenhum veículo enviado ainda.
    </div>

    <div v-else class="overflow-x-auto rounded-card border border-line">
      <table class="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Veículo</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Enviado em</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Lance</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">FIPE</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">% atual</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Vendido por</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">% FIPE venda</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Notas</th>
            <th class="whitespace-nowrap border-b border-line bg-panel px-3.5 py-2.5 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-muted"></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="fav in favorites" :key="fav._id">
            <tr :class="editing === fav._id ? '[&>td]:bg-panel-muted' : 'hover:[&>td]:bg-panel-muted'">
              <td class="border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">
                <div class="flex items-center gap-2.5">
                  <img
                    v-if="fav.imageUrls?.[0]"
                    :src="fav.imageUrls[0]"
                    class="h-[38px] w-[52px] shrink-0 rounded bg-canvas object-cover"
                    :alt="fav.brand"
                  />
                  <div>
                    <a :href="fav.url" target="_blank" class="block text-[13px] font-semibold leading-snug text-body hover:text-accent-soft">
                      {{ fav.brand }} {{ fav.model }}
                    </a>
                    <span class="text-[11px] text-muted">{{ fav.year }}</span>
                  </div>
                </div>
              </td>
              <td class="text-tabular border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">{{ sentDateStr(fav) }}</td>
              <td class="text-tabular border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">
                <div class="flex flex-col gap-0.5">
                  <span>{{ currentPriceStr(fav) ?? priceAt(fav) }}</span>
                  <span class="text-[10.5px] text-muted">
                    envio {{ priceAt(fav) }}
                    <span v-if="priceChanged(fav)" class="text-warning">· mudou</span>
                  </span>
                </div>
              </td>
              <td class="text-tabular border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">
                <div class="flex flex-col gap-0.5">
                  <span>{{ currentFipeStr(fav) ?? fipeAt(fav) ?? '-' }}</span>
                  <span v-if="fipeAt(fav)" class="text-[10.5px] text-muted">envio {{ fipeAt(fav) }}</span>
                </div>
              </td>
              <td class="border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">
                <UiBadge v-if="currentFipePercent(fav) != null" :variant="fipeVariant(currentFipePercent(fav)!)">
                  {{ currentFipePercent(fav) }}%
                </UiBadge>
                <span v-else class="text-disabled">-</span>
              </td>
              <td class="text-tabular border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">{{ soldPriceStr(fav) ?? '-' }}</td>
              <td class="border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">
                <UiBadge v-if="fav.soldFipePercent != null" :variant="fipeVariant(fav.soldFipePercent)">
                  {{ fav.soldFipePercent }}%
                </UiBadge>
                <span v-else class="text-disabled">-</span>
              </td>
              <td class="max-w-[200px] overflow-hidden text-ellipsis whitespace-nowrap border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">{{ fav.notes ?? '' }}</td>
              <td class="border-b border-[#1e2130] px-3.5 py-2.5 align-middle text-soft">
                <UiButton variant="secondary" size="xs" @click="openEdit(fav)">Editar</UiButton>
              </td>
            </tr>

            <tr v-if="editing === fav._id">
              <td colspan="9" class="border-b border-[#1e2130] bg-panel-soft p-0">
                <div class="flex flex-wrap items-end gap-3 px-3.5 py-3.5">
                  <UiField label="Preço vendido (R$)">
                    <UiInput v-model="editForm.soldPrice" type="number" placeholder="ex: 28000" />
                  </UiField>
                  <UiField label="Data de venda">
                    <UiInput v-model="editForm.soldAt" type="date" />
                  </UiField>
                  <UiField label="FIPE na venda (R$)">
                    <UiInput v-model="editForm.soldFipe" type="number" placeholder="ex: 45000" />
                  </UiField>
                  <UiField label="Notas" class="min-w-[200px] flex-1">
                    <UiInput v-model="editForm.notes" type="text" placeholder="observações..." />
                  </UiField>
                  <div class="flex items-end gap-2">
                    <UiButton variant="primary" size="sm" :loading="saving" :disabled="saving" @click="saveEdit(fav._id!)">
                      {{ saving ? 'Salvando...' : 'Salvar' }}
                    </UiButton>
                    <UiButton variant="secondary" size="sm" @click="closeEdit">Cancelar</UiButton>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div v-if="totalPages > 1" class="mt-5 flex items-center justify-center gap-4 text-[13px] text-soft">
      <UiButton variant="secondary" size="sm" :disabled="page === 1" @click="page--">‹ Anterior</UiButton>
      <span>{{ page }} / {{ totalPages }}</span>
      <UiButton variant="secondary" size="sm" :disabled="page === totalPages" @click="page++">Próxima ›</UiButton>
    </div>
  </div>
</template>
