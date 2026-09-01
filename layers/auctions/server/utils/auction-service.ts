import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { getHeader, getRequestIP, getRequestURL, createError } from 'h3'
import type { AuctionEventType, AuctionRecord, BidRecord, PublicAuctionVehicle, PublicBid } from '#shared/types/auction'
import { VehicleModel } from '../../../cars/server/utils/schemas/vehicle'
import { sendTextMessageToZApi, getZApiConfigFromEnv, type ZApiConfig } from '../../../../src/integrations/zapi'
import { AuctionModel, BidModel, CommunityModel, WhatsAppEventModel } from './schemas/auction'

type VehicleLean = {
  _id: unknown
  brand: string
  model: string
  title: string
  year: number | null
  km: string | null
  fuel: string | null
  fipe: number | null
  imageUrls: string[]
}

export class AuctionServiceError extends Error {
  statusCode: number
  constructor(statusCode: number, message: string) {
    super(message)
    this.statusCode = statusCode
  }
}

const auctionLocks = new Map<string, Promise<void>>()

async function withAuctionLock<T>(auctionId: string, action: () => Promise<T>): Promise<T> {
  const previous = auctionLocks.get(auctionId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => { release = resolve })
  auctionLocks.set(auctionId, current)
  await previous
  try { return await action() }
  finally {
    release()
    if (auctionLocks.get(auctionId) === current) auctionLocks.delete(auctionId)
  }
}

function idOf(value: unknown): string {
  return String(value)
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function maskName(name: string): string {
  const clean = name.trim()
  if (clean.length <= 1) return `${clean.slice(0, 1)}•••`
  return `${clean.slice(0, 1)}${'•'.repeat(Math.min(5, Math.max(3, clean.length - 1)))}`
}

function formatMoney(value: number): string {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function vehicleTitle(vehicle: VehicleLean): string {
  return [vehicle.brand, vehicle.model, vehicle.year].filter(Boolean).join(' ').trim() || vehicle.title || 'Veículo'
}

function makeSlug(vehicle: VehicleLean): string {
  const base = vehicleTitle(vehicle).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 58) || 'veiculo'
  return `${base}-${randomBytes(4).toString('base64url')}`
}

function toVehicle(vehicle: VehicleLean): PublicAuctionVehicle {
  return {
    id: idOf(vehicle._id), brand: vehicle.brand, model: vehicle.model, title: vehicle.title,
    year: vehicle.year ?? null, km: vehicle.km ?? null, fuel: vehicle.fuel ?? null,
    fipe: vehicle.fipe ?? null, imageUrls: Array.isArray(vehicle.imageUrls) ? vehicle.imageUrls : [],
  }
}

function toBid(bid: BidRecord, publicView = false): PublicBid & { status?: string; rejectionReason?: string | null } {
  return {
    id: idOf(bid._id), bidderName: publicView ? maskName(bid.bidderName) : bid.bidderName,
    amount: bid.amount, createdAt: iso(bid.createdAt) ?? '',
    ...(!publicView ? { status: bid.status, rejectionReason: bid.rejectionReason } : {}),
  }
}

function auctionDto(auction: AuctionRecord, bidsCount = 0, pendingBids = 0) {
  return {
    id: idOf(auction._id), vehicleId: auction.vehicleId, status: auction.status,
    startingBid: auction.startingBid, increment: auction.increment,
    currentBid: auction.currentBid, nextBid: auction.currentBid == null ? auction.startingBid : auction.currentBid + auction.increment,
    winnerBidId: auction.winnerBidId, autoApproveBids: auction.autoApproveBids,
    publicSlug: auction.publicSlug, publicUrl: `/lance/${auction.publicSlug}`,
    publishedAt: iso(auction.publishedAt), finishedAt: iso(auction.finishedAt),
    createdAt: iso(auction.createdAt), updatedAt: iso(auction.updatedAt), bidsCount, pendingBids,
  }
}

function baseUrl(event?: H3Event): string {
  return (process.env.NUXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, '') || (event ? getRequestURL(event).origin : '')).trim()
}

function publicUrl(slug: string, event?: H3Event): string {
  return `${baseUrl(event)}/lance/${slug}`
}

