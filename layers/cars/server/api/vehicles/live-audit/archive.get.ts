import { listAuctionArchiveEvidence, searchAuctionArchive } from '../../../utils/live-auction-archive'
import { archivePage, type AuctionArchiveQuery } from '../../../utils/live-auction-archive-query'

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const value = (key: string, max = 200) => typeof query[key] === 'string' ? query[key].trim().slice(0, max) : undefined
  const date = (key: string) => {
    const input = value(key)
    if (!input) return undefined
    const result = new Date(input)
    if (Number.isNaN(result.getTime())) throw createError({ statusCode: 400, message: 'Data inválida.' })
    return result
  }
  const options: AuctionArchiveQuery = {
    q: value('q'), source: value('source'), sessionKey: value('sessionKey', 240)?.toLowerCase(),
    origin: value('origin'), from: date('from'), to: date('to'), page: archivePage(query.page),
  }
  if (options.source && !['copart', 'sodre', 'vipleiloes'].includes(options.source)) {
    throw createError({ statusCode: 400, message: 'Leiloeiro inválido.' })
  }
  if (options.origin && !['log', 'outbox', 'capture', 'vehicle', 'result', 'catalog'].includes(options.origin)) {
    throw createError({ statusCode: 400, message: 'Origem inválida.' })
  }
  if (options.from && options.to && options.from > options.to) {
    throw createError({ statusCode: 400, message: 'A data inicial deve ser anterior à final.' })
  }
  return options.sessionKey ? listAuctionArchiveEvidence(options) : searchAuctionArchive(options)
})
