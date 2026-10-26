import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { palacioListing, palacioListForm, parsePalacioLot, runPalacioScraper } from '../layers/scrapers/server/utils/sources/palacio.js'
import { PartialScraperResultError } from '../layers/scrapers/server/utils/source-types.js'
import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '../shared/constants/sources.js'

const fixture = (name: string) => readFileSync(`tests/fixtures/palacio-public-${name}.html`, 'utf8')
const list = fixture('list'), html = fixture('lot'), imported = fixture('import')
const lot = palacioListing(list).lots[0]!
const quiet = () => {}
const empty = (total = 0) => `<input id="total_lotes" value="${total}"><div class="resultados-lotes"></div>`
const single = list.replace('value="506"', 'value="1"')

test('Palácio interpreta amostra real, ano-modelo, endereço do bem e fotos sem confundir previsão com pregão', () => {
  const car = parsePalacioLot(lot, html)
  assert.deepEqual([car.brand, car.model, car.year], ['FIAT', 'MOBI WAY', 2017])
  assert.equal(car.price, 11500)
  assert.equal(car.saleStatus, 'unknown')
  assert.equal(car.soldPrice, null)
  assert.equal(car.auctionDate?.toISOString(), '2026-10-26T03:00:00.000Z')
  assert.equal(car.auctionTimeKnown, false)
  assert.equal(car.auctionUrl, null)
  assert.equal(car.damage, 'pequena monta')
  assert.equal(car.city, 'Juatuba')
  assert.equal(car.state, 'MG')
  assert.equal(car.consignor, 'Bradesco Seguros')
  assert.equal(car.km, '107.584')
  assert.equal(car.fipe, null)
  assert.equal(car.imageUrls.length, 12)
  assert.ok(car.imageUrls.every(url => url.startsWith('https://www.palaciodosleiloes.com.br/site/imagens_lote/')))
  assert.match(car.description, /COLISÃO/)
  assert.match(car.description, /Despesas do lote: R\$ 2480,00/)
  assert.ok(ACTIVE_AUCTION_SOURCES.includes('palacio'))
  assert.equal(SOURCE_META.palacio.name, 'Palácio dos Leilões')
})

test('Palácio normaliza importados reais e não usa o local do pregão como pátio', () => {
  const car = parsePalacioLot({ ...lot, id: '1584702', lot: '732' }, imported)
  assert.deepEqual([car.brand, car.model, car.year], ['CHEVROLET', 'SONIC LTZ HB AT', 2012])
  assert.equal(car.damage, 'media monta')
  const withoutYard = html.replace(/<tr><td nowrap="">Lote<\/td><td>Br 262.*?<\/tr>/, '')
  assert.equal(parsePalacioLot(lot, withoutYard).yard, null)
})

test('Palácio: casos sintéticos de inicial, preço ausente e sucata não confirmam arremate', () => {
  const initial = html.replace('Lance atual', 'Lance inicial').replace('pequena monta', 'sucata (grande monta)')
  const car = parsePalacioLot(lot, initial)
  assert.equal(car.price, 11500)
  assert.equal(car.soldPrice, null)
  assert.equal(car.saleStatus, 'unknown')
  assert.equal(car.damage, 'sucata')
  assert.equal(parsePalacioLot(lot, initial.replace('>11.500,00<', '>0,00<')).price, null)
  assert.throws(() => parsePalacioLot({ ...lot, id: '99' }, html), /Identidade/)
})

test('Palácio reconhece amostras reais de bem em construção e preparação sem foto', () => {
  const future = parsePalacioLot({ ...lot, id: '1584850', auctionId: '8867', lot: null }, fixture('future'))
  assert.deepEqual([future.brand, future.model, future.year], ['CHEVROLET', 'AGILE LT', 2011])
  assert.equal(future.lot, null)
  assert.equal(future.auctionStatus, 'future')
  assert.equal(future.price, 7222.8)
  assert.equal(future.soldPrice, null)
  assert.equal(future.state, 'BA')
  assert.equal(future.city, null) // Card diz Salvador; endereço publicado diz Simões Filho.
  const preparation = { ...lot, id: '1584793', auctionId: '8867', lot: null, card: '<img src="images/preparacao.webp">' }
  const car = parsePalacioLot(preparation, fixture('preparation'))
  assert.equal(car.auctionStatus, 'future')
  assert.deepEqual(car.imageUrls, [])
  assert.equal(car.lot, null)
  assert.throws(() => parsePalacioLot({ ...preparation, card: '' }, fixture('preparation')), /Galeria/)
})

test('Palácio usa o título da listagem identificada quando o cadastro em construção ainda está vazio', () => {
  const uncatalogued = palacioListing(fixture('uncatalogued-list')).lots[0]!
  const car = parsePalacioLot(uncatalogued, fixture('uncatalogued'))
  assert.deepEqual([car.brand, car.model, car.year], ['FORD', 'F-4000 TURBO MWM', null])
  assert.equal(car.auctionId, '8870')
  assert.equal(car.auctionStatus, 'future')
  assert.equal(car.price, null)
  assert.equal(car.soldPrice, null)
})