function assertValidMoney(value: unknown, field: string): number {
  const amount = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100_000_000) throw new AuctionServiceError(400, `${field} deve ser maior que zero.`)
  return Math.round(amount)
}

export function assertAuctionAdmin(event: H3Event): void {
  const expected = process.env.AUCTION_ADMIN_TOKEN?.trim()
  if (expected && getHeader(event, 'x-auction-admin-token') !== expected) throw createError({ statusCode: 401, message: 'Token administrativo inválido.' })
}

export async function listAuctionVehicles() {
  const vehicles = await VehicleModel.find({ status: { $in: ['scraped', 'sent', 'favorite'] } })
    .select('_id brand model title year km fuel fipe imageUrls scrapedAt').sort({ scrapedAt: -1 }).limit(200).lean<VehicleLean[]>()
  return vehicles.map(vehicle => ({ ...toVehicle(vehicle), scrapedAt: iso((vehicle as VehicleLean & { scrapedAt?: Date }).scrapedAt) }))
}

export async function listAuctions() {
  const auctions = await AuctionModel.find().sort({ createdAt: -1 }).lean<AuctionRecord[]>()
  const vehicleIds = auctions.map(auction => auction.vehicleId)
  const vehicles = await VehicleModel.find({ _id: { $in: vehicleIds } }).select('_id brand model title year km fuel fipe imageUrls').lean<VehicleLean[]>()
  const byId = new Map(vehicles.map(vehicle => [idOf(vehicle._id), vehicle]))
  const result = []
  for (const auction of auctions) {
    const [bidsCount, pendingBids] = await Promise.all([
      BidModel.countDocuments({ auctionId: idOf(auction._id) }),
      BidModel.countDocuments({ auctionId: idOf(auction._id), status: 'pending' }),
    ])
    result.push({ auction: auctionDto(auction, bidsCount, pendingBids), vehicle: byId.get(auction.vehicleId) ? toVehicle(byId.get(auction.vehicleId)!) : null })
  }
  return result
}

export async function createAuction(input: { vehicleId: string; startingBid: unknown; increment: unknown; autoApproveBids?: unknown }) {
  const vehicle = await VehicleModel.findById(input.vehicleId).select('_id brand model title year km fuel fipe imageUrls').lean<VehicleLean>()
  if (!vehicle) throw new AuctionServiceError(404, 'Veículo não encontrado.')
  const now = new Date()
  const auction = await AuctionModel.create({
    vehicleId: idOf(vehicle._id), status: 'draft', startingBid: assertValidMoney(input.startingBid, 'Valor inicial'),
    increment: assertValidMoney(input.increment, 'Incremento'), currentBid: null, winnerBidId: null,
    autoApproveBids: input.autoApproveBids !== false, publicSlug: makeSlug(vehicle), publishedAt: null, finishedAt: null,
    createdAt: now, updatedAt: now,
  })
  return { auction: auctionDto(auction.toObject() as unknown as AuctionRecord), vehicle: toVehicle(vehicle) }
}

export async function updateAuction(id: string, input: { startingBid?: unknown; increment?: unknown; autoApproveBids?: unknown; vehicleId?: string }) {
  const auction = await AuctionModel.findById(id).lean<AuctionRecord>()
  if (!auction) throw new AuctionServiceError(404, 'Leilão não encontrado.')
  if (auction.status !== 'draft') throw new AuctionServiceError(409, 'Somente rascunhos podem ser editados.')
  const update: Record<string, unknown> = { updatedAt: new Date() }
  if (input.startingBid !== undefined) update.startingBid = assertValidMoney(input.startingBid, 'Valor inicial')
  if (input.increment !== undefined) update.increment = assertValidMoney(input.increment, 'Incremento')
  if (input.autoApproveBids !== undefined) update.autoApproveBids = input.autoApproveBids === true
  if (input.vehicleId !== undefined) {
    const vehicle = await VehicleModel.exists({ _id: input.vehicleId })
    if (!vehicle) throw new AuctionServiceError(404, 'Veículo não encontrado.')
    update.vehicleId = input.vehicleId
  }
  const updated = await AuctionModel.findByIdAndUpdate(id, { $set: update }, { new: true, lean: true })
  if (!updated) throw new AuctionServiceError(404, 'Leilão não encontrado.')
  return auctionDto(updated as unknown as AuctionRecord)
}

