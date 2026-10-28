import type { mongo } from 'mongoose'

import { useDb } from '../../../../server/utils/db'
import type { AuctionArchiveEvidence, AuctionArchiveEvidencePage, AuctionArchivePage, AuctionArchiveSession } from '#shared/types/live-auction-archive'
import { archiveFacet, archiveMatch, archivePage, archivePipeline, type AuctionArchiveQuery } from './live-auction-archive-query'

type Document = mongo.Document

const iso = (value: unknown): string | null => value instanceof Date ? value.toISOString() : null
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const number = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
const SOURCES: Record<string, string> = { copart: 'Copart', vipleiloes: 'VIP', sodre: 'Sodré', pestana: 'Pestana' }

export async function searchAuctionArchive(options: AuctionArchiveQuery): Promise<AuctionArchivePage<AuctionArchiveSession>> {
  const db = useDb().db
  if (!db) throw new Error('Banco de dados ainda não está conectado.')
  const page = archivePage(options.page)
  const pageSize = 25
  const [result] = await db.collection('auction_live_events').aggregate([
    ...archivePipeline(options, true),
    { $sort: { observedAt: -1, id: 1 } },
    { $group: {
      _id: '$sessionKey', source: { $first: '$source' }, auctionId: { $first: '$auctionId' },
      label: { $max: '$label' }, lastEventAt: { $max: '$observedAt' },
      recordCount: { $sum: { $cond: [{ $eq: ['$origin', 'session'] }, 0, 1] } },
      rawCount: { $sum: { $cond: [{ $in: ['$origin', ['log', 'outbox']] }, 1, 0] } },
      sample: { $first: { lot: '$lot', code: '$code', title: '$title' } },
    } },
    { $sort: { lastEventAt: -1, _id: 1 } },
    { $lookup: { from: 'auction_sessions', localField: '_id', foreignField: 'sessionKey', as: 'session', pipeline: [{ $project: { _id: 0, label: 1 } }, { $limit: 1 }] } },
    archiveFacet(page, pageSize),
  ], { maxTimeMS: 20_000, allowDiskUse: true }).toArray()
  return {
    items: (result?.items ?? []).map((row: Document) => ({
      sessionKey: String(row._id), source: String(row.source ?? ''), auctionId: text(row.auctionId),
      label: text(row.session?.[0]?.label) || text(row.label) || `${SOURCES[String(row.source)] || row.source} · ${row.auctionId || 'Sem sessão identificada'}`,
      lastEventAt: iso(row.lastEventAt), recordCount: Number(row.recordCount), rawCount: Number(row.rawCount),
      sample: { lot: text(row.sample?.lot), code: text(row.sample?.code), title: text(row.sample?.title) },
    })),
    total: result?.count?.[0]?.total ?? 0, page, pageSize,
  }
}

export async function listAuctionArchiveEvidence(options: AuctionArchiveQuery): Promise<AuctionArchiveEvidencePage> {
  const db = useDb().db
  if (!db) throw new Error('Banco de dados ainda não está conectado.')
  const page = archivePage(options.page)
  const pageSize = 50
  const [result] = await db.collection('auction_live_events').aggregate([
    ...archivePipeline({ sessionKey: options.sessionKey }, false),
    { $facet: {
      raw: [{ $match: { origin: { $in: ['log', 'outbox'] } } }, { $count: 'total' }],
      items: [{ $match: archiveMatch(options) }, { $sort: { observedAt: -1, id: 1 } }, { $skip: (page - 1) * pageSize }, { $limit: pageSize }],
      count: [{ $match: archiveMatch(options) }, { $count: 'total' }],
    } },
  ], { maxTimeMS: 20_000, allowDiskUse: true }).toArray()
  const items: AuctionArchiveEvidence[] = (result?.items ?? []).map((row: Document) => ({
    id: String(row.id), origin: row.origin, sessionKey: String(row.sessionKey), source: String(row.source ?? ''),
    auctionId: text(row.auctionId), lot: text(row.lot), code: text(row.code), title: text(row.title),
    observedAt: iso(row.observedAt), message: text(row.message), amount: number(row.amount), fipe: number(row.fipe),
    status: text(row.status), kind: text(row.kind), url: text(row.url), eventId: text(row.eventId),
  }))
  return { items, total: result?.count?.[0]?.total ?? 0, page, pageSize, rawCount: result?.raw?.[0]?.total ?? 0 }
}
