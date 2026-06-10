<script setup lang="ts">
import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import type { AuctionFilters, AuctionComboRule } from '#shared/types/filters'

const ALL_SOURCES: { id: VehicleSource; label: string }[] = [
  { id: 'vs-veiculos', label: 'VS Veículos' },
  { id: 'sodre', label: 'Sodre' },
  { id: 'copart', label: 'Copart' },
  { id: 'favareto', label: 'Favareto' },
  { id: 'megaleiloes', label: 'MegaLeilões' },
  { id: 'lucinei', label: 'Lucinei' },
  { id: 'vardana', label: 'Vardana' },
  { id: 'claudio-kuss', label: 'C. Kuss' },
  { id: 'superbid', label: 'Superbid' },
  { id: 'leiloesjudiciais', label: 'Judiciais' },
  { id: 'vipleiloes', label: 'VIP' },
  { id: 'mgl', label: 'MGL' },
]

const BRAZIL_STATES = [
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA',
  'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN',
  'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
]

const SORT_OPTIONS = [
  { value: 'recent',     label: 'Mais recentes' },
  { value: 'price_asc',  label: 'Menor preço'   },
  { value: 'price_desc', label: 'Maior preço'   },
  { value: 'year_desc',  label: 'Mais novos'    },
  { value: 'fipe_asc',   label: 'Melhor FIPE'   },
]

// ── UI ──
const sidebarOpen = ref(true)
const activeTab    = ref<'display' | 'scraping'>('display')

// ── Filtros de exibição ──
const displaySources = ref<VehicleSource[]>([])
const search         = ref('')
const minPrice       = ref<number | null>(null)
const maxPrice       = ref<number | null>(null)
const minYear        = ref<number | null>(null)
const maxYear        = ref<number | null>(null)
const hasFipeOnly    = ref(false)
const maxFipePct     = ref<number | null>(null)
const sort           = ref('recent')
const page           = ref(1)
const comboRules     = ref<AuctionComboRule[]>([])
const rulesEnabled   = ref(true)

// ── Config de scraping (persistida no DB) ──
const scrapeSources  = ref<VehicleSource[]>([])
const states         = ref<string[]>([])
const cities         = ref<string[]>([])
const cityInput      = ref('')
const scrapingDirty  = ref(false)
const savingConfig   = ref(false)
const savedConfig    = ref(false)

// ── Modal de regras de exibição ──
const showRulesModal = ref(false)
const draftRules     = ref<AuctionComboRule[]>([])
const savingRules    = ref(false)

function openRulesModal() {
  draftRules.value = comboRules.value.map(r => ({ ...r }))
  showRulesModal.value = true
}
function addDraftRule() {
  draftRules.value.push({ id: crypto.randomUUID(), enabled: true, mode: 'include', brand: null, model: null, text: null, minYear: null })
}
function removeDraftRule(id: string) {
  draftRules.value = draftRules.value.filter(r => r.id !== id)
}
async function applyRules() {
  savingRules.value = true
  try {
    await $fetch('/api/filters', {
      method: 'PUT',
      body: { states: states.value, cities: cities.value, comboRules: draftRules.value },
    })
    comboRules.value = draftRules.value.map(r => ({ ...r }))
    showRulesModal.value = false
  }
  catch { /* silencioso */ }
  finally { savingRules.value = false }
}

// ── Sessão de scrape ──
const isScraping  = ref(false)
const scrapeLog   = ref<string[]>([])
const showLog     = ref(false)
const scrapeResult = ref<{ total: number; inserted: number; skipped: number; errors: Record<string, string> } | null>(null)

// ── Query da API de veículos ──
const query = computed(() => {
  const q: Record<string, unknown> = { page: page.value, limit: 50, sort: sort.value }
  if (displaySources.value.length > 0) q['sources'] = displaySources.value.join(',')
  if (search.value.trim())             q['search']   = search.value.trim()
  if (minPrice.value  != null)         q['minPrice']  = minPrice.value
  if (maxPrice.value  != null)         q['maxPrice']  = maxPrice.value
  if (minYear.value   != null)         q['minYear']   = minYear.value
  if (maxYear.value   != null)         q['maxYear']   = maxYear.value
  if (hasFipeOnly.value)               q['hasFipe']   = 'true'
  if (maxFipePct.value != null)        q['maxFipePct'] = maxFipePct.value
  return q
})

const { data, refresh } = await useFetch<{ vehicles: VehicleRecord[]; total: number }>('/api/vehicles', { query })

