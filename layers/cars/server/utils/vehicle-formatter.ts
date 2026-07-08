import type { VehicleRecord } from '#shared/types/vehicle'
import { SOURCE_META } from '#shared/constants/sources'
import {
  calculateTotalFipePercent,
  estimateVehicleFees,
  formatAuctionFeeMoney,
} from '#shared/utils/auction-fees'

function formatMoney(value: number | null): string | null {
  if (value == null) return null
  return `R$ ${value.toLocaleString('pt-BR')}`
}

function formatDate(date: Date | string | null): string | null {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

function formatDateShort(date: Date | string | null): string | null {
  if (!date) return null
  const d = typeof date === 'string' ? new Date(date) : date
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

function formatDateTimeShort(date: Date | string | null): string | null {
  if (!date) return null

  const d = typeof date === 'string' ? new Date(date) : date
  if (Number.isNaN(d.getTime())) return null

  const day = d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  const time = d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(':', 'h')

  return `${day} ${time}`
}

function formatSaleStatusLabel(status: VehicleRecord['saleStatus']): string {
  if (status === 'sold') return 'VENDIDO'
  if (status === 'conditional') return 'CONDICIONAL'
  if (status === 'not_sold') return 'REPASSE'

  return 'FINALIZADO'
}

function normalizeInfoText(value: string | null): string | null {
  if (!value) return null

  const text = value.replace(/\s+/g, ' ').trim()
  return text || null
}

function normalizeForMatch(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim()
}

function extractConditionFromDescription(description: string | null): string | null {
  if (!description) return null

  const match = description.match(/(?:^|\|)\s*Condi[cç][aã]o:\s*([^|]+)/i)
  return normalizeInfoText(match?.[1] ?? null)
}

function hasPartMatching(parts: string[], pattern: RegExp): boolean {
  return parts.some(part => pattern.test(normalizeForMatch(part)))
}

function uniqueInfoParts(parts: Array<string | null>): string[] {
  const seen = new Set<string>()
  const output: string[] = []

  for (const part of parts) {
    const text = normalizeInfoText(part)
    if (!text) continue

    const key = normalizeForMatch(text)
    if (seen.has(key)) continue

    seen.add(key)
    output.push(text)
  }

  return output
}

function getVehicleConditionParts(v: VehicleRecord): string[] {
  const parts = uniqueInfoParts([
    v.damage ? `Monta: ${v.damage}` : null,
    extractConditionFromDescription(v.description),
  ])
  const searchableText = normalizeForMatch([
    v.title,
    v.description,
    v.damage,
    v.auctionStatusRaw,
    v.saleStatusRaw,
  ].filter(Boolean).join(' '))

  if (/FINANCIAMENTO|FINANCEIRA|ALIENACAO|ALIENADO/.test(searchableText) && !hasPartMatching(parts, /FINANCIAMENTO|FINANCEIRA|ALIENACAO|ALIENADO/)) {
    parts.push('Financiamento')
  }

  if (/ENCHENTE|ALAGAD|ALAGAMENTO|INUNDACAO|INUNDAD/.test(searchableText) && !hasPartMatching(parts, /ENCHENTE|ALAGAD|ALAGAMENTO|INUNDACAO|INUNDAD/)) {
    parts.push('Enchente/alagamento')
  }

  return parts
}

function formatVehicleConditionLine(v: VehicleRecord): string | null {
  const parts = getVehicleConditionParts(v)
  return parts.length > 0 ? `🔧 ${parts.join(' · ')}` : null
}

function formatCompactConditionLine(part: string): string {
  if (/^Monta:/i.test(part)) return part
  if (/ENCHENTE|ALAGAD|ALAGAMENTO|INUNDACAO|INUNDAD/i.test(normalizeForMatch(part))) return `Obs.: ${part}`

  return `Cond.: ${part}`
}

export function formatVehicleCaption(v: VehicleRecord): string {
  const sourceMeta = SOURCE_META[v.source]
  const sourceLabel = sourceMeta?.name ?? v.source
  const title = [v.brand, v.model, v.year].filter(Boolean).join(' ').trim() || '(sem título)'
  const conditionParts = getVehicleConditionParts(v)
  const conditionLine = formatVehicleConditionLine(v)

  const fipe = v.fipe != null ? Math.round(v.fipe) : null
  const price = v.price != null ? Math.round(v.price) : null
  const soldPrice = v.soldPrice != null ? Math.round(v.soldPrice) : v.saleStatus === 'sold' ? price : null
  const comparisonPrice = soldPrice ?? price
  const fipePercent =
    comparisonPrice != null && fipe != null && fipe > 0
      ? Math.round((comparisonPrice / fipe) * 100)
      : null
  const feeEstimate = estimateVehicleFees(v, comparisonPrice)
  const totalWithFeesFipePercent = feeEstimate
    ? calculateTotalFipePercent(feeEstimate.total, fipe)
    : null
  const totalWithFeesLine = feeEstimate
    ? [
        `🧾 Valor + taxas: ${formatAuctionFeeMoney(feeEstimate.total)}`,
        `(+ ${formatAuctionFeeMoney(feeEstimate.feesTotal)})`,
        totalWithFeesFipePercent != null ? `(${totalWithFeesFipePercent}% da FIPE)` : null,
      ].filter(Boolean).join(' ')
    : null

  const auctionDateShort = formatDateShort(v.auctionDate)

  // Compact format for finished/sold auctions
  if (v.auctionStatus === 'finished') {
    const displayPrice = soldPrice ?? price
    const pricePart = displayPrice != null ? formatMoney(displayPrice) : null
    const pctPart = fipePercent != null ? `(${fipePercent}%)` : null
    const priceWithPct = [pricePart ?? '-', pctPart].filter(Boolean).join(' ')
    const saleStatusLabel = formatSaleStatusLabel(v.saleStatus)
    const resultDate = formatDateTimeShort(v.saleStatusCheckedAt ?? v.auctionStatusCheckedAt ?? v.auctionDate)
    const financialLines = feeEstimate
      ? [
          `Arremate: ${priceWithPct}`,
          `Taxas: ${formatAuctionFeeMoney(feeEstimate.feesTotal)}`,
          [
            `Total: ${formatAuctionFeeMoney(feeEstimate.total)}`,
            totalWithFeesFipePercent != null ? `(${totalWithFeesFipePercent}%)` : null,
          ].filter(Boolean).join(' '),
        ]
      : [`Arremate: ${priceWithPct}`]

    return [
      `${saleStatusLabel} · ${sourceLabel}`,
      title,
      fipe != null ? `FIPE: ${formatMoney(fipe)}` : null,
      ...conditionParts.map(formatCompactConditionLine),
      ...financialLines,
      resultDate ? `Data: ${resultDate}` : null,
      v.url,
    ].filter(Boolean).join('\n')
  }

  // Full format for future/upcoming auctions
  const lines: string[] = [
    sourceLabel,
    `🚗 ${title}`,
  ]

  if (conditionLine) lines.push(conditionLine)

  const extras: string[] = []
  if (v.color) extras.push(v.color)
  if (v.km) extras.push(`${v.km} km`)
  if (extras.length > 0) lines.push(`📌 ${extras.join(' · ')}`)

  if (v.yard) lines.push(`📍 Pátio: ${v.yard}`)
  else if (v.city && v.state) lines.push(`📍 ${v.city} / ${v.state}`)
  else if (v.location) lines.push(`📍 ${v.location}`)

  if (fipe != null) lines.push(`📊 FIPE: ${formatMoney(fipe)}`)
  if (price != null) {
    const pctPart = fipePercent != null ? ` (${fipePercent}% da FIPE)` : ''
    lines.push(`💰 Lance: ${formatMoney(price)}${pctPart}`)
  }
  if (totalWithFeesLine) lines.push(totalWithFeesLine)

  const auctionDate = formatDate(v.auctionDate)
  if (auctionDateShort) lines.push(`🗓️ Data: ${auctionDateShort}`)
  else if (auctionDate) lines.push(`🗓️ Data: ${auctionDate}`)
  if (v.lot) lines.push(`📋 Lote: ${v.lot}`)

  lines.push(`🏷️ ${sourceLabel}  🔗 ${v.url}`)

  return lines.join('\n')
}
