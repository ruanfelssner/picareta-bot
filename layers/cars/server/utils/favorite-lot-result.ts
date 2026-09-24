import type { VehicleRecord } from '#shared/types/vehicle'
import type { VehicleMarketAnalysis } from '#shared/types/market-analysis'
import { SOURCE_META } from '#shared/constants/sources'
import {
  calculateTotalFipePercent,
  estimateVehicleFees,
  formatAuctionFeeMoney,
  type VehicleFeeEstimate,
} from '#shared/utils/auction-fees'
import { buildVehicleMarketAnalysis, loadMarketHistory } from './vehicle-market-analysis'
import { VehicleModel } from './schemas/vehicle'
import { sendVehicleToZApi } from './zapi'
import { createPicaretaShortLink } from './picareta-sync'

// Favoritos pertencem ao Picareta (`marketplace.auction_favorites`) e usam o
// `_id` de `scraped_vehicles` como `opportunityId`. Qualquer usuário conta.
const FAVORITES_COLLECTION = 'auction_favorites'
const SHAREABLE_RESULTS = new Set<VehicleRecord['saleStatus']>(['sold', 'conditional'])
// Reprocessamentos de capturas antigas mantêm o `observedAt` original e não
// devem disparar mensagens atrasadas no grupo.
const RECENT_RESULT_WINDOW_MS = 30 * 60 * 1000

export type FavoriteLotInfo = {
  isFavorite: boolean
  count: number
  opportunityId: string | null
}

const NOT_FAVORITE: FavoriteLotInfo = { isFavorite: false, count: 0, opportunityId: null }

export async function findFavoriteLot(vehicle: Pick<VehicleRecord, '_id' | 'source' | 'url'> | null): Promise<FavoriteLotInfo> {
  const vehicleId = vehicle?._id ? String(vehicle._id) : null
  const db = VehicleModel.db.db
  if (!vehicle || !vehicleId || !db) return NOT_FAVORITE

  try {
    // O mesmo lote pode ter mais de uma ocorrência com a mesma URL; o
    // favorito pode ter sido marcado em qualquer uma delas.
    const ids = new Set([vehicleId])
    if (vehicle.url) {
      const siblings = await VehicleModel.find({ source: vehicle.source, url: vehicle.url }, { _id: 1 }).limit(20).lean()
      for (const sibling of siblings) ids.add(String((sibling as Record<string, unknown>)['_id']))
    }

    const favorites = await db.collection(FAVORITES_COLLECTION)
      .find({ opportunityId: { $in: [...ids] } }, { projection: { userId: 1, opportunityId: 1 } })
      .toArray()
    if (favorites.length === 0) return NOT_FAVORITE

    const owners = new Set(favorites.map(favorite => String(favorite['userId'] ?? '')).filter(Boolean))
    const opportunityIds = favorites.map(favorite => String(favorite['opportunityId']))
    return {
      isFavorite: true,
      count: Math.max(owners.size, 1),
      opportunityId: opportunityIds.includes(vehicleId) ? vehicleId : opportunityIds[0] ?? vehicleId,
    }
  } catch (error) {
    console.error('[favorite-lot] falha ao consultar favoritos', {
      vehicleId,
      error: error instanceof Error ? error.message : String(error),
    })
    return NOT_FAVORITE
  }
}

