<script setup lang="ts">
import type { OpportunityRow } from '~/types/market'

const props = defineProps<{
  rows: OpportunityRow[]
}>()

type SortColumn = 'sourceLabel' | 'damageLabel' | 'nWithFipe' | 'soldMean' | 'conditionalMean' | 'diff' | 'level'

const sortColumn = ref<SortColumn>('nWithFipe')
const sortDir = ref<'asc' | 'desc'>('desc')

const LEVEL_RANK: Record<OpportunityRow['level'], number> = { alta: 3, media: 2, baixa: 1, insuficiente: 0 }

function sortBy(column: string) {
  const col = column as SortColumn
  if (sortColumn.value === col) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  }
  else {
    sortColumn.value = col
    sortDir.value = col === 'sourceLabel' || col === 'damageLabel' ? 'asc' : 'desc'
  }
}

const sortedRows = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1
  const col = sortColumn.value
  return [...props.rows].sort((a, b) => {
    if (col === 'level') return (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) * dir
    const av = a[col]
    const bv = b[col]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'string' && typeof bv === 'string') return av.localeCompare(bv) * dir
    return ((av as number) - (bv as number)) * dir
  })
})
</script>

<template>
  <UiCard class="min-w-0 p-4">
    <div v-if="rows.length === 0" class="py-8 text-center text-[12.5px] text-faint">
      Nenhuma combinação leiloeiro × monta tem resultado registrado ainda.
    </div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <MarketSortableTh label="Leiloeiro" column="sourceLabel" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="Tipo de monta" column="damageLabel" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="N c/ FIPE" column="nWithFipe" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="% vendido" column="soldMean" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="% condicional" column="conditionalMean" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="Diferença" column="diff" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="Nível" column="level" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sortedRows" :key="`${row.source}-${row.damageBucket}`" class="border-t border-line-soft transition hover:bg-surface/40">
            <td class="py-1.5 pr-3 font-medium text-body">{{ row.sourceLabel }}</td>
            <td class="py-1.5 pr-3 text-body">{{ row.damageLabel }}</td>
            <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.nWithFipe }}</td>
            <td class="py-1.5 pr-3"><div class="flex justify-end"><MarketPctBar :value="row.soldMean" /></div></td>
            <td class="py-1.5 pr-3"><div class="flex justify-end"><MarketPctBar :value="row.conditionalMean" /></div></td>
            <td class="text-tabular py-1.5 pr-3 text-right text-body">{{ row.diff != null ? `${row.diff.toLocaleString('pt-BR')}%` : '—' }}</td>
            <td class="py-1.5"><MarketOpportunityBadge :level="row.level" /></td>
          </tr>
        </tbody>
      </table>
    </div>
  </UiCard>
</template>
