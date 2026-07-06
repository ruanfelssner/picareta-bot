<script setup lang="ts">
import { TabsList, TabsRoot, TabsTrigger } from 'reka-ui'

interface SegmentOutcomeRow {
  key: string
  label: string
  n: number
  nWithFipe: number
  sold: number
  conditional: number
  soldPctOfSegment: number | null
  conditionalPctOfSegment: number | null
  meanSoldFipe: number | null
  meanConditionalFipe: number | null
  sufficient: boolean
}

interface Band {
  label: string
  count: number
  pctOfSample: number
}

interface OpportunityRow {
  source: string
  sourceLabel: string
  damageBucket: string
  damageLabel: string
  n: number
  nWithFipe: number
  soldMean: number | null
  conditionalMean: number | null
  diff: number | null
  level: 'alta' | 'media' | 'baixa' | 'insuficiente'
}

interface MarketOverviewResponse {
  meta: {
    total: number
    withPrice: number
    withFipe: number
    withPriceAndFipe: number
    withSoldPrice: number
    sourcesActive: number
    coverageDays: number | null
  }
  outcomes: {
    totalFinalized: number
    notSoldExcluded: number
    sold: number
    conditional: number
    soldWithFipe: number
    conditionalWithFipe: number
    totalWithFipe: number
    manualCount: number
    autoCount: number
    soldMeanPct: number | null
    conditionalMeanPct: number | null
    diffPct: number | null
    sufficient: boolean
    minSampleRequired: number
  }
  outcomesByBrand: SegmentOutcomeRow[]
  outcomesBySource: SegmentOutcomeRow[]
  outcomesByDamage: SegmentOutcomeRow[]
  bands: Band[]
  opportunity: OpportunityRow[]
  generatedAt: string
}

type TabId = 'geral' | 'condicional' | 'marcas' | 'leiloeiros' | 'monta' | 'oportunidade'

const TABS: { id: TabId, label: string }[] = [
  { id: 'geral', label: 'Visão geral' },
  { id: 'condicional', label: 'Vendido × condicional' },
  { id: 'marcas', label: 'Marcas' },
  { id: 'leiloeiros', label: 'Leiloeiros' },
  { id: 'monta', label: 'Monta' },
  { id: 'oportunidade', label: 'Mapa de oportunidade' },
]

const activeTab = ref<TabId>('geral')

const { data, pending, error, refresh } = await useFetch<MarketOverviewResponse>('/api/market/overview')

function pct(value: number | null | undefined): string {
  return value != null ? `${value.toLocaleString('pt-BR')}%` : '—'
}

function int(value: number | null | undefined): string {
  return value != null ? value.toLocaleString('pt-BR') : '—'
}

function ratio(part: number, total: number): string {
  return total > 0 ? `${Math.round((part / total) * 100)}%` : '—'
}

