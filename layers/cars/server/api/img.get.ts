const ALLOWED_HOSTS = [
  'claudiokussleiloes.com.br',
  'favaretoleiloes.com.br',
  'vardana.com.br',
  'vardanaleiloes.com.br',
  'vs-veiculos.com.br',
  'sodresantoro.com.br',
  's3.ecompletocarros.dev',
  'ecompletocarros.dev',
  'copart.com.br',
  'megaleiloes.com.br',
  'leilaojudicial.com',
  'leiloesjudiciais.com.br',
  'superbid.net',
  'vipleiloes.com.br',
  'mgl.com.br',
  'lucinei.com.br',
  'lucineileiloes.com.br',
  'lucineiautomoveis.com.br',
  'sbwebservices.net',
  'ms.sbwebservices.net',
]

function buildReferer(parsed: URL): string {
  const hostname = parsed.hostname.replace(/^www\./, '')

  // Vardana: imagens em /vardana/img_leiloes/LEILAO_ID/... — o servidor exige o Referer
  // da página do leilão correspondente ao ID que aparece no path.
  if (hostname === 'vardanaleiloes.com.br' || hostname === 'vardana.com.br') {
    const leilaoIdMatch = parsed.pathname.match(/\/img_leiloes\/(\d+)\//)
    if (leilaoIdMatch) {
      return `${parsed.protocol}//${parsed.hostname}/vardana/veiculos.php?lei=${leilaoIdMatch[1]}`
    }
  }

  // Default: diretório pai do arquivo (mais específico que o root)
  const parentPath = parsed.pathname.split('/').slice(0, -1).join('/') || '/'
  return `${parsed.protocol}//${parsed.hostname}${parentPath}/`
}

export default defineEventHandler(async (event) => {
  const url = String(getQuery(event)['url'] ?? '').trim()
  if (!url) throw createError({ statusCode: 400, message: 'url param required' })

  let parsed: URL
  try { parsed = new URL(url) }
  catch { throw createError({ statusCode: 400, message: 'Invalid URL' }) }

  const hostname = parsed.hostname.replace(/^www\./, '')
  const allowed = ALLOWED_HOSTS.some(h => hostname === h || hostname.endsWith(`.${h}`))
  if (!allowed) throw createError({ statusCode: 403, message: 'Domain not allowed' })

  // Para Vardana, tenta também sem o prefixo /vardana/ caso a URL principal retorne 404
  const altUrls: string[] = [url]
  if ((hostname === 'vardanaleiloes.com.br' || hostname === 'vardana.com.br') && parsed.pathname.startsWith('/vardana/')) {
    altUrls.push(`${parsed.protocol}//${parsed.hostname}${parsed.pathname.replace('/vardana/', '/')}`)
  }

  let response!: Response
  let lastError = ''
  for (const candidate of altUrls) {
    const candidateParsed = candidate === url ? parsed : new URL(candidate)
    const referer = buildReferer(candidateParsed)
    try {
      const r = await fetch(candidate, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Referer': referer,
          'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          'Accept-Language': 'pt-BR,pt;q=0.9',
        },
      })
      if (r.ok) { response = r; break }
      lastError = `HTTP ${r.status}`
    }
    catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }

  if (!response) throw createError({ statusCode: 502, message: `Upstream error: ${lastError}` })
  if (!response.ok) throw createError({ statusCode: response.status, message: 'Upstream returned error' })

  const contentType = response.headers.get('content-type') ?? 'image/jpeg'
  if (!contentType.startsWith('image/')) throw createError({ statusCode: 502, message: 'Upstream did not return an image' })

  setHeader(event, 'Content-Type', contentType)
  setHeader(event, 'Cache-Control', 'public, max-age=86400, stale-while-revalidate=3600')
  setHeader(event, 'X-Content-Type-Options', 'nosniff')

  if (!response.body) throw createError({ statusCode: 502, message: 'No body' })
  return sendStream(event, response.body)
})
