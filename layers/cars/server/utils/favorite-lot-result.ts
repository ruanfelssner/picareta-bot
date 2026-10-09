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
const SHAREABLE_RESULTS = new Set<VehicleRecord['saleStatus']>(['sold', 'conditional', 'not_sold'])
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

  const resultPrice = vehicle.saleStatus === 'sold' ? vehicle.soldPrice ?? vehicle.price : vehicle.price
  const finalPrice = resultPrice != null && resultPrice > 0 ? resultPrice : null
  // Não vendido também é um resultado final, mesmo sem lance registrado.
  if (finalPrice == null && vehicle.saleStatus !== 'not_sold') return 'skipped'

  const favorite = await findFavoriteLot(vehicle)
  if (!favorite.isFavorite) return 'skipped'

  // Trava atômica: o mesmo resultado (status + valor) é enviado uma vez,
  // mesmo com salvamentos repetidos ou reconciliação pelo chat.
  const shareKey = `${vehicle.saleStatus}:${finalPrice != null ? Math.round(finalPrice) : 0}`
  const claim = await VehicleModel.collection.updateOne(
    { _id: rawId as never, favoriteResultSharedKey: { $ne: shareKey } },
    { $set: { favoriteResultSharedKey: shareKey, favoriteResultSharedAt: new Date() } },
  )
  if (claim.modifiedCount !== 1) return 'skipped'

  try {
    const { analysisVehicle, marketAnalysis, feeEstimate, listingUrl } = await buildResultContext(
      vehicle,
      finalPrice,
      favorite.opportunityId,
    )
    const caption = formatFavoriteLotResultCaption({
      vehicle: analysisVehicle,
      finalPrice,
      feeEstimate,
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

export async function shareLiveLotResultIfRequested(
  vehicleId: string,
  observedAt: Date,
  auctionSessionKey: string,
): Promise<'shared' | 'skipped' | 'failed'> {
  if (Date.now() - observedAt.getTime() > RECENT_RESULT_WINDOW_MS) return 'skipped'
  const doc = await VehicleModel.findById(vehicleId).lean()
  if (!doc) return 'skipped'
  const rawId = (doc as Record<string, unknown>)['_id']
  const vehicle = { ...doc, _id: String(rawId) } as VehicleRecord
  if (!SHAREABLE_RESULTS.has(vehicle.saleStatus)) return 'skipped'

  const finalPrice = vehicle.saleStatus === 'sold' ? vehicle.soldPrice ?? vehicle.price : vehicle.price
  const resultVersion = finalPrice != null && finalPrice > 0 ? Math.round(finalPrice) : 0
  const shareKey = `${auctionSessionKey}:${vehicle.lot ?? vehicle.externalId}:${vehicle.saleStatus}:${resultVersion}`
  const claim = await VehicleModel.collection.updateOne(
    { _id: rawId as never, liveResultSharedKey: { $ne: shareKey } },
    { $set: { liveResultSharedKey: shareKey, liveResultSharedAt: new Date() } },
  )
  if (claim.modifiedCount !== 1) return 'skipped'

  try {
    const priced = finalPrice != null && finalPrice > 0 ? finalPrice : null
    const { analysisVehicle, marketAnalysis, feeEstimate, listingUrl } = await buildResultContext(vehicle, priced, null)
    const caption = formatLiveLotResultCaption({
      vehicle: analysisVehicle,
      finalPrice: priced,
      feeEstimate,
      marketAnalysis,
      listingUrl,
    })
    const result = await sendVehicleToZApi({ ...vehicle, auctionStatus: 'finished', marketAnalysis }, caption)
    if (!result.ok) throw new Error(result.reason ?? 'Falha no envio Z-API')
    console.info('[live-lot-result] resultado compartilhado no WhatsApp', { vehicleId, shareKey })
    return 'shared'
  }
  catch (error) {
    await VehicleModel.collection.updateOne(
      { _id: rawId as never, liveResultSharedKey: shareKey },
      { $unset: { liveResultSharedKey: '', liveResultSharedAt: '' } },
    ).catch(() => undefined)
    console.error('[live-lot-result] falha ao compartilhar resultado', {
      vehicleId,
      shareKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'failed'
  }
}

// Favorito e resultado ao vivo compartilham taxas, FIPE, histórico e link curto
// rastreável do Picareta (sem ele, link direto).
async function buildResultContext(vehicle: VehicleRecord, finalPrice: number | null, opportunityId: string | null) {
  const analysisVehicle: VehicleRecord = finalPrice != null ? { ...vehicle, price: finalPrice } : vehicle
  const history = (await loadMarketHistory())
    .filter(record => String((record as Record<string, unknown>)['_id']) !== vehicle._id)
  const marketAnalysis = buildVehicleMarketAnalysis(analysisVehicle, history)
  const feeEstimate = finalPrice != null ? estimateVehicleFees(analysisVehicle, finalPrice) : null
  const listingUrl = vehicle.url
    ? await createPicaretaShortLink({
        targetUrl: vehicle.url,
        opportunityId: opportunityId ?? vehicle._id ?? null,
        label: [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(' ') || null,
      }) ?? vehicle.url
    : null
  return { analysisVehicle, marketAnalysis, feeEstimate, listingUrl }
}

type LotResultCaptionInput = {
  vehicle: VehicleRecord
  finalPrice: number | null
  feeEstimate: VehicleFeeEstimate | null
  marketAnalysis: VehicleMarketAnalysis | null
  listingUrl: string | null
}

type FavoriteLotResultCaptionInput = LotResultCaptionInput & {
  favoriteCount: number
}

export function formatFavoriteLotResultCaption(input: FavoriteLotResultCaptionInput): string {
  const { vehicle } = input
  const sourceLabel = SOURCE_META[vehicle.source]?.name ?? vehicle.source
  const resultLabel = vehicle.saleStatus === 'sold'
    ? 'VENDIDO'
    : vehicle.saleStatus === 'conditional' ? 'CONDICIONAL' : 'NÃO VENDIDO'
  return formatLotResultCaption(
    input,
    `⭐ *FAVORITO ${resultLabel}* · ${sourceLabel}${input.favoriteCount > 1 ? ` · ${input.favoriteCount} favoritaram` : ''}`,
  )
}

export function formatLiveLotResultCaption(input: LotResultCaptionInput): string {
  const { vehicle } = input
  const sourceLabel = SOURCE_META[vehicle.source]?.name ?? vehicle.source
  const resultLabel = vehicle.saleStatus === 'sold'
    ? 'VENDIDO'
    : vehicle.saleStatus === 'conditional' ? 'CONDICIONAL' : 'NÃO VENDIDO'
  return formatLotResultCaption(input, `📣 *RESULTADO ${resultLabel}* · ${sourceLabel}`)
}

function formatLotResultCaption(input: LotResultCaptionInput, header: string): string {
  const { vehicle, feeEstimate, marketAnalysis } = input
  const title = [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(' ').trim() || '(sem título)'
  const fipe = vehicle.fipe != null && vehicle.fipe > 0 ? Math.round(vehicle.fipe) : null
  const bid = input.finalPrice != null && input.finalPrice > 0 ? Math.round(input.finalPrice) : null
  const total = bid != null ? feeEstimate?.total ?? null : null
  const bidFipePercent = calculateTotalFipePercent(bid, fipe)
  const totalFipePercent = calculateTotalFipePercent(total, fipe)
  const margin = fipe != null && total != null ? fipe - total : null
  const bidLabel = vehicle.saleStatus === 'sold'
    ? 'Vendido por'
    : vehicle.saleStatus === 'conditional' ? 'Lance condicional' : 'Último lance'

  const lines: Array<string | null> = [
    header,
    `🚗 ${title}`,
    [vehicle.lot ? `📋 Lote ${vehicle.lot}` : null, vehicle.yard ? `📍 ${vehicle.yard}` : null].filter(Boolean).join(' · ') || null,
    vehicle.damage ? `🔧 ${vehicle.damage}` : null,
    '',
    bid != null
      ? `💰 ${bidLabel}: ${formatAuctionFeeMoney(bid)}${bidFipePercent != null ? ` (${bidFipePercent}% FIPE)` : ''}`
      : '💰 Sem lance registrado',
    bid != null && feeEstimate ? `🧾 Taxas: ${formatAuctionFeeMoney(feeEstimate.feesTotal)}${formatFeeBreakdown(feeEstimate)}` : null,
    total != null ? `💵 Total com taxas: ${formatAuctionFeeMoney(total)}${totalFipePercent != null ? ` (${totalFipePercent}% FIPE)` : ''}` : null,
    fipe != null ? `📊 FIPE: ${formatAuctionFeeMoney(fipe)}` : null,
    margin != null ? `💹 Margem: ${formatSignedMoney(margin)}` : null,
    '',
    ...(bid != null ? formatHistoryLines(bid, total, fipe, feeEstimate, marketAnalysis, vehicle) : []),
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
  if (estimate.source === 'pampasul') {
    return ` (comissão ${formatAuctionFeeMoney(estimate.commission)} · pátio ${formatAuctionFeeMoney(estimate.yardFee ?? 800)})`
  }
  return ` (comissão ${formatAuctionFeeMoney(estimate.commission)} · DSAL ${formatAuctionFeeMoney(estimate.dsal)} · logística ${formatAuctionFeeMoney(estimate.logistics)} · operacionais ${formatAuctionFeeMoney(estimate.fixedFees)})`
}

function formatSignedMoney(value: number): string {
  const amount = formatAuctionFeeMoney(Math.abs(value))
  return value < 0 ? `- ${amount}` : amount
}

function formatPercent(value: number): string {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`
}