const generatedAtFormatted = computed(() => {
  if (!data.value?.generatedAt) return null
  return new Date(data.value.generatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
})
</script>

<template>
  <div class="mx-auto flex max-w-5xl flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-bold text-strong">Painel de mercado</h1>
        <p class="mt-1 max-w-2xl text-[13px] leading-relaxed text-dim">
          Só entram nesta análise veículos com desfecho registrado — vendido ou condicional — e com FIPE disponível para calcular %. O restante da base (leilões ainda sem resultado) fica de fora: o preço coletado nesse caso pode ser só um lance parcial, não o que de fato aconteceu no lote.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <span v-if="generatedAtFormatted" class="text-[11px] text-faint">Atualizado às {{ generatedAtFormatted }}</span>
        <UiButton variant="secondary" size="sm" :loading="pending" :disabled="pending" @click="refresh()">
          Atualizar
        </UiButton>
      </div>
    </div>

    <div v-if="error" class="rounded-card border border-danger-line bg-danger-bg px-4 py-3 text-[13px] text-danger">
      Falha ao carregar indicadores: {{ error.message }}
    </div>

    <template v-else-if="data">
      <TabsRoot v-model="activeTab">
        <TabsList class="flex flex-wrap gap-1 border-b border-line pb-2">
          <TabsTrigger
            v-for="tab in TABS"
            :key="tab.id"
            :value="tab.id"
            class="rounded-md px-3 py-1.5 text-[12.5px] font-medium text-dim transition hover:bg-line hover:text-body data-[state=active]:bg-line data-[state=active]:text-accent-soft"
          >
            {{ tab.label }}
          </TabsTrigger>
        </TabsList>
      </TabsRoot>

      <!-- Visão geral -->
      <section v-if="activeTab === 'geral'" class="flex flex-col gap-5">
        <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
          <MarketStat label="Veículos na base" :value="int(data.meta.total)" hint="todos os status, inclui leilões ainda sem resultado" />
          <MarketStat label="Com FIPE" :value="ratio(data.meta.withFipe, data.meta.total)" :hint="`${int(data.meta.withFipe)} registros no total`" />
          <MarketStat label="Fontes ativas" :value="int(data.meta.sourcesActive)" />
          <MarketStat label="Janela coberta" :value="data.meta.coverageDays != null ? `${data.meta.coverageDays} dias` : '—'" />
          <MarketStat label="Finalizados (vendido/condicional)" :value="int(data.outcomes.totalFinalized)" hint="o único conjunto usado nesta análise" />
          <MarketStat label="Finalizados com FIPE" :value="int(data.outcomes.totalWithFipe)" hint="subconjunto usado para calcular %" />
        </div>

        <UiCard class="p-4">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[13px] font-semibold text-soft">Resultado de leilão (vendido / condicional)</h2>
            <MarketSampleBadge :n="data.outcomes.totalWithFipe" :sufficient="data.outcomes.sufficient" :min-sample="data.outcomes.minSampleRequired" />
          </div>
          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <MarketStat label="Vendidos" :value="int(data.outcomes.sold)" :hint="`${data.outcomes.soldWithFipe} com FIPE`" />
            <MarketStat label="Condicionais" :value="int(data.outcomes.conditional)" :hint="`${data.outcomes.conditionalWithFipe} com FIPE`" />
            <MarketStat label="% médio vendido" :value="pct(data.outcomes.soldMeanPct)" />
            <MarketStat label="% médio condicional" :value="pct(data.outcomes.conditionalMeanPct)" />
          </div>
          <p class="mt-3 text-[11.5px] leading-relaxed text-faint">
            {{ data.outcomes.manualCount }} de {{ data.outcomes.totalFinalized }} registro(s) finalizados vieram de marcação manual (select de status na tela de veículos); {{ data.outcomes.autoCount }} vieram de detecção automática do scraper.
            {{ data.outcomes.notSoldExcluded }} lote(s) "não vendido" foram excluídos da análise por não terem valor de transação.
            Abaixo de {{ data.outcomes.minSampleRequired }} registros com FIPE no total, qualquer leitura por marca/leiloeiro/monta é só indicativa.
          </p>
        </UiCard>

        <UiCard class="p-4">
          <div class="mb-1 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[13px] font-semibold text-soft">Faixas de martelo sobre a FIPE</h2>
            <span class="text-[11px] text-faint">n = {{ int(data.outcomes.totalWithFipe) }} (só vendido + condicional, com FIPE)</span>
          </div>
          <div v-if="data.outcomes.totalWithFipe === 0" class="py-6 text-center text-[12.5px] text-faint">
            Nenhum registro finalizado com FIPE ainda.
          </div>
          <div v-else class="flex flex-col gap-1.5">
            <div v-for="band in data.bands" :key="band.label" class="flex items-center gap-2.5 text-[11.5px]">
              <span class="w-14 shrink-0 text-dim">{{ band.label }}</span>
              <div class="h-2 flex-1 overflow-hidden rounded-full bg-surface">
                <div class="h-full rounded-full bg-accent" :style="{ width: `${band.pctOfSample}%` }" />
              </div>
              <span class="text-tabular w-20 shrink-0 text-right text-dim">{{ int(band.count) }} · {{ band.pctOfSample }}%</span>
            </div>
          </div>
        </UiCard>
      </section>

      <!-- Vendido x condicional -->
      <section v-else-if="activeTab === 'condicional'" class="flex flex-col gap-5">
        <UiCard class="p-4">
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 class="text-[13px] font-semibold text-soft">Comparação direta</h2>
            <MarketSampleBadge :n="data.outcomes.totalWithFipe" :sufficient="data.outcomes.sufficient" :min-sample="data.outcomes.minSampleRequired" />
          </div>
          <div class="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <MarketStat label="Vendidos com FIPE" :value="int(data.outcomes.soldWithFipe)" />
            <MarketStat label="Condicionais com FIPE" :value="int(data.outcomes.conditionalWithFipe)" />
            <MarketStat label="Não vendidos (excluídos)" :value="int(data.outcomes.notSoldExcluded)" />
            <MarketStat label="Diferença média (vendido − condicional)" :value="pct(data.outcomes.diffPct)" />
          </div>
        </UiCard>

        <UiCard class="p-4">
          <h2 class="mb-3 text-[13px] font-semibold text-soft">Por marca</h2>
          <div v-if="data.outcomesByBrand.length === 0" class="py-6 text-center text-[12.5px] text-faint">Sem registros finalizados ainda.</div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-[12.5px]">
              <thead>
                <tr class="text-left text-[10.5px] uppercase tracking-wide text-faint">
                  <th class="pb-1.5 pr-3">Marca</th>
                  <th class="pb-1.5 pr-3">Amostra com FIPE</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Vendido</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Condicional</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">% médio vendido</th>
                  <th class="text-tabular pb-1.5 text-right">% médio condicional</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.outcomesByBrand" :key="row.key" class="border-t border-line-soft">
                  <td class="py-1.5 pr-3 text-body">{{ row.label }}</td>
                  <td class="py-1.5 pr-3"><MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" /></td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.sold }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.conditional }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ pct(row.meanSoldFipe) }}</td>
                  <td class="text-tabular py-1.5 text-right text-body">{{ pct(row.meanConditionalFipe) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiCard>

        <UiCard class="p-4">
          <h2 class="mb-3 text-[13px] font-semibold text-soft">Por leiloeiro</h2>
          <div v-if="data.outcomesBySource.length === 0" class="py-6 text-center text-[12.5px] text-faint">Sem registros finalizados ainda.</div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-[12.5px]">
              <thead>
                <tr class="text-left text-[10.5px] uppercase tracking-wide text-faint">
                  <th class="pb-1.5 pr-3">Leiloeiro</th>
                  <th class="pb-1.5 pr-3">Amostra com FIPE</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Vendido</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Condicional</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">% médio vendido</th>
                  <th class="text-tabular pb-1.5 text-right">% médio condicional</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.outcomesBySource" :key="row.key" class="border-t border-line-soft">
                  <td class="py-1.5 pr-3 text-body">{{ row.label }}</td>
                  <td class="py-1.5 pr-3"><MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" /></td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.sold }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.conditional }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ pct(row.meanSoldFipe) }}</td>
                  <td class="text-tabular py-1.5 text-right text-body">{{ pct(row.meanConditionalFipe) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiCard>

        <UiCard class="p-4">
          <h2 class="mb-3 text-[13px] font-semibold text-soft">Por tipo de monta</h2>
          <div v-if="data.outcomesByDamage.length === 0" class="py-6 text-center text-[12.5px] text-faint">Sem registros finalizados ainda.</div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-[12.5px]">
              <thead>
                <tr class="text-left text-[10.5px] uppercase tracking-wide text-faint">
                  <th class="pb-1.5 pr-3">Tipo de monta</th>
                  <th class="pb-1.5 pr-3">Amostra com FIPE</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Vendido</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Condicional</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">% médio vendido</th>
                  <th class="text-tabular pb-1.5 text-right">% médio condicional</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.outcomesByDamage" :key="row.key" class="border-t border-line-soft">
                  <td class="py-1.5 pr-3 text-body">{{ row.label }}</td>
                  <td class="py-1.5 pr-3"><MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" /></td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.sold }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.conditional }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ pct(row.meanSoldFipe) }}</td>
                  <td class="text-tabular py-1.5 text-right text-body">{{ pct(row.meanConditionalFipe) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiCard>
      </section>

      <!-- Marcas -->
      <section v-else-if="activeTab === 'marcas'" class="flex flex-col gap-5">
        <UiCard class="p-4">
          <h2 class="mb-3 text-[13px] font-semibold text-soft">Resultado real por marca (vendido/condicional, com FIPE)</h2>
          <div v-if="data.outcomesByBrand.length === 0" class="py-6 text-center text-[12.5px] text-faint">Sem registros finalizados ainda.</div>
          <ul v-else class="flex flex-col gap-1.5 text-[12.5px]">
            <li v-for="row in data.outcomesByBrand" :key="row.key" class="flex items-center justify-between gap-2 border-b border-line-soft pb-1.5">
              <span class="text-body">{{ row.label }}</span>
              <span class="flex items-center gap-2">
                <span class="text-dim">{{ pct(row.meanSoldFipe) }} vendido · {{ pct(row.meanConditionalFipe) }} condicional</span>
                <MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" />
              </span>
            </li>
          </ul>
        </UiCard>
      </section>

      <!-- Leiloeiros -->
      <section v-else-if="activeTab === 'leiloeiros'" class="flex flex-col gap-5">
        <div class="rounded-card border border-line bg-panel-soft px-4 py-3 text-[12px] leading-relaxed text-dim">
          A base não distingue "leilão" (sessão específica) de "leiloeiro" (plataforma) — o corte abaixo é por leiloeiro/fonte, que é o que existe hoje.
        </div>

        <UiCard class="p-4">
          <h2 class="mb-3 text-[13px] font-semibold text-soft">Resultado real por leiloeiro (vendido/condicional, com FIPE)</h2>
          <div v-if="data.outcomesBySource.length === 0" class="py-6 text-center text-[12.5px] text-faint">Sem registros finalizados ainda.</div>
          <ul v-else class="flex flex-col gap-1.5 text-[12.5px]">
            <li v-for="row in data.outcomesBySource" :key="row.key" class="flex items-center justify-between gap-2 border-b border-line-soft pb-1.5">
              <span class="text-body">{{ row.label }}</span>
              <span class="flex items-center gap-2">
                <span class="text-dim">{{ pct(row.meanSoldFipe) }} vendido · {{ pct(row.meanConditionalFipe) }} condicional</span>
                <MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" />
              </span>
            </li>
          </ul>
        </UiCard>
      </section>

      <!-- Monta -->
      <section v-else-if="activeTab === 'monta'" class="flex flex-col gap-5">
        <UiCard class="p-4">
          <h2 class="mb-3 text-[13px] font-semibold text-soft">Resultado real por tipo de monta (vendido/condicional, com FIPE)</h2>
          <div v-if="data.outcomesByDamage.length === 0" class="py-6 text-center text-[12.5px] text-faint">Sem registros finalizados ainda.</div>
          <ul v-else class="flex flex-col gap-1.5 text-[12.5px]">
            <li v-for="row in data.outcomesByDamage" :key="row.key" class="flex items-center justify-between gap-2 border-b border-line-soft pb-1.5">
              <span class="text-body">{{ row.label }}</span>
              <span class="flex items-center gap-2">
                <span class="text-dim">{{ pct(row.meanSoldFipe) }} vendido · {{ pct(row.meanConditionalFipe) }} condicional</span>
                <MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" />
              </span>
            </li>
          </ul>
        </UiCard>
      </section>

      <!-- Mapa de oportunidade -->
      <section v-else-if="activeTab === 'oportunidade'" class="flex flex-col gap-5">
        <div class="rounded-card border border-line bg-panel-soft px-4 py-3 text-[12px] leading-relaxed text-dim">
          Classificação por leiloeiro × tipo de monta, cruzando só desfecho real com FIPE. Alta oportunidade exige n≥30 e condicional médio ≤60% da FIPE com diferença ≥8 p.p. vs. vendido; oportunidade média exige n≥10 com condicional ≤65% e diferença ≥4 p.p.; abaixo de n=10 é sempre "dados insuficientes".
        </div>

        <UiCard class="p-4">
          <div v-if="data.opportunity.length === 0" class="py-8 text-center text-[12.5px] text-faint">
            Nenhuma combinação leiloeiro × monta tem resultado registrado ainda.
          </div>
          <div v-else class="overflow-x-auto">
            <table class="w-full text-[12.5px]">
              <thead>
                <tr class="text-left text-[10.5px] uppercase tracking-wide text-faint">
                  <th class="pb-1.5 pr-3">Leiloeiro</th>
                  <th class="pb-1.5 pr-3">Tipo de monta</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">N com FIPE</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">% vendido</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">% condicional</th>
                  <th class="text-tabular pb-1.5 pr-3 text-right">Diferença</th>
                  <th class="pb-1.5">Nível</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in data.opportunity" :key="`${row.source}-${row.damageBucket}`" class="border-t border-line-soft">
                  <td class="py-1.5 pr-3 text-body">{{ row.sourceLabel }}</td>
                  <td class="py-1.5 pr-3 text-body">{{ row.damageLabel }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.nWithFipe }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ pct(row.soldMean) }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ pct(row.conditionalMean) }}</td>
                  <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ pct(row.diff) }}</td>
                  <td class="py-1.5"><MarketOpportunityBadge :level="row.level" /></td>
                </tr>
              </tbody>
            </table>
          </div>
        </UiCard>
      </section>
    </template>

    <div v-else class="py-16 text-center text-[13px] text-faint">
      Carregando indicadores...
    </div>
  </div>
</template>