// Regras aplicadas client-side
const vehicles = computed(() => {
  const all = data.value?.vehicles ?? []
  if (!rulesEnabled.value) return all
  const rules = comboRules.value.filter(r => r.enabled)
  if (!rules.length) return all
  return all.filter(v => {
    for (const rule of rules) {
      const b = v.brand?.toUpperCase() ?? ''
      const m = v.model?.toUpperCase() ?? ''
      const t = v.title?.toUpperCase() ?? ''
      const ok = (!rule.brand   || b.includes(rule.brand.toUpperCase()))
              && (!rule.model   || m.includes(rule.model.toUpperCase()))
              && (!rule.text    || t.includes(rule.text.toUpperCase()))
              && (!rule.minYear || (v.year != null && v.year >= rule.minYear))
      if (ok) return rule.mode === 'include'
    }
    return true
  })
})

const total      = computed(() => data.value?.total ?? 0)
const totalPages = computed(() => Math.ceil(total.value / 50))

watch([search, minPrice, maxPrice, minYear, maxYear, hasFipeOnly, maxFipePct, displaySources, sort], () => { page.value = 1 })

// ── Contagens por fonte / estado ──
const { data: countsData, refresh: refreshCounts } = await useFetch<{
  bySrc: Record<string, number>; byState: Record<string, number>
}>('/api/vehicles/counts')
const srcCount   = (id: string) => countsData.value?.bySrc[id]   ?? 0
const stateCount = (uf: string) => countsData.value?.byState[uf] ?? 0

// ── Carregar config salva no DB ──
const { data: filtersData } = await useFetch<{ filters: AuctionFilters }>('/api/filters')
watch(() => filtersData.value, val => {
  if (!val) return
  states.value     = [...val.filters.states]
  cities.value     = [...val.filters.cities]
  comboRules.value = (val.filters.comboRules ?? []).map(r => ({ ...r }))
}, { immediate: true })

// Contagem de filtros de exibição ativos (para o badge no botão)
const activeDisplayFilters = computed(() => {
  let n = 0
  if (displaySources.value.length > 0) n++
  if (search.value.trim())              n++
  if (minPrice.value != null || maxPrice.value != null) n++
  if (minYear.value  != null || maxYear.value  != null) n++
  if (hasFipeOnly.value || maxFipePct.value != null)    n++
  if (rulesEnabled.value && comboRules.value.some(r => r.enabled)) n++
  return n
})

// ── Ações config de scraping ──
function markDirty() { scrapingDirty.value = true }

function toggleState(uf: string) {
  const i = states.value.indexOf(uf)
  if (i === -1) states.value.push(uf); else states.value.splice(i, 1)
  markDirty()
}

function addCity() {
  const v = cityInput.value.trim()
  if (v && !cities.value.includes(v)) { cities.value.push(v); markDirty() }
  cityInput.value = ''
}

function removeCity(city: string) {
  cities.value = cities.value.filter(c => c !== city)
  markDirty()
}

async function saveConfig() {
  savingConfig.value = true
  try {
    await $fetch('/api/filters', {
      method: 'PUT',
      body: { states: states.value, cities: cities.value, comboRules: comboRules.value },
    })
    scrapingDirty.value = false
    savedConfig.value   = true
    setTimeout(() => { savedConfig.value = false }, 2500)
  }
  catch { /* silencioso */ }
  finally { savingConfig.value = false }
}

// ── Scrape ──
async function startScrape() {
  if (isScraping.value) return
  isScraping.value  = true
  scrapeLog.value   = []
  scrapeResult.value = null
  showLog.value     = true

  try {
    const body = scrapeSources.value.length > 0
      ? JSON.stringify({ sources: scrapeSources.value })
      : '{}'

    const response = await fetch('/api/vehicles/scrape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    if (!response.body) return

    const reader  = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = '', currentEvent = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const t = line.trim()
        if (t.startsWith('event: ')) { currentEvent = t.slice(7) }
        else if (t.startsWith('data: ')) {
          try {
            const p = JSON.parse(t.slice(6))
            if      (currentEvent === 'vehicle') {
              const price = p.price != null ? ` · R$ ${p.price.toLocaleString('pt-BR')}` : ''
              scrapeLog.value.push(`✓ ${p.brand} ${p.model} ${p.year ?? ''}${price}`)
            }
            else if (currentEvent === 'log')   scrapeLog.value.push(p.message)
            else if (currentEvent === 'done') {
              scrapeResult.value = p
              await refresh()
              await refreshCounts()
            }
            else if (currentEvent === 'error') scrapeLog.value.push(`⚠ ${p.message}`)
          }
          catch { /* ignorar */ }
          currentEvent = ''
        }
      }
    }
  }
  catch (err) {
    scrapeLog.value.push(`⚠ Erro: ${err instanceof Error ? err.message : String(err)}`)
  }
  finally { isScraping.value = false }
}
</script>

