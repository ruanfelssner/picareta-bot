import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { pestanaDate, pestanaHydration, pestanaLotIds, parsePestanaLot, runPestanaScraper, type PestanaMetadata } from '../layers/scrapers/server/utils/sources/pestana.js'
import { PartialScraperResultError } from '../layers/scrapers/server/utils/source-types.js'
import { ACTIVE_AUCTION_SOURCES, SOURCE_META } from '../shared/constants/sources.js'

const fixture = JSON.parse(readFileSync('tests/fixtures/pestana-public-lots.json', 'utf8')) as PestanaMetadata & { lots: Array<Record<string, unknown>> }
const base = () => structuredClone(fixture.lots[0]!)
const metadata = () => structuredClone(fixture)
const seed = () => `<script type="javascript/json" id="__hydrateLeilao">${JSON.stringify(fixture.auctions)}</script><script id="__hydrateLoteCaracteristicaTipo">${JSON.stringify(fixture.characteristicTypes)}</script><script id="__hydrateParceiro">[]</script>`
const log = () => {}

test('extrai Mercedes, BMW e Zeekr de dados públicos reais e mantém URL estável', () => {
  const vehicles = fixture.lots.map(lot => parsePestanaLot(lot, fixture)!)
  assert.deepEqual(vehicles.map(vehicle => [vehicle.brand, vehicle.model, vehicle.year]), [
    ['MERCEDES-BENZ', 'GLS 450 4M', 2022], ['ZEEKR', '7X FLAGSHIP AWD', 2026], ['BMW', '320I M SPORT FLEX', 2024],
  ])
  assert.equal(vehicles[0]!.price, 205800)
  assert.equal(vehicles[0]!.auctionDate?.toISOString(), '2026-10-08T17:00:00.000Z')
  assert.equal(vehicles[0]!.url, 'https://www.pestanaleiloes.com.br/lote/6281/440109')
  assert.equal(vehicles[0]!.auctionUrl, null)
  assert.equal(vehicles[0]!.imageUrls[0], 'https://ged.pestanaleiloes.com.br/ged/20486061.jpg')
  assert.equal(new Set(vehicles[0]!.imageUrls).size, vehicles[0]!.imageUrls.length)
  assert.equal(vehicles[0]!.damage, null)
  assert.equal(vehicles[0]!.fipe, null)
})

test('prioriza características oficiais e localização do bem, preservando monta e comitente', () => {
  const lot = base()
  const assets = lot.bens as Array<Record<string, unknown>>
  assets[0]!.caracteristicas = [
    { tipo: 12345, valor: '2020' }, { nome: 'Mod.', valor: '2021' },
    ...Object.entries({ Marca: 'VW', Modelo: 'Polo TSI', Cidade: 'Curitiba', UF: 'PR', KM: '42.500', Cor: 'Prata', Combustível: 'Flex', Monta: 'Média monta', FIPE: 'R$ 75.500,00' }).map(([nome, valor]) => ({ nome, valor })),
  ]
  lot.parceiro = { id: 111 }
  const vehicle = parsePestanaLot(lot, { ...metadata(), partners: [{ id: 111, nome: 'Comitente de teste' }] })!
  assert.deepEqual([vehicle.brand, vehicle.model, vehicle.year], ['VOLKSWAGEN', 'Polo TSI', 2021])
  assert.deepEqual([vehicle.city, vehicle.state, vehicle.yard], ['Curitiba', 'PR', 'Curitiba - PR'])
  assert.equal(vehicle.damage, 'Média monta')
  assert.equal(vehicle.consignor, 'Comitente de teste')
  assert.equal(vehicle.fipe, 75500)
  assert.equal(vehicle.km, '42.500')
})

test('não infere localização a partir do endereço geral do leiloeiro', () => {
  const data = metadata()
  data.auctions[0]!.local = { endereco: 'Porto Alegre - RS' }
  const vehicle = parsePestanaLot(base(), data)!
  assert.equal(vehicle.city, null)
  assert.equal(vehicle.state, null)
})

test('separa lance inicial, lance atual e arremate; condicional/repasse não são vendido', () => {
  const lot = base()
  lot.valor = 220000
  assert.equal(parsePestanaLot(lot, fixture)!.price, 220000)
  for (const [status, saleStatus] of [['Vendido', 'sold'], ['Condicional', 'conditional'], ['Não vendido', 'not_sold'], ['Aguardando repasse', 'unknown']]) {
    lot.status = status
    const vehicle = parsePestanaLot(lot, fixture)!
    assert.equal(vehicle.saleStatus, saleStatus)
    assert.equal(vehicle.soldPrice, saleStatus === 'sold' ? 220000 : null)
  }
  lot.status = 'Vendido'
  lot.valor = 0
  assert.equal(parsePestanaLot(lot, fixture)!.soldPrice, null)
  lot.status = null
  lot.situacaoId = 3
  assert.equal(parsePestanaLot(lot, fixture)!.saleStatus, 'sold')
})

