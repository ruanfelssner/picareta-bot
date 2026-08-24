import { listCopartConditionalHistory } from '../../utils/copart-conditional-history'

export default defineEventHandler(async (event) => {
  useDb()
  setResponseHeaders(event, {
    'cache-control': 'no-store, max-age=0',
  })
  return listCopartConditionalHistory(getQuery(event))
})
