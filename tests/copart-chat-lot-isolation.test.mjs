import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const content = readFileSync(new URL('../.extension/copart-live-collector/content.js', import.meta.url), 'utf8')

function load() {
  const window = { setTimeout() { return 0 }, clearTimeout() {} }
  const context = vm.createContext({ window, URL, location: new URL('https://www.copart.com.br/leiloes') })
  vm.runInContext(content.replace('  if (window.top !== window) {', `
    window.chat = [];
    window.sent = [];
    getSystemMessages = () => window.chat.map(text => "Sistema: " + text);
    getChatAuditMessageElements = () => window.chat.map(text => ({ textContent: "Sistema: " + text, id: "", getAttribute: () => null }));
    getCurrentPreviewEvent = () => window.snapshot;
    getExtensionVersion = () => "test";
    sendRuntimeMessage = async (message) => {
      window.sent.push(...message.events);
      return { ok: true, body: { stored: message.events.length } };
    };
    window.test = { extractChatState, captureChatAuditMessagesOnce };
    return;
    if (window.top !== window) {`), context)
  return window
}

test('resultado do lote anterior não encerra o lote recém-aberto', () => {
  const window = load()
  window.chat = ['Lote 30 não foi vendido', 'Próximo lote 31']
  const chat = window.test.extractChatState('31')
  assert.equal(chat.finalForCurrentLot, null)
  assert.equal(chat.message, undefined)
  assert.equal(chat.bidRaw, undefined)

  window.chat.push('Lance inicial de R$ 10.000,00', 'Novo lance de R$ 12.000,00 foi recebido')
  assert.match(window.test.extractChatState('31').bidRaw, /12\.000/)
})

test('mensagem repetida em outro lote não é descartada como já vista', async () => {
  const window = load()
  window.snapshot = { source: 'copart', auctionId: '112092', lot: '30', code: '1150000' }
  window.chat = ['Próximo lote 30', 'Incremento alterado para R$ 1.000,00']
  await window.test.captureChatAuditMessagesOnce()

  // O chat recomeça no lote seguinte com o mesmo texto.
  window.snapshot = { source: 'copart', auctionId: '112092', lot: '31', code: '1154188' }
  window.chat = ['Próximo lote 31', 'Incremento alterado para R$ 1.000,00']
  await window.test.captureChatAuditMessagesOnce()

  const increments = window.sent.filter(event => event.rawText === 'Sistema: Incremento alterado para R$ 1.000,00')
  assert.equal(increments.map(event => event.lot).join(','), '30,31')
  assert.equal(new Set(increments.map(event => event.dedupeKey)).size, 2)
})

test('mensagens repetidas no mesmo lote continuam distintas', async () => {
  const window = load()
  window.snapshot = { source: 'copart', auctionId: '112092', lot: '31', code: '1154188' }
  window.chat = ['Próximo lote 31', 'Lote 31 não foi vendido', 'Lote 31 não foi vendido']
  await window.test.captureChatAuditMessagesOnce()
  await window.test.captureChatAuditMessagesOnce()
  assert.equal(window.sent.filter(event => event.kind === 'lot_not_sold').length, 2)
})

test('lote reaberto pelo leiloeiro volta a ficar aberto até o novo resultado', () => {
  const window = load()
  window.chat = [
    'Próximo lote 41',
    'Lote 41 não foi vendido',
    'Próximo lote 40',
    'Novo lance de R$ 5.550,00 foi recebido',
    'Lote 40 vendido por R$ 5.550,00',
    'Próximo lote 41',
    'Novo lance de R$ 13.250,00 foi recebido',
    'Novo lance de R$ 23.750,00 foi recebido',
  ]
  const reopened = window.test.extractChatState('41')
  assert.equal(reopened.finalForCurrentLot, null)
  assert.match(reopened.bidRaw, /23\.750/)

  window.chat.push('Lote 41 vendido por R$ 24.250,00')
  const sold = window.test.extractChatState('41')
  assert.match(sold.finalForCurrentLot.message, /vendido por R\$ 24\.250/)
})

test('lance de outro lote reaberto não é atribuído ao lote atual', () => {
  const window = load()
  window.chat = ['Próximo lote 41', 'Próximo lote 40', 'Novo lance de R$ 5.550,00 foi recebido']
  assert.equal(window.test.extractChatState('41').bidRaw, undefined)
})
