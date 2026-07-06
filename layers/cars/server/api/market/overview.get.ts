import type { VehicleRecord, VehicleSource } from '#shared/types/vehicle'
import { SOURCE_META } from '#shared/constants/sources'
import type { DamageBucket } from '../../utils/market-analytics'
import {
  classifyDamage,
  classifyOpportunity,
  damageLabel,
  MIN_OUTCOME_SAMPLE,
  MIN_SEGMENT_SAMPLE,
  mean,
  normalizeBrand,
  pctBand,
  PCT_BANDS,
  round1,
} from '../../utils/market-analytics'
import { VehicleModel } from '../../utils/schemas/vehicle'

type OutcomeDoc = Pick<VehicleRecord, 'brand' | 'source' | 'damage' | 'price' | 'soldPrice' | 'fipe' | 'saleStatus' | 'saleStatusRaw'>

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

function sourceLabel(source: string): string {
  return SOURCE_META[source as VehicleSource]?.name ?? source
}

function effectivePrice(doc: Pick<VehicleRecord, 'price' | 'soldPrice'>): number | null {
  return doc.soldPrice ?? doc.price
}

function pctFipe(doc: Pick<VehicleRecord, 'price' | 'soldPrice' | 'fipe'>): number | null {
  const price = effectivePrice(doc)
  if (price == null || doc.fipe == null || doc.fipe <= 0) return null
  return (price / doc.fipe) * 100
}

function hasFipe(doc: Pick<VehicleRecord, 'fipe'>): boolean {
  return doc.fipe != null && doc.fipe > 0
}

function buildSegmentOutcomeRows(docs: OutcomeDoc[], keyOf: (doc: OutcomeDoc) => string, labelOf: (key: string) => string): SegmentOutcomeRow[] {
  const groups = new Map<string, OutcomeDoc[]>()
  for (const doc of docs) {
    const key = keyOf(doc)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(doc)
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const sold = group.filter(d => d.saleStatus === 'sold')
      const conditional = group.filter(d => d.saleStatus === 'conditional')
      const soldPcts = sold.map(pctFipe).filter((v): v is number => v != null)
      const conditionalPcts = conditional.map(pctFipe).filter((v): v is number => v != null)
      const n = group.length
      const nWithFipe = group.filter(hasFipe).length

      return {
        key,
        label: labelOf(key),
        n,
        nWithFipe,
        sold: sold.length,
        conditional: conditional.length,
        soldPctOfSegment: n > 0 ? round1((sold.length / n) * 100) : null,
        conditionalPctOfSegment: n > 0 ? round1((conditional.length / n) * 100) : null,
        meanSoldFipe: soldPcts.length > 0 ? round1(mean(soldPcts)!) : null,
        meanConditionalFipe: conditionalPcts.length > 0 ? round1(mean(conditionalPcts)!) : null,
        sufficient: nWithFipe >= MIN_SEGMENT_SAMPLE,
      }
    })
    .sort((a, b) => b.n - a.n)
}