test('Palácio percorre páginas curtas até o fim confirmado e deduplica emissões', async () => {
  const offsets: string[] = [], emitted: string[] = []
  const result = await runPalacioScraper({ log: quiet, onVehicle: async car => { emitted.push(car.url) } }, async (_url, options) => {
    const form = options?.form
    if (form?.opcao === 'listar_lote') {
      offsets.push(form.paginacao!)
      assert.equal(form.subcategoria_pesquisa, '1,3,209')
      return form.paginacao === '0' ? single.replace('</div>\n', `${lot.card}</div>\n`) : empty(1)
    }
    return form?.opcao === 'verificar_contrato' ? '1' : html
  })
  assert.deepEqual(offsets, ['0', '8'])
  assert.equal(result.length, 1)
  assert.equal(emitted.length, 1)
  assert.equal(palacioListForm(3).paginacao, '24')
})

test('Palácio rejeita bloqueios HTTP 200, layout desconhecido e vazio prematuro', async () => {
  for (const response of ['<title>Acesso bloqueado</title>', '<div class="g-recaptcha"></div>', '<title>Vercel Security Checkpoint</title>', '<html>Erro</html>', empty(5)]) {
    await assert.rejects(runPalacioScraper({ log: quiet }, async () => response))
  }
  assert.deepEqual(await runPalacioScraper({ log: quiet }, async () => empty()), [])
})

test('Palácio visita três páginas, inclusive página curta, e aguarda cada consumidor', async () => {
  const offsets: number[] = [], emitted: string[] = []
  let callbackPending = false
  const cars = await runPalacioScraper({ log: quiet, onVehicle: async car => {
    assert.equal(callbackPending, false)
    callbackPending = true
    await new Promise(resolve => setTimeout(resolve, 1))
    emitted.push(car.url)
    callbackPending = false
  } }, async (_url, options) => {
    assert.equal(callbackPending, false)
    const form = options!.form!
    if (form.opcao === 'listar_lote') {
      const offset = Number(form.paginacao)
      offsets.push(offset)
      const ids = offset === 0 ? [1, 2, 3, 4, 5, 6, 7, 8] : offset === 8 ? [9, 10] : offset === 16 ? [11, 12, 13, 14, 15, 16, 17] : []
      return `<input id="total_lotes" value="17"><div class="resultados-lotes">${ids.map(id => lot.card.replaceAll('1583867', String(id))).join('')}</div>`
    }
    return form.opcao === 'verificar_contrato' ? '1' : html.replaceAll('1583867', form.cod_lote!)
  })
  assert.deepEqual(offsets, [0, 8, 16, 24])
  assert.equal(cars.length, 17)
  assert.equal(new Set(emitted).size, 17)
})

test('Palácio preserva parcial em repetição, mudança de estoque, detalhe perdido e erro HTTP', async () => {
  for (const failure of ['repeat', 'changed', 'detail', 'http'] as const) {
    let count = 0
    await assert.rejects(runPalacioScraper({ log: quiet }, async (_url, options) => {
      if (options?.form?.opcao === 'listar_lote') {
        if (!count++) return single
        if (failure === 'repeat') return single
        if (failure === 'changed') return empty(2)
        if (failure === 'http') throw new Error('HTTP 503')
        return single.replaceAll('1583867', '1583868')
      }
      if (options?.form?.opcao === 'verificar_contrato') return '1'
      return html
    }), error => error instanceof PartialScraperResultError && error.vehicles.length === 1)
  }
})

test('Palácio continua após detalhe indisponível e entrega os demais como parcial', async () => {
  const emitted: string[] = []
  const listing = `<input id="total_lotes" value="2"><div class="resultados-lotes">${lot.card}${lot.card.replaceAll('1583867', '1583868')}</div>`
  await assert.rejects(runPalacioScraper({ log: quiet, onVehicle: car => { emitted.push(car.url) } }, async (_url, options) => {
    const form = options!.form!
    if (form.opcao === 'listar_lote') return form.paginacao === '0' ? listing : empty(2)
    if (form.opcao === 'verificar_contrato') return '1'
    if (form.cod_lote === '1583867') throw new Error('HTTP 500')
    return html.replaceAll('1583867', '1583868')
  }), error => error instanceof PartialScraperResultError && error.vehicles.length === 1 && error.vehicles[0]?.url.endsWith('1583868') === true)
  assert.equal(emitted.length, 1)
  assert.ok(emitted[0]?.endsWith('1583868'))
})

test('Palácio propaga cancelamento, timeout e falha do consumidor; não aceita contrato/login', async () => {
  const controller = new AbortController()
  controller.abort(new Error('cancelado'))
  let calls = 0
  await assert.rejects(runPalacioScraper({ signal: controller.signal, log: quiet }, async () => { calls++; return single }), /cancelado/)
  assert.equal(calls, 0)
  await assert.rejects(runPalacioScraper({ log: quiet }, async () => { throw new Error('timeout') }), /timeout/)
  for (const access of ['0', '2', '3', '<form>Login</form>']) {
    await assert.rejects(runPalacioScraper({ log: quiet }, async (_url, options) => options?.form?.opcao === 'listar_lote' ? single : access), /acesso\/contrato/)
  }
  await assert.rejects(runPalacioScraper({ log: quiet, onVehicle: () => { throw new Error('persistência falhou') } }, async (_url, options) => {
    if (options?.form?.opcao === 'listar_lote') return single
    return options?.form?.opcao === 'verificar_contrato' ? '1' : html
  }), /persistência falhou/)
})
