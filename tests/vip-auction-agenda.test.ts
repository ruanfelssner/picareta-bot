import assert from 'node:assert/strict'
import test from 'node:test'
import { collectVipAuctionAgenda, parseVipAgendaPage, parseVipLotPage } from '../layers/scrapers/server/utils/vip-auction-agenda'

const eventCard = (id: string, states = 'SP-PR-RS', name = 'Seguradoras e Particulares', date = '07/10/2026 10:00', closed = false) => `
<div class="card card-evento evento-${closed ? 'Encerrado' : 'Aberto'}">
<a class="card-body" href="/evento/detalhes/${id}"><h1>${name}</h1>
<div class="carousel-card-evento"><img alt="Outra região SP" /></div>
<div class="anc-row"><span><i></i>In&#xED;cio</span><span>${date}</span></div>
<div class="anc-row"><span>Lotes</span><span>95</span></div>
<div class="anc-row"><span>Estados</span><span>${states}</span></div></a></div>`
const pagination = (path: string, next = 2, disabled = false) => `<li class="page-item ${disabled ? 'disabled' : ''}"><a aria-label="Next" data-ajax-url="${path}?pageNumber=${next}&amp;handler=pesquisar">Próximo</a></li>`
const agenda = (cards: string, links = '') => `<input id="CurrentPage" value="1" />${cards}<ul>${links}</ul>`
const lotPage = (slugs: string[], links = '') => `<input id="totalAnuncios" value="${slugs.length}" />${slugs.map(slug => `<div class="card card-anuncio"><a href="/evento/anuncio/${slug}">Carro</a><strong>Local:</strong> PR</div>`).join('')}<ul>${links}</ul>`
const form = `<form id="formPost"><input type="hidden" name="Filtro.EventoId" value="uuid-oficial" /><input type="hidden" name="Filtro.CurrentPage" value="1" /><input type="hidden" name="__RequestVerificationToken" value="token-publico" /></form>`

test('VIP mantém um evento multirregional com PR e ignora SP/SC/estados não informados', () => {
  const parsed = parseVipAgendaPage(agenda(eventCard('071026bsgo') + eventCard('071026bsgo') + eventCard('071026bspa', 'SP-SC') + eventCard('081026', 'Não Informado')))
  assert.equal(parsed.events.length, 1)
  assert.deepEqual(parsed.events[0], {
    auctionId: '071026bsgo', label: 'Seguradoras e Particulares',
    url: 'https://www.vipleiloes.com.br/eventoonline/071026bsgo',
    startsAt: '2026-10-07T13:00:00.000Z', timeKnown: true,
    locationStates: ['SP', 'PR', 'RS'], lotCount: 95, officialClosed: false,
  })
})

test('eventos simultâneos distintos permanecem separados e nomes com entidades são decodificados', () => {
  const parsed = parseVipAgendaPage(agenda(eventCard('evento1', 'PR', 'SESC &amp; Paran&#225;') + eventCard('evento2', 'PR', 'Outro evento')))
  assert.equal(parsed.events.length, 2)
  assert.equal(parsed.events[0]?.label, 'SESC & Paraná')
})

test('paginação desabilitada não inventa páginas adicionais da agenda ou do catálogo', () => {
  assert.equal(parseVipAgendaPage(agenda(eventCard('evento1'), pagination('/agenda', 2, true))).pages, 1)
  assert.equal(parseVipAgendaPage(agenda(eventCard('evento1'), pagination('/agenda', 2))).pages, 2)
  assert.equal(parseVipLotPage(lotPage(['carro'], pagination('/evento/detalhes/evento1', 2, true))).nextPage, null)
  assert.equal(parseVipLotPage(lotPage(['carro'], pagination('/evento/detalhes/evento1', 2))).nextPage, 2)
})

test('VIP não inventa hora ausente e respeita encerramento oficial', () => {
  const item = parseVipAgendaPage(agenda(eventCard('evento1', 'PR', 'Evento', '07/10/2026', true))).events[0]!
  assert.equal(item.timeKnown, false)
  assert.equal(item.startsAt, '2026-10-07T03:00:00.000Z')
  assert.equal(item.officialClosed, true)
  assert.throws(() => parseVipAgendaPage(agenda(eventCard('evento1', 'PR', 'Evento', '31/02/2026 10:00'))))
})

test('VIP rejeita página de login, erro ou catálogo incompleto, sem assumir zero favoritos', () => {
  assert.throws(() => parseVipAgendaPage('<html><h1>Entrar</h1></html>'))
  assert.throws(() => parseVipLotPage('<html>Erro 400</html>'))
  assert.throws(() => parseVipLotPage(lotPage(['carro']).replace('Local:</strong> PR', 'Local:</strong> SP')))
  assert.throws(() => parseVipLotPage(lotPage(['carro']).replace('value="1"', 'value="2"')))
})

test('coleta agenda paginada e todos os lotes PR com cookies públicos e POST', async () => {
  const requested: string[] = []
  let warmup = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requested.push(`${init?.method} ${url.pathname}${url.search}`)
    const headers = new Headers(init?.headers)
    if (url.pathname === '/agenda' && !url.search) {
      if (!warmup) { warmup = true; return new Response(null, { status: 302, headers: { location: '/agenda', 'set-cookie': 'canal=publico; Path=/' } }) }
      assert.equal(headers.get('Cookie'), 'canal=publico')
      return new Response('<html>Agenda</html>')
    }
    if (url.pathname === '/agenda') {
      assert.equal(init?.method, 'POST')
      const page = url.searchParams.get('pageNumber')
      return new Response(page === '1' ? agenda(eventCard('evento1'), pagination('/agenda')) : agenda(eventCard('sp-only', 'SP'), pagination('/agenda', 3, true)))
    }
    if (init?.method === 'GET') return new Response(form)
    const body = new URLSearchParams(String(init?.body))
    assert.equal(body.get('Filtro.LocalEstadoId'), 'PR')
    assert.equal(body.get('__RequestVerificationToken'), 'token-publico')
    assert.equal(body.get('Filtro.CurrentPage'), '1')
    return new Response(body.get('pageNumber') === '1' ? lotPage(['carro1'], pagination(url.pathname)) : lotPage(['carro2'], pagination(url.pathname, 3, true)))
  }
  const result = await collectVipAuctionAgenda(fetcher)
  assert.equal(result.truncated, false)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0]?.lotCountPr, 2)
  assert.equal(result.events[0]?.memberLotUrls?.length, 2)
  assert.equal(requested.filter(url => url.includes('/agenda?pageNumber=')).length, 2)
  assert.equal(requested.filter(url => url.includes('pageNumber=3')).length, 0)
})

test('falha no catálogo preserva o evento e deixa a contagem PR desconhecida', async () => {
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === '/agenda') return new Response(init?.method === 'POST' ? agenda(eventCard('evento1')) : '<html>Agenda</html>')
    return new Response('<html>Indisponível</html>')
  }
  const result = await collectVipAuctionAgenda(fetcher)
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0]?.memberLotUrls, undefined)
  assert.equal(result.events[0]?.lotCountPr, undefined)
})

test('coleta recusa redirecionamento para outro domínio', async () => {
  await assert.rejects(() => collectVipAuctionAgenda(async () => new Response(null, { status: 302, headers: { location: 'https://other.example/agenda' } })), /domínio oficial/)
})
