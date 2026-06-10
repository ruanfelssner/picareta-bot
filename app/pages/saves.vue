<script setup lang="ts">
import type { FavoriteRecord } from '#shared/types/vehicle'

const page = ref(1)

const { data, refresh } = await useFetch<{ favorites: FavoriteRecord[]; total: number }>('/api/favorites', {
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
  catch { /* silencioso */ }
  finally {
    saving.value = false
  }
}

function priceAt(fav: FavoriteRecord) {
  return fav.priceAtSend != null ? `R$ ${fav.priceAtSend.toLocaleString('pt-BR')}` : '—'
}

function fipeAt(fav: FavoriteRecord) {
  return fav.fipeAtSend != null ? `R$ ${fav.fipeAtSend.toLocaleString('pt-BR')}` : null
}

function soldPriceStr(fav: FavoriteRecord) {
  return fav.soldPrice != null ? `R$ ${fav.soldPrice.toLocaleString('pt-BR')}` : null
}

function sentDateStr(fav: FavoriteRecord) {
  return new Date(fav.sentAt).toLocaleDateString('pt-BR')
}
</script>

<template>
  <div>
    <div class="page-header">
      <h1 class="page-title">Favoritos</h1>
      <span class="total-label">{{ total }} registro(s)</span>
    </div>

    <div v-if="favorites.length === 0" class="empty">
      Nenhum veículo enviado ainda.
    </div>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Veículo</th>
            <th>Enviado em</th>
            <th>Lance</th>
            <th>FIPE</th>
            <th>% FIPE</th>
            <th>Vendido por</th>
            <th>% FIPE venda</th>
            <th>Notas</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <template v-for="fav in favorites" :key="fav._id">
            <tr :class="{ editing: editing === fav._id }">
              <td>
                <div class="vehicle-cell">
                  <img
                    v-if="fav.imageUrls?.[0]"
                    :src="fav.imageUrls[0]"
                    class="thumb"
                    :alt="fav.brand"
                  />
                  <div>
                    <a :href="fav.url" target="_blank" class="vehicle-name">
                      {{ fav.brand }} {{ fav.model }}
                    </a>
                    <span class="vehicle-year">{{ fav.year }}</span>
                  </div>
                </div>
              </td>
              <td class="mono">{{ sentDateStr(fav) }}</td>
              <td class="mono">{{ priceAt(fav) }}</td>
              <td class="mono">{{ fipeAt(fav) ?? '—' }}</td>
              <td>
                <span
                  v-if="fav.fipePercent != null"
                  class="pct-badge"
                  :class="fav.fipePercent <= 55 ? 'green' : fav.fipePercent <= 75 ? 'yellow' : 'red'"
                >
                  {{ fav.fipePercent }}%
                </span>
                <span v-else class="dim">—</span>
              </td>
              <td class="mono">{{ soldPriceStr(fav) ?? '—' }}</td>
              <td>
                <span
                  v-if="fav.soldFipePercent != null"
                  class="pct-badge"
                  :class="fav.soldFipePercent <= 55 ? 'green' : fav.soldFipePercent <= 75 ? 'yellow' : 'red'"
                >
                  {{ fav.soldFipePercent }}%
                </span>
                <span v-else class="dim">—</span>
              </td>
              <td class="notes-cell">{{ fav.notes ?? '' }}</td>
              <td>
                <button class="btn-edit" @click="openEdit(fav)">Editar</button>
              </td>
            </tr>

            <!-- Linha de edição inline -->
            <tr v-if="editing === fav._id" class="edit-row">
              <td colspan="9">
                <div class="edit-form">
                  <label class="field">
                    <span>Preço vendido (R$)</span>
                    <input v-model="editForm.soldPrice" type="number" placeholder="ex: 28000" />
                  </label>
                  <label class="field">
                    <span>Data de venda</span>
                    <input v-model="editForm.soldAt" type="date" />
                  </label>
                  <label class="field">
                    <span>FIPE na venda (R$)</span>
                    <input v-model="editForm.soldFipe" type="number" placeholder="ex: 45000" />
                  </label>
                  <label class="field field-wide">
                    <span>Notas</span>
                    <input v-model="editForm.notes" type="text" placeholder="observações…" />
                  </label>
                  <div class="edit-actions">
                    <button class="btn-save" :disabled="saving" @click="saveEdit(fav._id!)">
                      {{ saving ? 'Salvando…' : 'Salvar' }}
                    </button>
                    <button class="btn-cancel" @click="closeEdit">Cancelar</button>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <div class="pagination" v-if="totalPages > 1">
      <button :disabled="page === 1" @click="page--">‹ Anterior</button>
      <span>{{ page }} / {{ totalPages }}</span>
      <button :disabled="page === totalPages" @click="page++">Próxima ›</button>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 20px;
}
.page-title { font-size: 18px; font-weight: 700; }
.total-label { font-size: 13px; color: #64748b; }

.empty {
  text-align: center;
  padding: 60px;
  color: #64748b;
}

.table-wrap {
  overflow-x: auto;
  border: 1px solid #2d3148;
  border-radius: 10px;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.table th {
  padding: 10px 14px;
  text-align: left;
  font-size: 11px;
  font-weight: 600;
  color: #64748b;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: #1a1d27;
  border-bottom: 1px solid #2d3148;
  white-space: nowrap;
}
.table td {
  padding: 10px 14px;
  border-bottom: 1px solid #1e2130;
  vertical-align: middle;
  color: #94a3b8;
}
.table tr:last-child td { border-bottom: none; }
.table tr.editing td { background: #161926; }
.table tr:not(.edit-row):hover td { background: #161926; }

.vehicle-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.thumb {
  width: 52px;
  height: 38px;
  object-fit: cover;
  border-radius: 5px;
  background: #0f1117;
  flex-shrink: 0;
}
.vehicle-name {
  font-weight: 600;
  color: #e2e8f0;
  font-size: 13px;
  display: block;
  line-height: 1.3;
}
.vehicle-name:hover { color: #a78bfa; }
.vehicle-year { font-size: 11px; color: #64748b; }

.mono { font-variant-numeric: tabular-nums; }
.dim { color: #2d3148; }
.notes-cell { max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.pct-badge {
  font-size: 12px;
  font-weight: 600;
  padding: 2px 7px;
  border-radius: 4px;
}
.pct-badge.green { background: #14301a; color: #4ade80; }
.pct-badge.yellow { background: #2d2507; color: #facc15; }
.pct-badge.red { background: #2d1010; color: #f87171; }

.btn-edit {
  padding: 4px 12px;
  background: transparent;
  border: 1px solid #2d3148;
  border-radius: 5px;
  color: #64748b;
  font-size: 12px;
  transition: border-color 0.12s, color 0.12s;
}
.btn-edit:hover { border-color: #4a5080; color: #a78bfa; }

.edit-row td { padding: 0; background: #12141e; }
.edit-form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  padding: 14px 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
}
.field-wide { flex: 1; min-width: 200px; }
.field span { font-size: 11px; color: #64748b; font-weight: 500; }
.field input {
  padding: 6px 10px;
  background: #0f1117;
  border: 1px solid #2d3148;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s;
}
.field input:focus { border-color: #4f46e5; }

.edit-actions {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.btn-save {
  padding: 7px 18px;
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 600;
}
.btn-save:hover:not(:disabled) { background: #6366f1; }
.btn-save:disabled { opacity: 0.5; cursor: default; }
.btn-cancel {
  padding: 7px 14px;
  background: transparent;
  border: 1px solid #2d3148;
  border-radius: 6px;
  color: #64748b;
  font-size: 12px;
}
.btn-cancel:hover { border-color: #4a5080; color: #94a3b8; }

.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  margin-top: 20px;
  font-size: 13px;
  color: #94a3b8;
}
.pagination button {
  padding: 6px 14px;
  background: #1a1d27;
  border: 1px solid #2d3148;
  border-radius: 6px;
  color: #94a3b8;
  font-size: 13px;
}
.pagination button:not(:disabled):hover { background: #2d3148; }
.pagination button:disabled { opacity: 0.35; cursor: default; }
</style>
