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

export function formatVehicleCaption(v: VehicleRecord): string {
  const sourceMeta = SOURCE_META[v.source]
  const sourceLabel = sourceMeta?.name ?? v.source
  const title = [v.brand, v.model, v.year].filter(Boolean).join(' ').trim() || '(sem título)'

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
    let icon = '🏁'
    if (v.saleStatus === 'sold') icon = '✅'
    else if (v.saleStatus === 'conditional') icon = '⚠️'
    else if (v.saleStatus === 'not_sold') icon = '⛔'

    const displayPrice = soldPrice ?? price
    const pricePart = displayPrice != null ? formatMoney(displayPrice) : null
    const pctPart = fipePercent != null ? `(${fipePercent}% da FIPE)` : null
    const priceWithPct = pricePart && pctPart
      ? `${pricePart} ${pctPart}`
      : pricePart ?? pctPart ?? null

    const locationPart = v.yard
      ? v.yard
      : v.city && v.state
        ? `${v.city} - ${v.state}`
        : v.location ?? null

    const detailParts = [priceWithPct, auctionDateShort, locationPart].filter(Boolean)

    return [
      `${title} · ${sourceLabel}`,
      detailParts.length > 0 ? `${icon} ${detailParts.join(' · ')}` : icon,
      totalWithFeesLine,
      `🔗 ${v.url}`,
    ].filter(Boolean).join('\n')
  }

  // Full format for future/upcoming auctions
  const lines: string[] = [
    sourceLabel,
    `🚗 ${title}`,
  ]

  if (v.damage) lines.push(`🔧 ${v.damage}`)

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
