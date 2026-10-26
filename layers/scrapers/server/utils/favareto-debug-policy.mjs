const ORIGIN = 'https://www.favaretoleiloes.com.br'

/** O canal de automação só pode consultar o catálogo público; nunca envia lances/login. */
export function validateFavaretoDebugRequest(value) {
  if (!value || typeof value !== 'object' || typeof value.url !== 'string') throw new Error('URL de consulta ausente.')
  const url = new URL(value.url)
  if (url.origin !== ORIGIN || url.username || url.password || url.search || url.hash) throw new Error('Origem de consulta não permitida.')
  const init = value.init ?? {}
  if (!init || typeof init !== 'object') throw new Error('Consulta inválida.')
  const method = init.method ?? 'GET'
  const listing = url.pathname === '/leiloes/' || /^\/edital\/\d+\/$/.test(url.pathname)
  const details = url.pathname === '/classes/json_lance.php'
  const history = url.pathname === '/classes/json_historico.php'
  if (listing && method === 'GET') return { url: url.href, init: { method, charset: 'windows-1252' } }
  if ((!details && !history) || method !== 'POST' || typeof init.body !== 'string') throw new Error('Somente leitura de editais, detalhes e histórico é permitida.')
  const params = new URLSearchParams(init.body)
  const required = details ? ['ordem', 'leilao'] : ['seq', 'data', 'dataleilao']
  if (required.some(name => params.getAll(name).length !== 1) || [...params.keys()].some(name => !required.includes(name))) throw new Error('Parâmetros de consulta inválidos.')
  for (const name of required.filter(name => name !== 'dataleilao')) {
    if (!/^[1-9]\d*$/.test(params.get(name) ?? '')) throw new Error('Identificador de consulta inválido.')
  }
  if (history && !/^\d{2}\/\d{2}\/\d{2,4}$/.test(params.get('dataleilao') ?? '')) throw new Error('Data de consulta inválida.')
  return { url: url.href, init: { method, body: params.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' }, charset: 'utf-8' } }
}
