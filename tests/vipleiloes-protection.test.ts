import assert from 'node:assert/strict'
import test from 'node:test'
import {
  looksLikeVipCloudflareChallenge,
  looksLikeVipListingPageHtml,
} from '../shared/utils/vip-protection.js'

test('aceita a página normal da VIP com o script precursor da Cloudflare', () => {
  const html = `
    <html>
      <body>
        <form id="formPost">
          <select name="Filtro.Classificacao"></select>
        </form>
        <script>
          const script = document.createElement('script')
          script.src = '/cdn-cgi/challenge-platform/scripts/precursor/main.js'
        </script>
      </body>
    </html>
  `

  assert.equal(looksLikeVipListingPageHtml(html), true)
  assert.equal(looksLikeVipCloudflareChallenge(html), false)
})

test('aceita fragmento de resultados da VIP mesmo com marcador da Cloudflare', () => {
  const html = `
    <h3 id="resultadosEncontrados">323 resultados encontrados</h3>
    <div class="card card-anuncio"></div>
    <script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script>
  `

  assert.equal(looksLikeVipCloudflareChallenge(html), false)
})

test('detecta uma página real de challenge pelo texto visível', () => {
  const html = `
    <html>
      <head><title>Just a moment...</title></head>
      <body><div id="challenge-stage"></div></body>
    </html>
  `

  assert.equal(looksLikeVipListingPageHtml(html), false)
  assert.equal(looksLikeVipCloudflareChallenge(html), true)
})

test('não considera o script precursor isolado como bloqueio', () => {
  const html = '<script src="/cdn-cgi/challenge-platform/scripts/precursor/main.js"></script>'

  assert.equal(looksLikeVipCloudflareChallenge(html), false)
})

test('detecta challenge estrutural da Cloudflare sem depender do título', () => {
  const html = `
    <script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1"></script>
    <form id="challenge-form"><div class="cf-chl-widget"></div></form>
  `

  assert.equal(looksLikeVipCloudflareChallenge(html), true)
})
