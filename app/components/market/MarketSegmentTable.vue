<script setup lang="ts">
import type { SegmentOutcomeRow } from '~/types/market'

const props = withDefaults(defineProps<{
  title: string
  entityLabel: string
  rows: SegmentOutcomeRow[]
  emptyMessage?: string
  compact?: boolean
}>(), {
  emptyMessage: 'Sem registros finalizados ainda.',
  compact: false,
})

type SortColumn = 'label' | 'nWithFipe' | 'sold' | 'conditional' | 'meanSoldFipe' | 'meanConditionalFipe'

const sortColumn = ref<SortColumn>('nWithFipe')
const sortDir = ref<'asc' | 'desc'>('desc')

function sortBy(column: string) {
  const col = column as SortColumn
  if (sortColumn.value === col) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  }
  else {
    sortColumn.value = col
    sortDir.value = col === 'label' ? 'asc' : 'desc'
  }
}

const sortedRows = computed(() => {
  const dir = sortDir.value === 'asc' ? 1 : -1
  const col = sortColumn.value
  return [...props.rows].sort((a, b) => {
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
    <h2 class="mb-3 text-[13px] font-semibold text-soft">{{ title }}</h2>
    <div v-if="rows.length === 0" class="py-6 text-center text-[12.5px] text-faint">{{ emptyMessage }}</div>
    <div v-else class="overflow-x-auto">
      <table class="w-full text-[12.5px]">
        <thead>
          <tr>
            <MarketSortableTh :label="entityLabel" column="label" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="Amostra" column="nWithFipe" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <template v-if="!compact">
              <MarketSortableTh label="Vendido" column="sold" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
              <MarketSortableTh label="Condicional" column="conditional" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            </template>
            <MarketSortableTh label="% vendido" column="meanSoldFipe" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
            <MarketSortableTh label="% condicional" column="meanConditionalFipe" align="right" :active-column="sortColumn" :direction="sortDir" @sort="sortBy" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in sortedRows" :key="row.key" class="border-t border-line-soft transition hover:bg-surface/40">
            <td class="py-1.5 pr-3 font-medium text-body">
              {{ row.label }}
              <span v-if="compact" class="text-tabular ml-1 text-[10.5px] font-normal text-faint">{{ row.sold }}V/{{ row.conditional }}C</span>
            </td>
            <td class="py-1.5 pr-3"><MarketSampleBadge :n="row.nWithFipe" :sufficient="row.sufficient" :compact="compact" /></td>
            <template v-if="!compact">
              <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.sold }}</td>
              <td class="text-tabular py-1.5 pr-3 text-right text-dim">{{ row.conditional }}</td>
            </template>
            <td class="py-1.5 pr-3"><div class="flex justify-end"><MarketPctBar :value="row.meanSoldFipe" /></div></td>
            <td class="py-1.5"><div class="flex justify-end"><MarketPctBar :value="row.meanConditionalFipe" /></div></td>
          </tr>
        </tbody>
      </table>
    </div>
  </UiCard>
</template>
