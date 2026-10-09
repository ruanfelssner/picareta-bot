import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function loadModule(path, imports = {}) {
  const exports = {}
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  vm.runInNewContext(code, {
    exports, Date, Set,
    console: { info() {}, error() {} },
    require(id) {
      assert.ok(Object.hasOwn(imports, id), `Importação não simulada: ${id}`)
      return imports[id]
    },
  })
  return exports
}

const fees = loadModule('../shared/utils/auction-fees.ts')

function delivery({ saleStatus = 'not_sold', price = 15500, favorite = true, fail = false } = {}) {
  const doc = {
    _id: 'vehicle-1', source: 'sodre', brand: 'Volkswagen', model: 'POLO 1.6', year: 2011,
    saleStatus, price, soldPrice: saleStatus === 'sold' ? price : null, fipe: 30000,
    url: 'https://leilao.sodresantoro.com.br/leilao/29127/lote/2812478/', imageUrls: [],
  }
  const sent = []
  const state = { fail }
  const VehicleModel = {
    db: { db: { collection: () => ({ find: () => ({ toArray: async () => favorite
      ? [{ userId: 'user-1', opportunityId: doc._id }] : [] }) }) } },
    findById: () => ({ lean: async () => ({ ...doc }) }),
    find: () => ({ limit: () => ({ lean: async () => [{ _id: doc._id }] }) }),
    collection: {
      async updateOne(filter, update) {
        const key = filter.favoriteResultSharedKey
        if (typeof key === 'object' && doc.favoriteResultSharedKey === key.$ne) return { modifiedCount: 0 }
        if (typeof key === 'string' && doc.favoriteResultSharedKey !== key) return { modifiedCount: 0 }
        Object.assign(doc, update.$set)
        for (const field of Object.keys(update.$unset ?? {})) delete doc[field]
        return { modifiedCount: 1 }
      },
    },
  }
  const api = loadModule('../layers/cars/server/utils/favorite-lot-result.ts', {
    '#shared/constants/sources': { SOURCE_META: { sodre: { name: 'Sodré Santoro' } } },
    '#shared/utils/auction-fees': fees,
    './vehicle-market-analysis': { loadMarketHistory: async () => [], buildVehicleMarketAnalysis: () => null },
    './schemas/vehicle': { VehicleModel },
    './zapi': { sendVehicleToZApi: async (vehicle, caption) => {
      sent.push({ vehicle, caption })
      return state.fail ? { ok: false, reason: 'Falha simulada' } : { ok: true }
    } },
    './picareta-sync': { createPicaretaShortLink: async () => 'https://felssner.com.br/l/teste' },
  })
  return { doc, sent, state, share: observedAt => api.shareFavoriteLotResultIfNeeded(doc._id, observedAt ?? new Date()) }
}

test('favorito não vendido envia resultado com último lance e legenda correta', async () => {
  const d = delivery()
  assert.equal(await d.share(), 'shared')
  assert.equal(d.sent.length, 1)
  assert.match(d.sent[0].caption, /FAVORITO NÃO VENDIDO/)
  assert.match(d.sent[0].caption, /Último lance: R\$ 15\.500/)
  assert.doesNotMatch(d.sent[0].caption, /Vendido por|Lance condicional/)
  assert.equal(d.doc.favoriteResultSharedKey, 'not_sold:15500')
})

test('favorito não vendido sem lance também avisa sem inventar valores ou taxas', async () => {
  for (const price of [null, 0]) {
    const d = delivery({ price })
    assert.equal(await d.share(), 'shared')
    assert.match(d.sent[0].caption, /FAVORITO NÃO VENDIDO/)
    assert.match(d.sent[0].caption, /Sem lance registrado/)
    assert.doesNotMatch(d.sent[0].caption, /Taxas:|Total com taxas:|Margem:/)
    assert.equal(d.doc.favoriteResultSharedKey, 'not_sold:0')
  }
})

test('vendido e condicional preservam o envio e exigem lance positivo', async () => {
  for (const saleStatus of ['sold', 'conditional']) {
    const d = delivery({ saleStatus })
    assert.equal(await d.share(), 'shared')
    assert.match(d.sent[0].caption, saleStatus === 'sold' ? /FAVORITO VENDIDO/ : /FAVORITO CONDICIONAL/)
    const unpriced = delivery({ saleStatus, price: null })
    assert.equal(await unpriced.share(), 'skipped')
    assert.equal(unpriced.sent.length, 0)
  }
})

test('resultado repetido ou simultâneo de favorito não gera mensagem duplicada', async () => {
  const d = delivery()
  const results = await Promise.all([d.share(), d.share()])
  assert.deepEqual(results.sort(), ['shared', 'skipped'])
  assert.equal(await d.share(), 'skipped')
  assert.equal(d.sent.length, 1)
})

test('mudança posterior para vendido envia a nova situação', async () => {
  const d = delivery()
  assert.equal(await d.share(), 'shared')
  d.doc.saleStatus = 'sold'
  d.doc.soldPrice = 16000
  assert.equal(await d.share(), 'shared')
  assert.equal(d.sent.length, 2)
  assert.match(d.sent[1].caption, /FAVORITO VENDIDO/)
  assert.equal(d.doc.favoriteResultSharedKey, 'sold:16000')
})

test('não favorito, resultado não final e captura antiga não enviam', async () => {
  for (const options of [{ favorite: false }, { saleStatus: 'open' }, { saleStatus: 'unknown' }]) {
    const d = delivery(options)
    assert.equal(await d.share(), 'skipped')
    assert.equal(d.sent.length, 0)
  }
  const stale = delivery()
  assert.equal(await stale.share(new Date(Date.now() - 31 * 60 * 1000)), 'skipped')
  assert.equal(stale.sent.length, 0)
})

test('falha de envio libera a trava para nova tentativa no próximo salvamento', async () => {
  const d = delivery({ fail: true })
  assert.equal(await d.share(), 'failed')
  assert.equal(d.doc.favoriteResultSharedKey, undefined)
  d.state.fail = false
  assert.equal(await d.share(), 'shared')
  assert.equal(d.doc.favoriteResultSharedKey, 'not_sold:15500')
})
