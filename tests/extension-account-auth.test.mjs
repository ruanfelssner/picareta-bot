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

test('backend valida a sessão no Picareta e salva a captura antes da análise', () => {
  assert.match(auth, /\/api\/v1\/auth\/extension\/session/)
  assert.match(auth, /authorization: `Bearer \$\{token\}`/)
  const persistAt = assistant.indexOf('await recordLiveAuctionCapture')
  const analysisAt = assistant.indexOf('const marketAnalysis = buildVehicleMarketAnalysis')
  assert.ok(persistAt >= 0 && analysisAt > persistAt)
})