test('datas usam Brasília, preservam offset e não inventam horário/encerramento', () => {
  assert.equal(pestanaDate('2026-10-08T14:00:00').date?.toISOString(), '2026-10-08T17:00:00.000Z')
  assert.equal(pestanaDate('2026-10-08T14:00:00Z').date?.toISOString(), '2026-10-08T14:00:00.000Z')
  assert.equal(pestanaDate('2026-10-08').timeKnown, false)
  for (const value of ['2026-02-31', 'amanhã', '', null]) assert.equal(pestanaDate(value).date, null)
  const data = metadata()
  data.auctions[0]!.exibirData = false
  const vehicle = parsePestanaLot(base(), data)!
  assert.equal(vehicle.auctionDate, null)
  assert.equal(vehicle.auctionTimeKnown, false)
  assert.equal(vehicle.auctionEndsAt, null)
})

test('ignora imóveis, lotes ocultos e leilões privados, sem descartar bundles de veículos', () => {
  const lot = base()
  lot.visivel = false
  assert.equal(parsePestanaLot(lot, fixture), null)
  lot.visivel = true
  const data = metadata()
  data.auctions[0]!.privado = true
  assert.equal(parsePestanaLot(lot, data), null)
  const assets = lot.bens as Array<Record<string, unknown>>
  assets[0]!.tipoBem = { id: 462 }
  assert.equal(parsePestanaLot(lot, fixture), null)
})

test('valida schema da busca, deduplica IDs e não interpreta erro como vazio', () => {
  assert.deepEqual(pestanaLotIds({ lotes: [1, 2, 1] }), [1, 2])
  assert.deepEqual(pestanaLotIds({ lotes: [] }), [])
  assert.throws(() => pestanaLotIds({ error: 'bloqueado' }))
  assert.throws(() => pestanaLotIds({ lotes: [{ id: 1 }] }))
  assert.equal(pestanaHydration('<script id="__hydrateLeilao">[]</script>', '__hydrateLeilao') instanceof Array, true)
  assert.throws(() => pestanaHydration('<script id="__hydrateLeilao">invalid</script>', '__hydrateLeilao'))
})

test('busca todos os IDs e detalhes além dos 12 cards, em blocos deduplicados', async () => {
  const lots = Array.from({ length: 25 }, (_, index) => ({ ...base(), id: 500000 + index }))
  const calls: Array<{ path: string; body: unknown }> = []
  const emitted: string[] = []
  const fetcher: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname
    const body = options?.body ? JSON.parse(String(options.body)) as { ids?: number[]; tipoBem?: number[] } : undefined
    calls.push({ path, body })
    if (path === '/procurar-bens') return new Response(seed() + '<a href="/6281/aovivo">Sala</a><a href="https://evil.test/6281/aovivo">Falso</a>')
    if (path === '/search-api/lote/filtrar') return Response.json({ lotes: [...lots.map(lot => lot.id), lots[0]!.id] })
    return Response.json(lots.filter(lot => body?.ids?.includes(lot.id)))
  }
  const vehicles = await runPestanaScraper({ log, onVehicle: vehicle => { emitted.push(vehicle.url) } }, fetcher)
  assert.equal(vehicles.length, 25)
  assert.equal(emitted.length, 25)
  assert.deepEqual(calls[1]!.body, { tipoBem: [421] })
  assert.deepEqual(calls.slice(2).map(call => (call.body as { ids: number[] }).ids.length), [24, 1])
  assert.equal(vehicles[0]!.auctionUrl, 'https://www.pestanaleiloes.com.br/6281/aovivo')
})

test('CAPTCHA com HTTP 200 é erro explícito, sem coleta vazia ou fallback para destaques', async () => {
  await assert.rejects(runPestanaScraper({ log }, async () => new Response('<title>Radware Captcha Page</title>')), /CAPTCHA/)
  await assert.rejects(runPestanaScraper({ log }, async () => new Response('<html>erro</html>')), /Resposta inválida/)
})

test('lote faltante preserva dados parciais com erro; aborto não continua emitindo', async () => {
  let count = 0
  const fetcher: typeof fetch = async () => {
    count++
    return count === 1 ? new Response(seed()) : count === 2 ? Response.json({ lotes: [440109, 439923] }) : Response.json([base()])
  }
  await assert.rejects(runPestanaScraper({ log }, fetcher), (error: unknown) => error instanceof PartialScraperResultError && error.vehicles.length === 1 && /incompleta/.test(error.message))
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runPestanaScraper({ log, signal: controller.signal }, async () => { throw new Error('não deveria chamar') }), /abort/i)
})

test('fonte está disponível no catálogo canônico do bot', () => {
  assert.ok(ACTIVE_AUCTION_SOURCES.includes('pestana'))
  assert.equal(SOURCE_META.pestana.name, 'Pestana Leilões')
})