<template>
  <div class="cars-page">
    <!-- ─── Layout ─── -->
    <div class="layout">
      <!-- Sidebar -->
      <Transition name="slide-left">
        <aside v-if="sidebarOpen" class="sidebar">

          <!-- Tabs -->
          <div class="tab-bar">
            
            <button class="tab" :class="{ active: activeTab === 'display' }" @click="activeTab = 'display'">
              Exibição
              <span v-if="activeDisplayFilters > 0" class="tab-badge">{{ activeDisplayFilters }}</span>
            </button>
            <button class="tab" :class="{ active: activeTab === 'scraping' }" @click="activeTab = 'scraping'">
              Scraping
              <span v-if="scrapingDirty" class="dot-warn" />
            </button>
          </div>

          <div class="sidebar-body">

            <!-- ══════════════ ABA: EXIBIÇÃO ══════════════ -->
            <template v-if="activeTab === 'display'">

              <!-- Fontes -->
              <div class="block">
                <div class="block-label">
                  Fontes
                  <button v-if="displaySources.length > 0" class="lnk-clear" @click="displaySources = []">limpar</button>
                </div>
                <div class="chips">
                  <button class="chip" :class="{ active: displaySources.length === 0 }" @click="displaySources = []">
                    Todas
                  </button>
                  <button
                    v-for="s in ALL_SOURCES" :key="s.id"
                    class="chip"
                    :class="{ active: displaySources.includes(s.id) }"
                    @click="displaySources.includes(s.id)
                      ? displaySources = displaySources.filter(x => x !== s.id)
                      : displaySources.push(s.id)"
                  >
                    {{ s.label }}
                    <span v-if="srcCount(s.id) > 0" class="chip-count">{{ srcCount(s.id) }}</span>
                  </button>
                </div>
              </div>

              <!-- Buscar -->
              <div class="block">
                <div class="block-label">Buscar</div>
                <input v-model="search" type="text" placeholder="Marca ou modelo…" class="fi" />
              </div>

              <!-- Preço -->
              <div class="block">
                <div class="block-label">Preço (R$)</div>
                <div class="range-row">
                  <input v-model.number="minPrice" type="number" placeholder="Mín" class="fi fi-h" />
                  <span class="sep">–</span>
                  <input v-model.number="maxPrice" type="number" placeholder="Máx" class="fi fi-h" />
                </div>
              </div>

              <!-- Ano -->
              <div class="block">
                <div class="block-label">Ano</div>
                <div class="range-row">
                  <input v-model.number="minYear" type="number" placeholder="2000" class="fi fi-h" />
                  <span class="sep">–</span>
                  <input v-model.number="maxYear" type="number" placeholder="2025" class="fi fi-h" />
                </div>
              </div>

              <!-- FIPE -->
              <div class="block">
                <div class="block-label">FIPE</div>
                <label class="toggle-row">
                  <input v-model="hasFipeOnly" type="checkbox" />
                  <span>Apenas com FIPE</span>
                </label>
                <div v-if="hasFipeOnly" class="range-row mt6">
                  <span class="sep">Máx %</span>
                  <input v-model.number="maxFipePct" type="number" placeholder="75" class="fi fi-h" />
                </div>
              </div>

              <!-- Ordenar -->
              <div class="block">
                <div class="block-label">Ordenar</div>
                <div class="sort-list">
                  <button
                    v-for="opt in SORT_OPTIONS" :key="opt.value"
                    class="sort-btn" :class="{ active: sort === opt.value }"
                    @click="sort = opt.value"
                  >{{ opt.label }}</button>
                </div>
                <p class="hint">★ Favoritos sempre primeiro.</p>
              </div>

              <!-- Regras de exibição -->
              <div class="block">
                <div class="block-label">
                  Regras de exibição
                  <label class="rules-toggle" :title="rulesEnabled ? 'Desativar todas as regras' : 'Ativar regras'">
                    <input v-model="rulesEnabled" type="checkbox" />
                    <span class="rules-toggle-track" :class="{ on: rulesEnabled }" />
                  </label>
                </div>
                <button
                  class="btn-open-rules"
                  :class="{ muted: !rulesEnabled }"
                  @click="openRulesModal"
                >
                  ⚡ Gerenciar regras
                  <span v-if="comboRules.some(r => r.enabled)" class="badge badge-sm">
                    {{ comboRules.filter(r => r.enabled).length }}
                  </span>
                </button>
                <p class="hint">
                  {{ rulesEnabled ? 'Inclui/exclui por marca, modelo, texto ou ano.' : 'Regras desativadas — exibindo todos.' }}
                </p>
              </div>

              <!-- Limpar tudo -->
              <div v-if="activeDisplayFilters > 0" class="block">
                <button class="btn-clear-all"
                  @click="displaySources = []; search = ''; minPrice = null; maxPrice = null;
                          minYear = null; maxYear = null; hasFipeOnly = false; maxFipePct = null; sort = 'recent'"
                >Limpar todos os filtros</button>
              </div>

            </template>

            <!-- ══════════════ ABA: SCRAPING ══════════════ -->
            <template v-else>

              <!-- Fontes a scrapar -->
              <div class="block">
                <div class="block-label">
                  Fontes a scrapar
                  <button v-if="scrapeSources.length > 0" class="lnk-clear" @click="scrapeSources = []">todas</button>
                </div>
                <p class="hint">Vazio = roda todos os scrapers.</p>
                <div class="chips mt6">
                  <button
                    v-for="s in ALL_SOURCES" :key="s.id"
                    class="chip"
                    :class="{ active: scrapeSources.includes(s.id) }"
                    @click="scrapeSources.includes(s.id)
                      ? scrapeSources = scrapeSources.filter(x => x !== s.id)
                      : scrapeSources.push(s.id)"
                  >
                    {{ s.label }}
                    <span v-if="srcCount(s.id) > 0" class="chip-count">{{ srcCount(s.id) }}</span>
                  </button>
                </div>
              </div>

              <!-- Estados aceitos -->
              <div class="block">
                <div class="block-label">
                  Estados aceitos
                  <span class="lbl-hint">vazio = todos</span>
                </div>
                <div class="state-grid">
                  <button
                    v-for="uf in BRAZIL_STATES" :key="uf"
                    class="state-chip" :class="{ active: states.includes(uf) }"
                    @click="toggleState(uf)"
                  >
                    {{ uf }}
                    <span v-if="stateCount(uf) > 0" class="state-count">{{ stateCount(uf) }}</span>
                  </button>
                </div>
              </div>

              <!-- Cidades aceitas -->
              <div class="block">
                <div class="block-label">Cidades aceitas</div>
                <div class="city-row">
                  <input v-model="cityInput" placeholder="ex: Curitiba" class="fi" @keydown.enter.prevent="addCity" />
                  <button class="btn-add-tag" @click="addCity">+</button>
                </div>
                <div class="tags">
                  <span v-for="c in cities" :key="c" class="tag">
                    {{ c }}<button class="tag-x" @click="removeCity(c)">✕</button>
                  </span>
                  <span v-if="!cities.length" class="hint-empty">nenhuma</span>
                </div>
              </div>

              <!-- Salvar config -->
              <div class="save-row">
                <button class="btn-save" :disabled="savingConfig || !scrapingDirty" @click="saveConfig">
                  {{ savingConfig ? 'Salvando…' : 'Salvar configuração' }}
                </button>
                <Transition name="fade">
                  <span v-if="savedConfig" class="saved-ok">✓</span>
                </Transition>
              </div>

              <!-- Scrapar agora -->
              <div class="scrape-section">
                <button class="btn-scrape" :disabled="isScraping" @click="startScrape">
                  <span v-if="isScraping" class="spinner" />
                  {{ isScraping ? 'Scraping…' : 'Scrapar agora' }}
                </button>
              </div>

            </template>
          </div>
        </aside>
      </Transition>

      <!-- Grade de veículos -->
      <main class="main">

        <div v-if="vehicles.length > 0" class="grid">
          <VehicleCard v-for="v in vehicles" :key="v._id" :vehicle="v" @sent="refresh()" />
        </div>
        <div v-else class="empty">Nenhum veículo. Ajuste os filtros ou execute um scraping.</div>
        
        <div v-if="totalPages > 1" class="pagination">
          <button :disabled="page === 1"         @click="page--">‹</button>
          <span>{{ page }} / {{ totalPages }}</span>
          <button :disabled="page === totalPages" @click="page++">›</button>
        </div>
      </main>
    </div>

    <!-- ─── Log do scrape (rodapé) ─── -->
    <Transition name="slide-up">
      <div v-if="showLog" class="log-panel">
        <div class="log-header">
          <span class="log-title">Log do scrape</span>
          <div class="log-meta">
            <span v-if="scrapeResult" class="log-result">
              {{ scrapeResult.inserted }} novo{{ scrapeResult.inserted !== 1 ? 's' : '' }} ·
              {{ scrapeResult.skipped }} filtrado{{ scrapeResult.skipped !== 1 ? 's' : '' }}
            </span>
            <button class="icon-btn" @click="showLog = false">✕</button>
          </div>
        </div>
        <div class="log-body">
          <div v-for="(line, i) in scrapeLog" :key="i" class="log-line">{{ line }}</div>
          <div v-if="isScraping" class="log-line log-cursor">▌</div>
        </div>
      </div>
    </Transition>

    <!-- ══════════════════════════════════════
         MODAL: Regras de Exibição
    ══════════════════════════════════════ -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showRulesModal" class="modal-overlay" @click.self="showRulesModal = false">
          <div class="modal">
            <div class="modal-header">
              <div>
                <div class="modal-title">Regras de Exibição</div>
                <div class="modal-sub">Primeira regra que casar decide. Veículos sem correspondência são exibidos.</div>
              </div>
              <button class="icon-btn" @click="showRulesModal = false">✕</button>
            </div>

            <div class="modal-body">
              <div v-if="!draftRules.length" class="rules-empty">
                Nenhuma regra. Use "Nova regra" abaixo para começar.
              </div>
              <div v-else class="rules-list">
                <div
                  v-for="(rule, idx) in draftRules" :key="rule.id"
                  class="rule-card" :class="{ disabled: !rule.enabled }"
                >
                  <div class="rule-head">
                    <span class="rule-n">#{{ idx + 1 }}</span>
                    <div class="mode-toggle">
                      <button class="mode-btn" :class="{ active: rule.mode === 'include' }" @click="rule.mode = 'include'">Incluir</button>
                      <button class="mode-btn mode-red" :class="{ active: rule.mode === 'exclude' }" @click="rule.mode = 'exclude'">Excluir</button>
                    </div>
                    <label class="rule-active">
                      <input v-model="rule.enabled" type="checkbox" />
                      <span>Ativa</span>
                    </label>
                    <button class="btn-del-rule" @click="removeDraftRule(rule.id)">Remover</button>
                  </div>
                  <div class="rule-fields">
                    <label class="rf">
                      <span>Marca</span>
                      <input :value="rule.brand ?? ''" placeholder="VOLKSWAGEN" class="fi"
                        @input="rule.brand = ($event.target as HTMLInputElement).value.toUpperCase() || null" />
                    </label>
                    <label class="rf">
                      <span>Modelo</span>
                      <input :value="rule.model ?? ''" placeholder="GOL" class="fi"
                        @input="rule.model = ($event.target as HTMLInputElement).value.toUpperCase() || null" />
                    </label>
                    <label class="rf">
                      <span>Texto no título</span>
                      <input :value="rule.text ?? ''" placeholder="qualquer trecho" class="fi"
                        @input="rule.text = ($event.target as HTMLInputElement).value || null" />
                    </label>
                    <label class="rf rf-sm">
                      <span>Ano mín</span>
                      <input :value="rule.minYear ?? ''" type="number" placeholder="2015" class="fi"
                        @input="rule.minYear = Number(($event.target as HTMLInputElement).value) || null" />
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div class="modal-footer">
              <button class="btn-add-rule" @click="addDraftRule">+ Nova regra</button>
              <div class="modal-actions">
                <button class="btn-cancel" @click="showRulesModal = false">Cancelar</button>
                <button class="btn-apply" :disabled="savingRules" @click="applyRules">
                  {{ savingRules ? 'Salvando…' : 'Aplicar' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

  </div>
</template>

<style scoped>
.cars-page { display: flex; flex-direction: column; gap: 12px; }

/* ── Top bar ── */
.top-bar { display: flex; align-items: center; gap: 10px; }

.btn-toggle {
  display: flex; align-items: center; gap: 7px;
  padding: 7px 14px;
  background: #1a1d27; border: 1px solid #2d3148; border-radius: 7px;
  color: #64748b; font-size: 13px; font-weight: 500; cursor: pointer;
  transition: background .12s, border-color .12s, color .12s; white-space: nowrap;
}
.btn-toggle:hover  { background: #242736; color: #94a3b8; border-color: #3d4266; }
.btn-toggle.active { background: #1e2038; border-color: #4f46e5; color: #a78bfa; }

.badge {
  min-width: 18px; height: 18px; padding: 0 5px;
  background: #4f46e5; color: #fff; border-radius: 9px;
  font-size: 10px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.badge-sm {
  min-width: 16px; height: 16px; padding: 0 4px;
  background: #4f46e5; color: #fff; border-radius: 8px;
  font-size: 9px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}

.total-label { flex: 1; font-size: 13px; color: #4a5080; text-align: center; }

/* ── Layout ── */
.layout { display: flex; gap: 14px; align-items: flex-start; }

/* ── Sidebar ── */
.sidebar {
  width: 264px; flex-shrink: 0;
  background: #1a1d27; border: 1px solid #2d3148; border-radius: 10px;
  overflow: hidden; position: sticky; top: 64px;
  max-height: calc(100vh - 80px); display: flex; flex-direction: column;
}

/* Tabs */
.tab-bar { display: flex; border-bottom: 1px solid #2d3148; flex-shrink: 0; }
.tab {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px;
  padding: 9px 12px; background: transparent; border: none;
  color: #4a5080; font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background .12s, color .12s;
  border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.tab:hover  { color: #94a3b8; background: #1f2333; }
.tab.active { color: #a78bfa; border-bottom-color: #4f46e5; }
.tab-badge {
  min-width: 16px; height: 16px; padding: 0 4px;
  background: #4f46e5; color: #fff; border-radius: 8px;
  font-size: 9px; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center;
}
.dot-warn {
  width: 7px; height: 7px; background: #f59e0b; border-radius: 50%; display: inline-block;
}

/* Body */
.sidebar-body {
  flex: 1; overflow-y: auto; padding: 10px 12px;
  scrollbar-width: thin; scrollbar-color: #2d3148 transparent;
}
.sidebar-body::-webkit-scrollbar { width: 4px; }
.sidebar-body::-webkit-scrollbar-thumb { background: #2d3148; border-radius: 2px; }

.block { padding: 8px 0; border-bottom: 1px solid #13151f; }
.block:last-child { border-bottom: none; }

.block-label {
  font-size: 11px; font-weight: 600; color: #64748b; margin-bottom: 6px;
  display: flex; align-items: center; justify-content: space-between;
}
.lbl-hint   { font-weight: 400; font-size: 10px; color: #2d3148; }
.lnk-clear  { background: none; border: none; color: #ef4444; font-size: 10.5px; font-weight: 500; padding: 0; cursor: pointer; }
.lnk-clear:hover { color: #fca5a5; }
.hint   { font-size: 10.5px; color: #3d4266; line-height: 1.5; margin-top: 3px; }
.mt6    { margin-top: 6px; }

/* Chips */
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 3px 7px; border-radius: 4px;
  border: 1px solid #252840; background: transparent;
  color: #4a5080; font-size: 11px; font-weight: 500; cursor: pointer;
  transition: background .1s, color .1s, border-color .1s;
}
.chip:hover  { border-color: #3d4266; color: #94a3b8; }
.chip.active { background: #1e2038; color: #a78bfa; border-color: #4f46e5; }
.chip-count {
  font-size: 9.5px; font-weight: 700; color: #6366f1;
  background: #1a1c35; padding: 0 4px; border-radius: 3px;
}
.chip.active .chip-count { background: #252a4a; color: #c4b5fd; }

/* Inputs */
.fi {
  width: 100%; padding: 6px 10px;
  background: #12141e; border: 1px solid #252840;
  border-radius: 5px; color: #e2e8f0; font-size: 12px; outline: none;
  box-sizing: border-box; transition: border-color .1s;
}
.fi:focus      { border-color: #4f46e5; }
.fi::placeholder { color: #3d4266; }

.range-row { display: flex; align-items: center; gap: 5px; }
.fi-h  { width: 0; flex: 1; }
.sep   { font-size: 12px; color: #3d4266; flex-shrink: 0; }

.toggle-row {
  display: flex; align-items: center; gap: 6px;
  font-size: 12px; color: #94a3b8; cursor: pointer; user-select: none;
}
.toggle-row input[type="checkbox"] { accent-color: #4f46e5; }

/* Sort */
.sort-list { display: flex; flex-direction: column; gap: 1px; margin-bottom: 2px; }
.sort-btn {
  width: 100%; padding: 6px 9px; text-align: left;
  background: transparent; border: 1px solid transparent; border-radius: 5px;
  color: #4a5080; font-size: 11px; font-weight: 500; cursor: pointer;
  transition: background .1s, color .1s;
}
.sort-btn:hover  { background: #1e2235; color: #94a3b8; }
.sort-btn.active { background: #1e2038; color: #a78bfa; border-color: #2d3460; }

/* Toggle de regras */
.rules-toggle {
  display: flex; align-items: center; cursor: pointer; padding: 0;
}
.rules-toggle input { display: none; }
.rules-toggle-track {
  width: 28px; height: 15px; border-radius: 8px;
  background: #252840; border: 1px solid #3d4266;
  position: relative; transition: background .15s, border-color .15s;
  flex-shrink: 0;
}
.rules-toggle-track::after {
  content: ''; position: absolute;
  top: 2px; left: 2px;
  width: 9px; height: 9px; border-radius: 50%;
  background: #4a5080; transition: transform .15s, background .15s;
}
.rules-toggle-track.on {
  background: #1e2038; border-color: #4f46e5;
}
.rules-toggle-track.on::after {
  transform: translateX(13px); background: #a78bfa;
}

.btn-open-rules {
  width: 100%; display: flex; align-items: center; gap: 7px;
  padding: 8px 12px; background: #12141e;
  border: 1px solid #252840; border-radius: 7px;
  color: #94a3b8; font-size: 12px; font-weight: 500; cursor: pointer;
  margin-bottom: 4px;
  transition: background .12s, border-color .12s, color .12s, opacity .12s;
}
.btn-open-rules:hover { background: #1e2235; border-color: #4f46e5; color: #a78bfa; }
.btn-open-rules.muted { opacity: .45; }

.btn-clear-all {
  width: 100%; padding: 7px; background: transparent;
  border: 1px dashed #3d4266; border-radius: 6px;
  color: #4a5080; font-size: 11px; cursor: pointer;
  transition: border-color .12s, color .12s;
}
.btn-clear-all:hover { border-color: #ef4444; color: #ef4444; }

/* States */
.state-grid { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 6px; }
.state-chip {
  display: flex; flex-direction: column; align-items: center;
  min-width: 36px; padding: 4px 4px 3px;
  border-radius: 4px; border: 1px solid #252840;
  background: transparent; color: #4a5080;
  font-size: 10.5px; font-weight: 600; cursor: pointer; line-height: 1;
  transition: background .1s, color .1s, border-color .1s;
}
.state-chip:hover  { border-color: #3d4266; color: #94a3b8; }
.state-chip.active { background: #1e2038; color: #a78bfa; border-color: #4f46e5; }
.state-count { font-size: 8.5px; font-weight: 700; color: #4a5080; margin-top: 2px; }
.state-chip.active .state-count { color: #7c6ff0; }

/* Cities */
.city-row { display: flex; gap: 5px; margin-bottom: 6px; }
.btn-add-tag {
  padding: 6px 11px; background: #1e2038; border: 1px solid #4f46e5;
  border-radius: 5px; color: #a78bfa; font-size: 14px; font-weight: 700;
  flex-shrink: 0; cursor: pointer;
}
.btn-add-tag:hover { background: #252a4a; }

.tags { display: flex; flex-wrap: wrap; gap: 4px; }
.tag {
  display: flex; align-items: center; gap: 4px;
  padding: 3px 8px; background: #1e2038; border-radius: 4px;
  font-size: 11px; color: #a78bfa;
}
.tag-x { background: none; border: none; color: #4a5080; font-size: 10px; padding: 0; cursor: pointer; }
.tag-x:hover { color: #f87171; }
.hint-empty { font-size: 11px; color: #252840; }

/* Save / Scrape */
.save-row { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
.btn-save {
  flex: 1; padding: 7px 12px; background: #1e2038; color: #a78bfa;
  border: 1px solid #4f46e5; border-radius: 6px; font-size: 12px; font-weight: 600; cursor: pointer;
  transition: background .12s;
}
.btn-save:hover:not(:disabled) { background: #252a4a; }
.btn-save:disabled { opacity: .4; cursor: default; }
.saved-ok { font-size: 14px; color: #4ade80; font-weight: 700; }

.scrape-section { padding: 8px 0 4px; }
.btn-scrape {
  width: 100%; display: flex; align-items: center; justify-content: center; gap: 8px;
  padding: 10px; background: #4f46e5; color: #fff;
  border: none; border-radius: 8px; font-weight: 700; font-size: 13px; cursor: pointer;
  transition: background .15s;
}
.btn-scrape:hover:not(:disabled) { background: #6366f1; }
.btn-scrape:disabled { opacity: .5; cursor: default; }

.spinner {
  width: 13px; height: 13px;
  border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
  border-radius: 50%; animation: spin .7s linear infinite; display: inline-block;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Main ── */
.main { flex: 1; min-width: 0; }

.pagination {
  display: flex; align-items: center; justify-content: flex-end;
  gap: 10px; margin-bottom: 14px; font-size: 13px; color: #94a3b8;
}
.pagination button {
  background: #1a1d27; border: 1px solid #2d3148; color: #94a3b8;
  width: 28px; height: 28px; border-radius: 5px; font-size: 16px; line-height: 1; cursor: pointer;
}
.pagination button:not(:disabled):hover { background: #2d3148; }
.pagination button:disabled { opacity: .35; cursor: default; }

.grid  { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 18px; }
.empty { text-align: center; padding: 60px 20px; color: #3d4266; font-size: 14px; }

/* ── Log (rodapé) ── */
.log-panel {
  background: #0d0f18; border: 1px solid #2d3148;
  border-radius: 10px; overflow: hidden; margin-top: 4px;
}
.log-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 14px; background: #161929; border-bottom: 1px solid #2d3148;
}
.log-title  { font-size: 12px; font-weight: 600; color: #64748b; }
.log-meta   { display: flex; align-items: center; gap: 12px; }
.log-result { font-size: 12px; color: #4ade80; font-weight: 600; }
.icon-btn   { background: none; border: none; color: #4a5080; font-size: 13px; padding: 0 4px; cursor: pointer; }
.icon-btn:hover { color: #e2e8f0; }
.log-body {
  max-height: 220px; overflow-y: auto; padding: 10px 14px;
  display: flex; flex-direction: column; gap: 2px;
  scrollbar-width: thin; scrollbar-color: #2d3148 transparent;
}
.log-line { font-size: 11px; font-family: 'Consolas','Menlo',monospace; color: #4a5080; line-height: 1.7; }
.log-line:has(✓) { color: #4ade80; }
.log-line:has(⚠) { color: #f87171; }
.log-cursor { animation: blink 1s step-end infinite; }
@keyframes blink { 50% { opacity: 0; } }

/* ══════════════════════════════════════ MODAL ══════════════════════════════════════ */
.modal-overlay {
  position: fixed; inset: 0; z-index: 1000;
  background: rgba(0,0,0,.65); backdrop-filter: blur(2px);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.modal {
  background: #1a1d27; border: 1px solid #2d3148; border-radius: 12px;
  width: 100%; max-width: 700px; max-height: 88vh;
  display: flex; flex-direction: column; overflow: hidden;
  box-shadow: 0 20px 60px rgba(0,0,0,.5);
}
.modal-header {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 18px 20px 14px; border-bottom: 1px solid #2d3148; flex-shrink: 0;
}
.modal-title { font-size: 16px; font-weight: 700; color: #e2e8f0; margin-bottom: 3px; }
.modal-sub   { font-size: 12px; color: #64748b; line-height: 1.4; max-width: 480px; }
.modal-body  { flex: 1; overflow-y: auto; padding: 16px 20px; }
.rules-empty { text-align: center; padding: 36px 20px; color: #4a5080; font-size: 13px; }
.rules-list  { display: flex; flex-direction: column; gap: 10px; }

.rule-card {
  background: #12141e; border: 1px solid #252840; border-radius: 8px;
  overflow: hidden; transition: opacity .15s;
}
.rule-card.disabled { opacity: .45; }
.rule-head {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; background: #161929; border-bottom: 1px solid #252840;
}
.rule-n { font-size: 11px; font-weight: 700; color: #3d4266; min-width: 20px; }
.mode-toggle { display: flex; border-radius: 5px; overflow: hidden; border: 1px solid #2d3148; }
.mode-btn {
  padding: 4px 12px; font-size: 11px; font-weight: 600;
  background: transparent; border: none; color: #4a5080; cursor: pointer;
  transition: background .1s, color .1s;
}
.mode-btn:hover  { background: #1e2235; color: #94a3b8; }
.mode-btn.active { background: #1e2038; color: #a78bfa; }
.mode-red.active { background: #2d1a1a; color: #f87171; }
.rule-active {
  display: flex; align-items: center; gap: 5px;
  font-size: 12px; color: #64748b; cursor: pointer; user-select: none;
}
.rule-active input[type="checkbox"] { accent-color: #4f46e5; }
.btn-del-rule {
  margin-left: auto; padding: 4px 10px; background: transparent;
  border: 1px solid #2d2020; border-radius: 4px; color: #64748b;
  font-size: 11px; cursor: pointer; transition: background .1s, color .1s, border-color .1s;
}
.btn-del-rule:hover { background: #2d1a1a; border-color: #f87171; color: #f87171; }

.rule-fields {
  display: grid; grid-template-columns: 1fr 1fr 1fr auto;
  gap: 10px; padding: 12px 14px; align-items: end;
}
.rf       { display: flex; flex-direction: column; gap: 4px; }
.rf-sm    { min-width: 90px; }
.rf span  { font-size: 10.5px; font-weight: 600; color: #4a5080; }

.modal-footer {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 20px; border-top: 1px solid #2d3148; flex-shrink: 0;
}
.btn-add-rule {
  padding: 7px 16px; background: transparent;
  border: 1px dashed #3d4266; border-radius: 6px;
  color: #64748b; font-size: 12px; cursor: pointer;
  transition: border-color .12s, color .12s;
}
.btn-add-rule:hover { border-color: #4f46e5; color: #a78bfa; }
.modal-actions { display: flex; gap: 8px; }
.btn-cancel {
  padding: 8px 18px; background: transparent; border: 1px solid #2d3148;
  border-radius: 6px; color: #64748b; font-size: 13px; cursor: pointer;
  transition: background .12s, color .12s;
}
.btn-cancel:hover { background: #2d3148; color: #94a3b8; }
.btn-apply {
  padding: 8px 22px; background: #4f46e5; color: #fff;
  border: none; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
  transition: background .15s;
}
.btn-apply:hover:not(:disabled) { background: #6366f1; }
.btn-apply:disabled { opacity: .5; cursor: default; }

/* ── Transitions ── */
.slide-left-enter-active, .slide-left-leave-active { transition: opacity .18s, transform .18s; }
.slide-left-enter-from,   .slide-left-leave-to     { opacity: 0; transform: translateX(-8px); }

.slide-up-enter-active, .slide-up-leave-active { transition: opacity .2s, transform .2s; }
.slide-up-enter-from,   .slide-up-leave-to     { opacity: 0; transform: translateY(8px); }

.modal-enter-active              { transition: opacity .2s; }
.modal-enter-active .modal       { transition: opacity .2s, transform .2s; }
.modal-leave-active              { transition: opacity .15s; }
.modal-leave-active .modal       { transition: opacity .15s, transform .15s; }
.modal-enter-from,
.modal-leave-to                  { opacity: 0; }
.modal-enter-from .modal,
.modal-leave-to .modal           { opacity: 0; transform: scale(.96) translateY(-8px); }

.fade-enter-active, .fade-leave-active { transition: opacity .2s; }
.fade-enter-from,   .fade-leave-to     { opacity: 0; }
</style>