async function auctionWithVehicle(idOrSlug: string, bySlug = false) {
  const query = bySlug ? { publicSlug: idOrSlug } : { _id: idOrSlug }
  const auction = await AuctionModel.findOne(query).lean<AuctionRecord>()
  if (!auction) throw new AuctionServiceError(404, 'Leilão não encontrado.')
  const vehicle = await VehicleModel.findById(auction.vehicleId).select('_id brand model title year km fuel fipe imageUrls').lean<VehicleLean>()
  if (!vehicle) throw new AuctionServiceError(404, 'Veículo do leilão não encontrado.')
  return { auction, vehicle }
}

async function createAuctionEvent(type: AuctionEventType, auction: AuctionRecord, message: string, bidId: string | null) {
  return WhatsAppEventModel.create({ type, auctionId: idOf(auction._id), bidId, message, status: 'pending', retryCount: 0, lastError: null, createdAt: new Date(), sentAt: null })
}

export async function dispatchWhatsAppEvent(eventId: string) {
  const event = await WhatsAppEventModel.findOneAndUpdate({ _id: eventId, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'sending' }, $inc: { retryCount: 1 } }, { new: true, lean: true })
  if (!event) return { ok: false, reason: 'Evento já processado ou em envio.' }
  const community = await CommunityModel.findOne().lean()
  const env = getZApiConfigFromEnv()
  const canSend = Boolean(env.instanceId && env.token && env.clientToken && env.enabled !== false)
  if (!community || !canSend) {
    const reason = !community ? 'Comunidade WhatsApp não configurada.' : 'Z-API não configurada.'
    await WhatsAppEventModel.findByIdAndUpdate(eventId, { $set: { status: 'failed', lastError: reason } })
    return { ok: false, reason }
  }
  const config: ZApiConfig = { ...env, enabled: true, phone: community.announcementGroupId }
  const result = await sendTextMessageToZApi(config, { phone: community.announcementGroupId, message: event.message })
  await WhatsAppEventModel.findByIdAndUpdate(eventId, result.ok
    ? { $set: { status: 'sent', sentAt: new Date(), lastError: null } }
    : { $set: { status: 'failed', lastError: result.reason ?? 'Falha desconhecida' } })
  return result
}

export async function publishAuction(id: string, event?: H3Event) {
  const result = await withAuctionLock(id, async () => {
    const current = await auctionWithVehicle(id)
    if (current.auction.status !== 'draft') throw new AuctionServiceError(409, 'Este leilão já foi publicado ou finalizado.')
    const now = new Date()
    const auction = await AuctionModel.findOneAndUpdate({ _id: id, status: 'draft' }, { $set: { status: 'available', publishedAt: now, updatedAt: now } }, { new: true, lean: true }) as unknown as AuctionRecord | null
    if (!auction) throw new AuctionServiceError(409, 'O leilão mudou de estado. Atualize a página.')
    const message = [`🚘 NOVO VEÍCULO DISPONÍVEL PARA LANCES`, ``, vehicleTitle(current.vehicle), ``, `💰 Lance inicial: ${formatMoney(auction.startingBid)}`, `📈 Incrementos: ${formatMoney(auction.increment)}`, ``, `👉 Dê seu lance:`, publicUrl(auction.publicSlug, event)].join('\n')
    const whatsappEvent = await createAuctionEvent('AUCTION_PUBLISHED', auction, message, null)
    return { auction: auctionDto(auction), vehicle: toVehicle(current.vehicle), eventId: idOf(whatsappEvent._id) }
  })
  const whatsapp = await dispatchWhatsAppEvent(result.eventId)
  return { ...result, whatsapp }
}