export default defineEventHandler(async () => {
  useDb()

  const [total, withPrice, withFipe, withPriceAndFipe, withSoldPrice, sources, oldestDoc, newestDoc] = await Promise.all([
    VehicleModel.countDocuments({}),
    VehicleModel.countDocuments({ price: { $ne: null, $gt: 0 } }),
    VehicleModel.countDocuments({ fipe: { $ne: null, $gt: 0 } }),
    VehicleModel.countDocuments({ price: { $ne: null, $gt: 0 }, fipe: { $ne: null, $gt: 0 } }),
    VehicleModel.countDocuments({ soldPrice: { $ne: null, $gt: 0 } }),
    VehicleModel.distinct('source'),
    VehicleModel.findOne({}, { scrapedAt: 1 }).sort({ scrapedAt: 1 }).lean(),
    VehicleModel.findOne({}, { scrapedAt: 1 }).sort({ scrapedAt: -1 }).lean(),
  ])

  const coverageDays = oldestDoc && newestDoc
    ? Math.max(1, Math.round((new Date(newestDoc.scrapedAt).getTime() - new Date(oldestDoc.scrapedAt).getTime()) / 86_400_000))
    : null

  // Só entram na análise veículos com desfecho registrado (vendido ou condicional).
  // "not_sold" e qualquer lote ainda sem resultado ficam de fora — o preço coletado
  // nesses casos pode ser só um lance parcial, não o que de fato aconteceu no lote.
  const outcomeDocs = await VehicleModel.find(
    { saleStatus: { $in: ['sold', 'conditional'] } },
    { brand: 1, source: 1, damage: 1, price: 1, soldPrice: 1, fipe: 1, saleStatus: 1, saleStatusRaw: 1 },
  ).lean() as unknown as OutcomeDoc[]

  const notSoldCount = await VehicleModel.countDocuments({ saleStatus: 'not_sold' })

  const sold = outcomeDocs.filter(d => d.saleStatus === 'sold')
  const conditional = outcomeDocs.filter(d => d.saleStatus === 'conditional')
  const manualCount = outcomeDocs.filter(d => d.saleStatusRaw === 'Manual').length
  const soldWithFipe = sold.filter(hasFipe)
  const conditionalWithFipe = conditional.filter(hasFipe)
  const soldPcts = soldWithFipe.map(pctFipe).filter((v): v is number => v != null)
  const conditionalPcts = conditionalWithFipe.map(pctFipe).filter((v): v is number => v != null)
  const soldMean = soldPcts.length > 0 ? round1(mean(soldPcts)!) : null
  const conditionalMean = conditionalPcts.length > 0 ? round1(mean(conditionalPcts)!) : null
  const totalWithFipe = soldWithFipe.length + conditionalWithFipe.length

  const outcomes = {
    totalFinalized: outcomeDocs.length,
    notSoldExcluded: notSoldCount,
    sold: sold.length,
    conditional: conditional.length,
    soldWithFipe: soldWithFipe.length,
    conditionalWithFipe: conditionalWithFipe.length,
    totalWithFipe,
    manualCount,
    autoCount: outcomeDocs.length - manualCount,
    soldMeanPct: soldMean,
    conditionalMeanPct: conditionalMean,
    diffPct: soldMean != null && conditionalMean != null ? round1(soldMean - conditionalMean) : null,
    sufficient: totalWithFipe >= MIN_OUTCOME_SAMPLE,
    minSampleRequired: MIN_OUTCOME_SAMPLE,
  }

  const outcomesByBrand = buildSegmentOutcomeRows(outcomeDocs, d => normalizeBrand(d.brand), key => key)
  const outcomesBySource = buildSegmentOutcomeRows(outcomeDocs, d => d.source, key => sourceLabel(key))
  const outcomesByDamage = buildSegmentOutcomeRows(outcomeDocs, d => classifyDamage(d.damage), key => damageLabel(key as DamageBucket))

  const finalizedPcts = [...soldPcts, ...conditionalPcts]
  const bandCounts = new Map<string, number>()
  for (const label of PCT_BANDS) bandCounts.set(label, 0)
  for (const pct of finalizedPcts) bandCounts.set(pctBand(pct), (bandCounts.get(pctBand(pct)) ?? 0) + 1)
  const bands = PCT_BANDS.map(label => ({
    label,
    count: bandCounts.get(label) ?? 0,
    pctOfSample: finalizedPcts.length > 0 ? round1(((bandCounts.get(label) ?? 0) / finalizedPcts.length) * 100) : 0,
  }))

  const opportunityGroups = new Map<string, { source: string, bucket: DamageBucket, docs: OutcomeDoc[] }>()
  for (const doc of outcomeDocs) {
    const bucket = classifyDamage(doc.damage)
    const key = `${doc.source}|${bucket}`
    if (!opportunityGroups.has(key)) opportunityGroups.set(key, { source: doc.source, bucket, docs: [] })
    opportunityGroups.get(key)!.docs.push(doc)
  }
  const opportunity = [...opportunityGroups.values()]
    .map(({ source, bucket, docs: group }) => {
      const groupSold = group.filter(d => d.saleStatus === 'sold').map(pctFipe).filter((v): v is number => v != null)
      const groupConditional = group.filter(d => d.saleStatus === 'conditional').map(pctFipe).filter((v): v is number => v != null)
      const groupSoldMean = groupSold.length > 0 ? round1(mean(groupSold)!) : null
      const groupConditionalMean = groupConditional.length > 0 ? round1(mean(groupConditional)!) : null
      const diff = groupSoldMean != null && groupConditionalMean != null ? round1(groupSoldMean - groupConditionalMean) : null
      const nWithFipe = groupSold.length + groupConditional.length
      const level = classifyOpportunity(nWithFipe, groupConditionalMean, diff)

      return {
        source,
        sourceLabel: sourceLabel(source),
        damageBucket: bucket,
        damageLabel: damageLabel(bucket),
        n: group.length,
        nWithFipe,
        soldMean: groupSoldMean,
        conditionalMean: groupConditionalMean,
        diff,
        level,
      }
    })
    .sort((a, b) => b.nWithFipe - a.nWithFipe)

  return {
    meta: {
      total,
      withPrice,
      withFipe,
      withPriceAndFipe,
      withSoldPrice,
      sourcesActive: sources.length,
      coverageDays,
    },
    outcomes,
    outcomesByBrand,
    outcomesBySource,
    outcomesByDamage,
    bands,
    opportunity,
    generatedAt: new Date().toISOString(),
  }
})
