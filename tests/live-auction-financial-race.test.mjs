import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const script = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')

function loadAssistantSignature() {
  const window = { addEventListener() {} }
  const context = vm.createContext({
    window,
    URL,
    location: { href: 'https://www.copart.com.br/auctionDashboard?auctionId=10412' },
    console: { info() {}, warn() {} },
    localStorage: { getItem() { return null }, setItem() {} },
  })
  const injected = script.replace('  if (window.top !== window) {', `
    window.getAssistantSignature = getAssistantSignature;
    return;
    if (window.top !== window) {`)

  vm.runInContext(injected, context)
  return window.getAssistantSignature
}

test('primeiro lance renova taxas sem consultar novamente a cada mudança de valor', () => {
  const getAssistantSignature = loadAssistantSignature()
  const lot = {
    source: 'copart',
    auctionId: '10412',
    lot: '66',
    code: '1131066',
    brand: 'ROYAL ENFIELD',
    model: 'Shotgun',
    yearModel: '2026',
    damage: 'Pequena Monta',
    yard: 'Itaquaquecetuba - SP',
    fipe: 31173,
    vehicleUrl: 'https://www.copart.com.br/lot/1131066',
  }

  const beforeBid = getAssistantSignature({ ...lot, bid: null })
  const firstBid = getAssistantSignature({ ...lot, bid: 18000 })
  const nextBid = getAssistantSignature({ ...lot, bid: 18500 })

  assert.notEqual(firstBid, beforeBid, 'a transição sem lance → com lance deve renovar a estrutura de taxas')
  assert.equal(nextBid, firstBid, 'novos valores usam a estrutura já carregada e são recalculados localmente')
})