export async function shareFavoriteLotResultIfNeeded(vehicleId: string, observedAt: Date): Promise<'shared' | 'skipped' | 'failed'> {
  if (Date.now() - observedAt.getTime() > RECENT_RESULT_WINDOW_MS) return 'skipped'

  const doc = await VehicleModel.findById(vehicleId).lean()
  if (!doc) return 'skipped'
  const rawId = (doc as Record<string, unknown>)['_id']
  const vehicle = { ...doc, _id: String(rawId) } as VehicleRecord
  if (!SHAREABLE_RESULTS.has(vehicle.saleStatus)) return 'skipped'

  const finalPrice = vehicle.saleStatus === 'sold' ? vehicle.soldPrice ?? vehicle.price : vehicle.price
  if (finalPrice == null || finalPrice <= 0) return 'skipped'

  const favorite = await findFavoriteLot(vehicle)
  if (!favorite.isFavorite) return 'skipped'

  // Trava atômica: o mesmo resultado (status + valor) é enviado uma vez,
  // mesmo com salvamentos repetidos ou reconciliação pelo chat.
  const shareKey = `${vehicle.saleStatus}:${Math.round(finalPrice)}`
  const claim = await VehicleModel.collection.updateOne(
    { _id: rawId as never, favoriteResultSharedKey: { $ne: shareKey } },
    { $set: { favoriteResultSharedKey: shareKey, favoriteResultSharedAt: new Date() } },
  )
  if (claim.modifiedCount !== 1) return 'skipped'

  try {
    const history = (await loadMarketHistory())
      .filter(record => String((record as Record<string, unknown>)['_id']) !== vehicle._id)
    const analysisVehicle: VehicleRecord = { ...vehicle, price: finalPrice }
    const marketAnalysis = buildVehicleMarketAnalysis(analysisVehicle, history)
    // Mesmo link curto rastreável das mensagens do Picareta; sem ele, link direto.
    const listingUrl = vehicle.url
      ? await createPicaretaShortLink({
        targetUrl: vehicle.url,
        opportunityId: favorite.opportunityId ?? vehicle._id ?? null,
        label: [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(' ') || null,
      }) ?? vehicle.url
      : null
    const caption = formatFavoriteLotResultCaption({
      vehicle: analysisVehicle,
      finalPrice,
      feeEstimate: estimateVehicleFees(analysisVehicle, finalPrice),
      marketAnalysis,
      favoriteCount: favorite.count,
      listingUrl,
    })
    const result = await sendVehicleToZApi({ ...vehicle, auctionStatus: 'finished', marketAnalysis }, caption)
    if (!result.ok) throw new Error(result.reason ?? 'Falha no envio Z-API')

    console.info('[favorite-lot] resultado compartilhado no WhatsApp', { vehicleId, shareKey })
    return 'shared'
  } catch (error) {
    await VehicleModel.collection.updateOne(
      { _id: rawId as never, favoriteResultSharedKey: shareKey },
      { $unset: { favoriteResultSharedKey: '', favoriteResultSharedAt: '' } },
    ).catch(() => undefined)
    console.error('[favorite-lot] falha ao compartilhar resultado', {
      vehicleId,
      shareKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'failed'
  }
}

type FavoriteLotResultCaptionInput = {
  vehicle: VehicleRecord
  finalPrice: number
  feeEstimate: VehicleFeeEstimate | null
  marketAnalysis: VehicleMarketAnalysis | null
  favoriteCount: number
  listingUrl: string | null
}

export function formatFavoriteLotResultCaption(input: FavoriteLotResultCaptionInput): string {
  const { vehicle, feeEstimate, marketAnalysis } = input
  const sourceLabel = SOURCE_META[vehicle.source]?.name ?? vehicle.source
  const title = [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(' ').trim() || '(sem título)'
  const isSold = vehicle.saleStatus === 'sold'
  const fipe = vehicle.fipe != null && vehicle.fipe > 0 ? Math.round(vehicle.fipe) : null
  const bid = Math.round(input.finalPrice)
  const total = feeEstimate?.total ?? null
  const bidFipePercent = calculateTotalFipePercent(bid, fipe)
  const totalFipePercent = calculateTotalFipePercent(total, fipe)
  const margin = fipe != null && total != null ? fipe - total : null

  const lines: Array<string | null> = [
    `⭐ *FAVORITO ${isSold ? 'VENDIDO' : 'CONDICIONAL'}* · ${sourceLabel}${input.favoriteCount > 1 ? ` · ${input.favoriteCount} favoritaram` : ''}`,
    `🚗 ${title}`,
    [vehicle.lot ? `📋 Lote ${vehicle.lot}` : null, vehicle.yard ? `📍 ${vehicle.yard}` : null].filter(Boolean).join(' · ') || null,
    vehicle.damage ? `🔧 ${vehicle.damage}` : null,
    '',
    `💰 ${isSold ? 'Vendido por' : 'Lance condicional'}: ${formatAuctionFeeMoney(bid)}${bidFipePercent != null ? ` (${bidFipePercent}% FIPE)` : ''}`,
    feeEstimate ? `🧾 Taxas: ${formatAuctionFeeMoney(feeEstimate.feesTotal)}${formatFeeBreakdown(feeEstimate)}` : null,
    total != null ? `💵 Total com taxas: ${formatAuctionFeeMoney(total)}${totalFipePercent != null ? ` (${totalFipePercent}% FIPE)` : ''}` : null,
    fipe != null ? `📊 FIPE: ${formatAuctionFeeMoney(fipe)}` : null,
    margin != null ? `💹 Margem: ${formatSignedMoney(margin)}` : null,
    '',
    ...formatHistoryLines(bid, total, fipe, feeEstimate, marketAnalysis, vehicle),
    '',
    input.listingUrl ? `🔗 Anúncio: ${input.listingUrl}` : null,
  ]

  return lines
    .filter((line): line is string => line != null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatHistoryLines(
  bid: number,
  total: number | null,
  fipe: number | null,
  feeEstimate: VehicleFeeEstimate | null,
  marketAnalysis: VehicleMarketAnalysis | null,
  vehicle: VehicleRecord,
): string[] {
  if (!marketAnalysis || fipe == null) return ['📈 Histórico insuficiente para comparar']

  // Mesma comparação exibida na extensão: lance x venda média sem taxas e
  // total x venda média com as mesmas taxas aplicadas.
  const historicalSaleValue = Math.round(fipe * marketAnalysis.averagePct / 100)
  const historicalTotalValue = feeEstimate ? estimateVehicleFees(vehicle, historicalSaleValue)?.total ?? null : null
  const bidDifference = historicalSaleValue - bid
  const totalDifference = historicalTotalValue != null && total != null ? total - historicalTotalValue : null
  const conditionalValue = marketAnalysis.conditionalAveragePct != null
    ? Math.round(fipe * marketAnalysis.conditionalAveragePct / 100)
    : null

  return [
    `📈 Venda média: ${formatAuctionFeeMoney(historicalSaleValue)} (${formatPercent(marketAnalysis.averagePct)} FIPE)`,
    `• Lance ${bidDifference === 0 ? 'igual à média' : `${formatAuctionFeeMoney(Math.abs(bidDifference))} ${bidDifference > 0 ? 'abaixo' : 'acima'} da média`}`,
    totalDifference != null
      ? `• Total ${formatAuctionFeeMoney(Math.abs(totalDifference))} ${totalDifference <= 0 ? 'abaixo' : 'acima'} do histórico com taxas (${formatAuctionFeeMoney(historicalTotalValue)})`
      : null,
    `• Condicional: ${conditionalValue != null && marketAnalysis.conditionalAveragePct != null
      ? `${formatAuctionFeeMoney(conditionalValue)} (${formatPercent(marketAnalysis.conditionalAveragePct)} FIPE)`
      : '— (sem amostra)'}`,
    `• ${marketAnalysis.sampleSize} vendidos · ${marketAnalysis.basisLabel}`,
  ].filter((line): line is string => line != null)
}

function formatFeeBreakdown(estimate: VehicleFeeEstimate): string {
  if (estimate.mode === 'fixed') return ' (taxa fixa)'
  return ` (comissão ${formatAuctionFeeMoney(estimate.commission)} · DSAL ${formatAuctionFeeMoney(estimate.dsal)} · logística ${formatAuctionFeeMoney(estimate.logistics)} · operacionais ${formatAuctionFeeMoney(estimate.fixedFees)})`
}

function formatSignedMoney(value: number): string {
  const amount = formatAuctionFeeMoney(Math.abs(value))
  return value < 0 ? `- ${amount}` : amount
}

function formatPercent(value: number): string {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}
