<script setup lang="ts">
import type { AuctionFilters, AuctionComboRule } from '#shared/types/filters'

const BRAZIL_STATES = [
  'AC','AL','AM','AP','BA','CE','DF','ES','GO','MA',
  'MG','MS','MT','PA','PB','PE','PI','PR','RJ','RN',
  'RO','RR','RS','SC','SE','SP','TO',
]

const { data, refresh } = await useFetch<{ filters: AuctionFilters }>('/api/filters')

const states = ref<string[]>([])
const cities = ref<string[]>([])
const comboRules = ref<AuctionComboRule[]>([])
const cityInput = ref('')
const saving = ref(false)
const saved = ref(false)

watch(
  () => data.value,
  (val) => {
    if (!val) return
    states.value = [...val.filters.states]
    cities.value = [...val.filters.cities]
    comboRules.value = val.filters.comboRules.map(r => ({ ...r }))
  },
  { immediate: true },
)

function toggleState(code: string) {
  const idx = states.value.indexOf(code)
  if (idx === -1) states.value.push(code)
  else states.value.splice(idx, 1)
}

function addCity() {
  const val = cityInput.value.trim()
  if (val && !cities.value.includes(val)) cities.value.push(val)
  cityInput.value = ''
}

function removeCity(city: string) {
  cities.value = cities.value.filter(c => c !== city)
}

function addRule() {
  comboRules.value.push({
    id: crypto.randomUUID(),
    enabled: true,
    mode: 'include',
    brand: null,
    model: null,
    text: null,
    minYear: null,
  })
}

function removeRule(id: string) {
  comboRules.value = comboRules.value.filter(r => r.id !== id)
}