export async function finishAuction(id: string, event?: H3Event) {
  const result = await withAuctionLock(id, async () => {
    const current = await auctionWithVehicle(id)
    if (current.auction.status !== 'available') throw new AuctionServiceError(409, 'Somente leilões disponíveis podem ser finalizados.')
    const winner = current.auction.winnerBidId ? await BidModel.findById(current.auction.winnerBidId).lean<BidRecord>() : null
    const now = new Date()
    const auction = await AuctionModel.findOneAndUpdate({ _id: id, status: 'available' }, { $set: { status: 'finished', finishedAt: now, updatedAt: now } }, { new: true, lean: true }) as unknown as AuctionRecord | null
    if (!auction) throw new AuctionServiceError(409, 'O leilão mudou de estado. Atualize a página.')
    const message = [`🔨 LEILÃO FINALIZADO`, ``, vehicleTitle(current.vehicle), ``, `🏆 Maior lance:`, auction.currentBid != null ? formatMoney(auction.currentBid) : 'Nenhum lance', ``, `Obrigado a todos que participaram.`, ``, `👉 ${publicUrl(auction.publicSlug, event)}`].join('\n')
    const whatsappEvent = await createAuctionEvent('AUCTION_FINISHED', auction, message, winner ? idOf(winner._id) : null)
    return { auction: auctionDto(auction), eventId: idOf(whatsappEvent._id) }
  })
  const whatsapp = await dispatchWhatsAppEvent(result.eventId)
  return { ...result, whatsapp }
}

export async function listBids(auctionId: string) {
  const exists = await AuctionModel.exists({ _id: auctionId })
  if (!exists) throw new AuctionServiceError(404, 'Leilão não encontrado.')
  const bids = await BidModel.find({ auctionId }).sort({ createdAt: -1 }).lean<BidRecord[]>()
  return bids.map(bid => toBid(bid))
}

function nextAmount(auction: AuctionRecord): number {
  return auction.currentBid == null ? auction.startingBid : auction.currentBid + auction.increment
}

export async function submitBid(slug: string, input: { name: string; sessionId?: string; event?: H3Event }) {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 80) throw new AuctionServiceError(400, 'Informe um nome entre 2 e 80 caracteres.')
  const initial = await auctionWithVehicle(slug, true)
  const result = await withAuctionLock(idOf(initial.auction._id), async () => {
    const { auction, vehicle } = await auctionWithVehicle(slug, true)
    if (auction.status !== 'available') throw new AuctionServiceError(409, auction.status === 'finished' ? 'Este leilão já foi finalizado.' : 'Este veículo ainda não está disponível para lances.')
    const amount = nextAmount(auction)
    const now = new Date()
    const source = { auctionId: idOf(auction._id), bidderName: name, amount, sessionId: input.sessionId?.slice(0, 120) ?? null, ipAddress: input.event ? getRequestIP(input.event, { xForwardedFor: true }) ?? null : null, userAgent: input.event ? getHeader(input.event, 'user-agent')?.slice(0, 300) ?? null : null, createdAt: now, acceptedAt: auction.autoApproveBids ? now : null, rejectedAt: null, rejectionReason: null, status: auction.autoApproveBids ? 'accepted' : 'pending' as const }
    const bid = await BidModel.create(source)
    let updatedAuction = auction
    if (auction.autoApproveBids) {
      const updated = await AuctionModel.findOneAndUpdate({ _id: auction._id, status: 'available', currentBid: auction.currentBid }, { $set: { currentBid: amount, winnerBidId: idOf(bid._id), updatedAt: now } }, { new: true, lean: true })
      if (!updated) {
        await BidModel.findByIdAndUpdate(bid._id, { $set: { status: 'rejected', rejectionReason: 'SUPERSEDED', rejectedAt: new Date(), acceptedAt: null } })
        throw new AuctionServiceError(409, 'Outro lance foi registrado. Tente novamente.')
      }
      updatedAuction = updated as unknown as AuctionRecord
      const message = [`🔥 NOVO LANCE!`, ``, vehicleTitle(vehicle), ``, `💰 ${formatMoney(amount)}`, `👤 ${maskName(name)}`, ``, `Próximo lance: ${formatMoney(nextAmount(updatedAuction))}`, ``, `👉 Dar lance:`, publicUrl(updatedAuction.publicSlug, input.event)].join('\n')
      const whatsappEvent = await createAuctionEvent('BID_ACCEPTED', updatedAuction, message, idOf(bid._id))
      return { auction: auctionDto(updatedAuction), bid: toBid(bid.toObject() as unknown as BidRecord), accepted: true, eventId: idOf(whatsappEvent._id) }
    }
    return { auction: auctionDto(updatedAuction), bid: toBid(bid.toObject() as unknown as BidRecord), accepted: false, eventId: null }
  })
  const whatsapp = result.eventId ? await dispatchWhatsAppEvent(result.eventId) : null
  return { ...result, whatsapp }
}

