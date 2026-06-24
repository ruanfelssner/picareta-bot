import type { VehicleRecord } from '#shared/types/vehicle'
import { SOURCE_META } from '#shared/constants/sources'

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

  const auctionDateShort = formatDateShort(v.auctionDate)
  const auctionDate = formatDate(v.auctionDate)

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
  if (v.saleStatus === 'sold' && soldPrice != null) {
    const pctPart = fipePercent != null ? ` (${fipePercent}% da FIPE)` : ''
    lines.push(`✅ Vendido: ${formatMoney(soldPrice)}${pctPart}`)
  }
  else if (v.saleStatus === 'conditional' && price != null) {
    const pctPart = fipePercent != null ? ` (${fipePercent}% da FIPE)` : ''
    lines.push(`⚠️ Condicional: ${formatMoney(price)}${pctPart}`)
  }
  else if (v.saleStatus === 'not_sold') {
    const pricePart = price != null ? ` · Último lance: ${formatMoney(price)}` : ''
    lines.push(`⛔ Não vendido${pricePart}`)
  }
  else if (price != null) {
    const pctPart = fipePercent != null ? ` (${fipePercent}% da FIPE)` : ''
    lines.push(`💰 Lance: ${formatMoney(price)}${pctPart}`)
  }

  if (auctionDateShort) lines.push(`🗓️ Data: ${auctionDateShort}`)
  else if (auctionDate) lines.push(`🗓️ Data: ${auctionDate}`)
  if (v.lot) lines.push(`📋 Lote: ${v.lot}`)

  lines.push(`🏷️ ${sourceLabel}  🔗 ${v.url}`)

  return lines.join('\n')
}
