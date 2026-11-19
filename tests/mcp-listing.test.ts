import assert from 'node:assert/strict'
import test from 'node:test'
import { dedupeByUrl, escapeRegex, extractOemCode, httpsUrl, parseBrlPrice, stripHtml } from '../server/mcp/listing'

test('parseBrlPrice lê o primeiro valor em reais', () => {
  assert.equal(parseBrlPrice('R$ 1.200'), 1200)
  assert.equal(parseBrlPrice('R$1.200,50'), 1200.5)
  assert.equal(parseBrlPrice('R$ 300R$ 450'), 300)
  assert.equal(parseBrlPrice('Grátis'), null)
  assert.equal(parseBrlPrice(null), null)
})

test('extractOemCode só reconhece códigos com rótulo explícito', () => {
  assert.equal(extractOemCode('Farol Gol G5 cód. 5U0941007 original'), '5U0941007')
  assert.equal(extractOemCode('Lanterna OEM: 81550-02A10'), '81550-02A10')
  assert.equal(extractOemCode('Part number 13301234 retrovisor'), '13301234')
  assert.equal(extractOemCode('Gol 2012 1.0 120.000 km'), null)
  assert.equal(extractOemCode('Jogo de pneu aro 15 refil cód 5U0 601 025'), '5U0 601 025')
  assert.equal(extractOemCode(null, 'sem código', 'Ref: 6Q0 615 301'), '6Q0 615 301')
})

test('utilitários de texto e URL', () => {
  assert.equal(escapeRegex('gol (g5)+'), 'gol \\(g5\\)\\+')
  assert.equal(stripHtml('<strong>Farol</strong> &amp; lanterna'), 'Farol & lanterna')
  assert.equal(httpsUrl('http://http2.mlstatic.com/a.jpg'), 'https://http2.mlstatic.com/a.jpg')
  assert.equal(httpsUrl('javascript:alert(1)'), null)
  assert.deepEqual(dedupeByUrl([{ url: 'https://a.com/x/' }, { url: 'https://A.com/x' }, { url: 'https://a.com/y' }]).length, 2)
})