export async function acceptBid(id: string, event?: H3Event) {
  const bid = await BidModel.findById(id).lean<BidRecord>()
  if (!bid) throw new AuctionServiceError(404, 'Lance não encontrado.')
  const result = await withAuctionLock(bid.auctionId, async () => {
    const auction = await AuctionModel.findById(bid.auctionId).lean<AuctionRecord>()
    if (!auction) throw new AuctionServiceError(404, 'Leilão não encontrado.')
    if (auction.status !== 'available') throw new AuctionServiceError(409, 'Leilão não está disponível.')
    const expected = nextAmount(auction)
    if (bid.status !== 'pending') throw new AuctionServiceError(409, 'Este lance já foi processado.')
    if (bid.amount !== expected) {
      await BidModel.findByIdAndUpdate(id, { $set: { status: 'rejected', rejectionReason: 'SUPERSEDED', rejectedAt: new Date() } })
      throw new AuctionServiceError(409, 'Este lance ficou obsoleto após outro lance aceito.')
    }
    const now = new Date()
    const updatedAuction = await AuctionModel.findOneAndUpdate({ _id: bid.auctionId, status: 'available', currentBid: auction.currentBid }, { $set: { currentBid: bid.amount, winnerBidId: id, updatedAt: now } }, { new: true, lean: true }) as unknown as AuctionRecord | null
    if (!updatedAuction) throw new AuctionServiceError(409, 'Outro lance foi aceito. Atualize a página.')
    await BidModel.updateMany({ auctionId: bid.auctionId, status: 'pending', amount: bid.amount, _id: { $ne: id } }, { $set: { status: 'rejected', rejectionReason: 'SUPERSEDED', rejectedAt: now } })
    const accepted = await BidModel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'accepted', acceptedAt: now } }, { new: true, lean: true }) as unknown as BidRecord | null
    if (!accepted) throw new AuctionServiceError(409, 'Este lance já foi processado por outra ação.')
    const vehicle = (await auctionWithVehicle(bid.auctionId)).vehicle
    const message = [`🔥 NOVO LANCE!`, ``, vehicleTitle(vehicle), ``, `💰 ${formatMoney(bid.amount)}`, `👤 ${maskName(bid.bidderName)}`, ``, `Próximo lance: ${formatMoney(nextAmount(updatedAuction))}`, ``, `👉 Dar lance:`, publicUrl(updatedAuction.publicSlug, event)].join('\n')
    const whatsappEvent = await createAuctionEvent('BID_ACCEPTED', updatedAuction, message, id)
    return { auction: auctionDto(updatedAuction), bid: toBid(accepted), eventId: idOf(whatsappEvent._id) }
  })
  const whatsapp = await dispatchWhatsAppEvent(result.eventId)
  return { ...result, whatsapp }
}

export async function rejectBid(id: string) {
  const bid = await BidModel.findById(id).lean<BidRecord>()
  if (!bid) throw new AuctionServiceError(404, 'Lance não encontrado.')
  if (bid.status !== 'pending') throw new AuctionServiceError(409, 'Este lance já foi processado.')
  const updated = await BidModel.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'rejected', rejectionReason: 'ADMIN_REJECTED', rejectedAt: new Date() } }, { new: true, lean: true })
  if (!updated) throw new AuctionServiceError(409, 'Este lance já foi processado.')
  return toBid(updated as unknown as BidRecord)
}

