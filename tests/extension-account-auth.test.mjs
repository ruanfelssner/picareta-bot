import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const background = read('../.extension/copart-live-collector/background.js')
const content = read('../.extension/copart-live-collector/content.js')
const manifest = JSON.parse(read('../.extension/copart-live-collector/manifest.json'))
const options = read('../.extension/copart-live-collector/options.html')
const auth = read('../layers/cars/server/utils/live-auction-extension-auth.ts')
const assistant = read('../layers/cars/server/api/vehicles/live-assistant.post.ts')

function pngSize(path) {
  const image = readFileSync(new URL(path, import.meta.url))
  return { width: image.readUInt32BE(16), height: image.readUInt32BE(20) }
}

test('extensão exige conta do Picareta sem carregar segredo compartilhado', () => {
  assert.match(background, /PICARETA_EXTENSION_LOGIN/)
  assert.match(background, /Authorization|authorization/)
  assert.doesNotMatch(background, /DEFAULT_LIVE_AUCTION_EXTENSION_TOKEN/)
  assert.doesNotMatch(content, /x-live-auction-extension-token|x-copart-extension-token/)
  assert.ok(manifest.host_permissions.includes('https://picareta.felss.dev/*'))
})

test('tela de conexão solicita telefone e senha sem persistir a senha', () => {
  assert.match(options, /type="tel"/)
  assert.match(options, /type="password"/)
  assert.doesNotMatch(background, /storage\.local\.set\([\s\S]{0,200}password/)
})

test('login fica no painel e o ícone apenas reabre a máscara na página', () => {
  assert.match(content, /data-role="auth-form"/)
  assert.match(content, /data-role="authenticated-content" hidden/)
  assert.match(background, /PICARETA_EXTENSION_SHOW_PANEL/)
  assert.doesNotMatch(background, /openOptionsPage/)
  assert.ok(content.indexOf('data-role="authenticated-content" hidden') < content.indexOf('data-role="toggle-active"'))
})

test('sessão autenticada fica compacta na mesma linha do título e do botão fechar', () => {
  const headerStart = content.indexOf('<div class="clp-header"')
  const headerEnd = content.indexOf('</div>\n      </div>', headerStart)
  const sessionAt = content.indexOf('data-role="session-panel"', headerStart)
  const closeAt = content.indexOf('data-role="hide"', headerStart)
  assert.ok(headerStart >= 0 && sessionAt > headerStart && closeAt > sessionAt && headerEnd > closeAt)
  assert.equal(content.match(/class="clp-session-panel" data-role="session-panel"/g)?.length, 1)
})

test('usuário comum coleta automaticamente sem exibir a barra administrativa', () => {
  assert.match(content, /state\.active = isAdminSession\(\) \? state\.resumeActiveAfterAuth : true/)
  assert.match(content, /state\.actionBar\.hidden = !authenticated \|\| !isAdminSession\(\)/)
  assert.match(content, /if \(!isAdminSession\(\)\) return/)
})

test('manifesto usa o ícone do aplicativo nos tamanhos exigidos', () => {
  for (const size of [16, 32, 48, 128]) {
    assert.equal(manifest.icons[String(size)], `icons/icon-${size}.png`)
    assert.deepEqual(pngSize(`../.extension/copart-live-collector/icons/icon-${size}.png`), {
      width: size,
      height: size,
    })
  }
  assert.equal(manifest.action.default_icon['16'], 'icons/icon-16.png')
  assert.equal(manifest.action.default_icon['32'], 'icons/icon-32.png')
})

test('backend valida a sessão no Picareta e salva a captura antes da análise', () => {
  assert.match(auth, /\/api\/v1\/auth\/extension\/session/)
  assert.match(auth, /authorization: `Bearer \$\{token\}`/)
  const persistAt = assistant.indexOf('await recordLiveAuctionCapture')
  const analysisAt = assistant.indexOf('const marketAnalysis = buildVehicleMarketAnalysis')
  assert.ok(persistAt >= 0 && analysisAt > persistAt)
})

test('FIPE inferida da base é identificada e não sobrescreve a captura do lote', () => {
  assert.match(content, /allowDatabaseFipeReference: true/)
  assert.match(assistant, /value\['allowDatabaseFipeReference'\] === true/)
  assert.match(assistant, /fipeOrigin:[\s\S]*database_reference/)
  assert.match(content, /assistantVehicle\?\.fipeOrigin === "database_reference"/)
  assert.match(content, /&& !usesDatabaseFipe/)
  assert.match(content, /FIPE de referência/)
})
