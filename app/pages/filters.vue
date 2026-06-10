<script setup lang="ts">
import type { AuctionComboRule, AuctionFilters } from '#shared/types/filters'

const BRAZIL_STATES = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
  'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
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
  (value) => {
    if (!value) return
    states.value = [...value.filters.states]
    cities.value = [...value.filters.cities]
    comboRules.value = value.filters.comboRules.map(rule => ({ ...rule }))
  },
  { immediate: true },
)

function toNullableNumber(value: string | number | null | undefined): number | null {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function toggleState(code: string) {
  states.value = states.value.includes(code)
    ? states.value.filter(state => state !== code)
    : [...states.value, code]
}

function addCity() {
  const value = cityInput.value.trim()
  if (value && !cities.value.includes(value)) cities.value.push(value)
  cityInput.value = ''
}

function removeCity(city: string) {
  cities.value = cities.value.filter(item => item !== city)
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
  comboRules.value = comboRules.value.filter(rule => rule.id !== id)
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
  catch {
    // Keep the existing silent behavior.
  }
  finally {
    saving.value = false
  }
}
</script>

<template>
  <UiContainer size="narrow">
    <div class="mb-6 flex items-center gap-3.5">
      <h1 class="text-lg font-bold text-body">Filtros</h1>
      <UiButton variant="primary" size="md" :loading="saving" :disabled="saving" @click="save">
        {{ saving ? 'Salvando...' : 'Salvar filtros' }}
      </UiButton>
      <span v-if="saved" class="text-[13px] font-medium text-success">Salvo</span>
    </div>

    <div class="flex flex-col gap-4">
      <UiCard class="px-5 py-[18px]">
        <h2 class="mb-1 text-sm font-semibold text-body">Estados</h2>
        <p class="mb-3.5 text-xs text-muted">Deixe vazio para aceitar veículos de qualquer estado.</p>
        <div class="flex flex-wrap gap-1.5">
          <UiChip
            v-for="uf in BRAZIL_STATES"
            :key="uf"
            class="w-11 justify-center"
            :active="states.includes(uf)"
            @click="toggleState(uf)"
          >
            {{ uf }}
          </UiChip>
        </div>
      </UiCard>

      <UiCard class="px-5 py-[18px]">
        <h2 class="mb-1 text-sm font-semibold text-body">Cidades</h2>
        <p class="mb-3.5 text-xs text-muted">Filtra veículos pelo campo "pátio/localidade". Deixe vazio para aceitar todas.</p>
        <div class="mb-2.5 flex gap-2">
          <UiInput v-model="cityInput" placeholder="ex: Curitiba" @keydown.enter.prevent="addCity" />
          <UiButton variant="secondary" size="md" @click="addCity">Adicionar</UiButton>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="city in cities" :key="city" class="flex items-center gap-1.5 rounded bg-line px-2.5 py-1 text-xs text-accent-soft">
            {{ city }}
            <button class="p-0 text-[11px] leading-none text-muted hover:text-danger" @click="removeCity(city)">x</button>
          </span>
          <span v-if="cities.length === 0" class="text-xs text-disabled">Nenhuma cidade cadastrada</span>
        </div>
      </UiCard>

      <UiCard class="px-5 py-[18px]">
        <h2 class="mb-1 text-sm font-semibold text-body">Regras de veículo</h2>
        <p class="mb-3.5 text-xs text-muted">
          Inclui ou exclui veículos por marca, modelo, texto no título ou ano mínimo.
          As regras são avaliadas em ordem - a primeira que casar decide.
        </p>

        <div class="flex flex-col gap-2.5">
          <div v-for="rule in comboRules" :key="rule.id" class="flex flex-col gap-2.5 rounded-lg border border-line bg-panel-soft px-3.5 py-3">
            <div class="flex items-center gap-2.5">
              <UiSelect v-model="rule.mode" size="sm">
                <option value="include">Incluir</option>
                <option value="exclude">Excluir</option>
              </UiSelect>

              <label class="flex cursor-pointer items-center gap-1.5 text-xs text-muted">
                <UiSwitch v-model="rule.enabled" />
                <span>Ativa</span>
              </label>

              <UiButton class="ml-auto" variant="danger" size="xs" @click="removeRule(rule.id)">
                Remover
              </UiButton>
            </div>

            <div class="flex flex-wrap gap-2.5">
              <UiField label="Marca">
                <UiInput
                  :model-value="rule.brand ?? ''"
                  size="sm"
                  placeholder="ex: VOLKSWAGEN"
                  @update:model-value="rule.brand = String($event ?? '').toUpperCase() || null"
                />
              </UiField>
              <UiField label="Modelo">
                <UiInput
                  :model-value="rule.model ?? ''"
                  size="sm"
                  placeholder="ex: GOL"
                  @update:model-value="rule.model = String($event ?? '').toUpperCase() || null"
                />
              </UiField>
              <UiField label="Texto">
                <UiInput
                  :model-value="rule.text ?? ''"
                  size="sm"
                  placeholder="qualquer trecho"
                  @update:model-value="rule.text = String($event ?? '') || null"
                />
              </UiField>
              <UiField label="Ano mínimo">
                <UiInput
                  :model-value="rule.minYear ?? ''"
                  size="sm"
                  type="number"
                  placeholder="ex: 2015"
                  @update:model-value="rule.minYear = toNullableNumber($event)"
                />
              </UiField>
            </div>
          </div>

          <UiButton class="self-start" variant="dashed" size="sm" @click="addRule">
            + Nova regra
          </UiButton>
        </div>
      </UiCard>
    </div>
  </UiContainer>
</template>