async function save() {
  saving.value = true
  saved.value = false
  try {
    await $fetch('/api/filters', {
      method: 'PUT',
      body: {
        states: states.value,
        cities: cities.value,
        comboRules: comboRules.value,
      },
    })
    await refresh()
    saved.value = true
    setTimeout(() => { saved.value = false }, 2500)
  }
  catch { /* silencioso */ }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="filters-page">
    <div class="page-header">
      <h1 class="page-title">Filtros</h1>
      <button class="btn-save" :disabled="saving" @click="save">
        {{ saving ? 'Salvando…' : 'Salvar filtros' }}
      </button>
      <span v-if="saved" class="saved-msg">✓ Salvo</span>
    </div>

    <!-- Estados -->
    <section class="section">
      <h2 class="section-title">Estados</h2>
      <p class="section-desc">Deixe vazio para aceitar veículos de qualquer estado.</p>
      <div class="state-grid">
        <button
          v-for="uf in BRAZIL_STATES"
          :key="uf"
          class="state-btn"
          :class="{ active: states.includes(uf) }"
          @click="toggleState(uf)"
        >
          {{ uf }}
        </button>
      </div>
    </section>

    <!-- Cidades -->
    <section class="section">
      <h2 class="section-title">Cidades</h2>
      <p class="section-desc">Filtra veículos pelo campo "pátio/localidade". Deixe vazio para aceitar todas.</p>
      <div class="city-input-row">
        <input
          v-model="cityInput"
          placeholder="ex: Curitiba"
          class="text-input"
          @keydown.enter.prevent="addCity"
        />
        <button class="btn-add" @click="addCity">Adicionar</button>
      </div>
      <div class="tags">
        <span v-for="city in cities" :key="city" class="tag">
          {{ city }}
          <button class="tag-remove" @click="removeCity(city)">✕</button>
        </span>
        <span v-if="cities.length === 0" class="dim">Nenhuma cidade cadastrada</span>
      </div>
    </section>

    <!-- Regras de combo (brand/model) -->
    <section class="section">
      <h2 class="section-title">Regras de veículo</h2>
      <p class="section-desc">
        Inclui ou exclui veículos por marca, modelo, texto no título ou ano mínimo.
        As regras são avaliadas em ordem — a primeira que casar decide.
      </p>

      <div class="rules-list">
        <div v-for="rule in comboRules" :key="rule.id" class="rule-card">
          <div class="rule-row">
            <select v-model="rule.mode" class="select-sm">
              <option value="include">Incluir</option>
              <option value="exclude">Excluir</option>
            </select>

            <label class="rule-toggle">
              <input v-model="rule.enabled" type="checkbox" />
              <span>Ativa</span>
            </label>

            <button class="btn-remove-rule" @click="removeRule(rule.id)">✕</button>
          </div>

          <div class="rule-fields">
            <label class="field">
              <span>Marca</span>
              <input
                :value="rule.brand ?? ''"
                placeholder="ex: VOLKSWAGEN"
                class="text-input-sm"
                @input="rule.brand = ($event.target as HTMLInputElement).value.toUpperCase() || null"
              />
            </label>
            <label class="field">
              <span>Modelo</span>
              <input
                :value="rule.model ?? ''"
                placeholder="ex: GOL"
                class="text-input-sm"
                @input="rule.model = ($event.target as HTMLInputElement).value.toUpperCase() || null"
              />
            </label>
            <label class="field">
              <span>Texto</span>
              <input
                :value="rule.text ?? ''"
                placeholder="qualquer trecho"
                class="text-input-sm"
                @input="rule.text = ($event.target as HTMLInputElement).value || null"
              />
            </label>
            <label class="field">
              <span>Ano mínimo</span>
              <input
                :value="rule.minYear ?? ''"
                type="number"
                placeholder="ex: 2015"
                class="text-input-sm"
                @input="rule.minYear = Number(($event.target as HTMLInputElement).value) || null"
              />
            </label>
          </div>
        </div>

        <button class="btn-add-rule" @click="addRule">+ Nova regra</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.filters-page { max-width: 800px; }

.page-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 24px;
}
.page-title { font-size: 18px; font-weight: 700; }
.saved-msg { font-size: 13px; color: #4ade80; font-weight: 500; }

.btn-save {
  padding: 8px 20px;
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 7px;
  font-weight: 600;
  font-size: 13px;
}
.btn-save:hover:not(:disabled) { background: #6366f1; }
.btn-save:disabled { opacity: 0.5; cursor: default; }

.section {
  background: #1a1d27;
  border: 1px solid #2d3148;
  border-radius: 10px;
  padding: 18px 20px;
  margin-bottom: 16px;
}
.section-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.section-desc { font-size: 12px; color: #64748b; margin-bottom: 14px; }

.state-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.state-btn {
  width: 44px;
  padding: 5px 0;
  border-radius: 5px;
  border: 1px solid #2d3148;
  background: transparent;
  color: #64748b;
  font-size: 12px;
  font-weight: 600;
  text-align: center;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.state-btn:hover { border-color: #4a5080; color: #94a3b8; }
.state-btn.active { background: #2d3148; color: #a78bfa; border-color: #4f46e5; }

.city-input-row { display: flex; gap: 8px; margin-bottom: 10px; }
.text-input {
  flex: 1;
  padding: 7px 12px;
  background: #0f1117;
  border: 1px solid #2d3148;
  border-radius: 6px;
  color: #e2e8f0;
  font-size: 13px;
  outline: none;
}
.text-input:focus { border-color: #4f46e5; }

.btn-add {
  padding: 7px 16px;
  background: #2d3148;
  border: 1px solid #4a5080;
  border-radius: 6px;
  color: #a78bfa;
  font-size: 13px;
  font-weight: 500;
}
.btn-add:hover { background: #363c5a; }

.tags { display: flex; flex-wrap: wrap; gap: 6px; }
.tag {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: #2d3148;
  border-radius: 5px;
  font-size: 12px;
  color: #a78bfa;
}
.tag-remove {
  background: none;
  border: none;
  color: #64748b;
  font-size: 11px;
  line-height: 1;
  padding: 0;
}
.tag-remove:hover { color: #f87171; }
.dim { font-size: 12px; color: #2d3148; }

.rules-list { display: flex; flex-direction: column; gap: 10px; }

.rule-card {
  background: #12141e;
  border: 1px solid #2d3148;
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rule-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.select-sm {
  padding: 5px 10px;
  background: #0f1117;
  border: 1px solid #2d3148;
  border-radius: 5px;
  color: #e2e8f0;
  font-size: 12px;
  outline: none;
}
.select-sm:focus { border-color: #4f46e5; }
.rule-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #64748b;
  cursor: pointer;
}
.rule-toggle input { accent-color: #4f46e5; }
.btn-remove-rule {
  margin-left: auto;
  background: none;
  border: none;
  color: #64748b;
  font-size: 13px;
  padding: 2px 6px;
}
.btn-remove-rule:hover { color: #f87171; }

.rule-fields {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 140px;
}
.field span { font-size: 11px; color: #64748b; font-weight: 500; }
.text-input-sm {
  padding: 5px 10px;
  background: #0f1117;
  border: 1px solid #2d3148;
  border-radius: 5px;
  color: #e2e8f0;
  font-size: 12px;
  outline: none;
  width: 100%;
}
.text-input-sm:focus { border-color: #4f46e5; }

.btn-add-rule {
  align-self: flex-start;
  padding: 7px 16px;
  background: transparent;
  border: 1px dashed #2d3148;
  border-radius: 6px;
  color: #64748b;
  font-size: 12px;
  transition: border-color 0.12s, color 0.12s;
}
.btn-add-rule:hover { border-color: #4f46e5; color: #a78bfa; }
</style>