export async function getPublicAuction(slug: string) {
  const { auction, vehicle } = await auctionWithVehicle(slug, true)
  const bids = await BidModel.find({ auctionId: idOf(auction._id), status: 'accepted' }).sort({ createdAt: -1 }).lean<BidRecord[]>()
  return {
    auction: auctionDto(auction, bids.length), vehicle: toVehicle(vehicle),
    bids: bids.map(bid => toBid(bid, true)),
  }
}

export async function getCommunity() {
  const community = await CommunityModel.findOne().lean()
  return community ? { id: idOf(community._id), name: community.name, zapiCommunityId: community.zapiCommunityId, announcementGroupId: community.announcementGroupId, invitationLink: community.invitationLink ?? null, createdAt: iso(community.createdAt), updatedAt: iso(community.updatedAt) } : null
}

function responseObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

async function createZApiCommunity(name: string) {
  const config = getZApiConfigFromEnv()
  if (!config.instanceId || !config.token || !config.clientToken) throw new AuctionServiceError(503, 'Configure ZAPI_INSTANCE_ID, ZAPI_TOKEN e ZAPI_CLIENT_TOKEN antes de criar a comunidade.')
  const endpoint = `${config.baseUrl}/instances/${encodeURIComponent(config.instanceId)}/token/${encodeURIComponent(config.token)}/communities`
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Client-Token': config.clientToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
  const text = await response.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) as unknown : null } catch { body = text }
  if (!response.ok) throw new AuctionServiceError(502, `Z-API recusou a criação da comunidade (HTTP ${response.status}).`)
  const data = responseObject(body)
  const id = typeof data.id === 'string' ? data.id : ''
  const groups = Array.isArray(data.subGroups) ? data.subGroups : []
  const announcement = groups.find(group => responseObject(group).isGroupAnnouncement === true) ?? groups[0]
  const groupId = typeof responseObject(announcement).phone === 'string' ? responseObject(announcement).phone as string : ''
  if (!id || !groupId) throw new AuctionServiceError(502, 'Z-API não retornou os IDs da comunidade e do grupo de avisos.')
  return { id, groupId }
}

export async function saveCommunity(input: { name: string; zapiCommunityId?: string; announcementGroupId?: string }) {
  const name = input.name.trim()
  if (name.length < 3 || name.length > 100) throw new AuctionServiceError(400, 'Informe um nome de comunidade entre 3 e 100 caracteres.')
  let zapiCommunityId = input.zapiCommunityId?.trim() ?? ''
  let announcementGroupId = input.announcementGroupId?.trim() ?? ''
  if (!zapiCommunityId || !announcementGroupId) {
    const created = await createZApiCommunity(name)
    zapiCommunityId = created.id
    announcementGroupId = created.groupId
  }
  const now = new Date()
  const community = await CommunityModel.findOneAndUpdate({}, { $set: { name, zapiCommunityId, announcementGroupId, updatedAt: now }, $setOnInsert: { createdAt: now } }, { new: true, upsert: true, lean: true })
  return { id: idOf(community?._id), name: community?.name, zapiCommunityId: community?.zapiCommunityId, announcementGroupId: community?.announcementGroupId }
}

export async function generateCommunityInvitationLink() {
  const community = await CommunityModel.findOne().lean()
  if (!community) throw new AuctionServiceError(404, 'Comunidade WhatsApp não configurada.')
  const config = getZApiConfigFromEnv()
  if (!config.instanceId || !config.token || !config.clientToken) throw new AuctionServiceError(503, 'Z-API não configurada.')
  const endpoint = `${config.baseUrl}/instances/${encodeURIComponent(config.instanceId)}/token/${encodeURIComponent(config.token)}/redefine-invitation-link/${encodeURIComponent(community.zapiCommunityId)}`
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Client-Token': config.clientToken } })
  const text = await response.text()
  let body: unknown = null
  try { body = text ? JSON.parse(text) as unknown : null } catch { body = text }
  const link = responseObject(body).invitationLink
  if (!response.ok || typeof link !== 'string' || !link.startsWith('https://')) throw new AuctionServiceError(502, `Z-API não retornou um link de convite válido (HTTP ${response.status}).`)
  await CommunityModel.findByIdAndUpdate(community._id, { $set: { invitationLink: link, updatedAt: new Date() } })
  return { invitationLink: link }
}
