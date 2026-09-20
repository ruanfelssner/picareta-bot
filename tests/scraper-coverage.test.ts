import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesAuctionVehicleGeoFilters } from '../src/location-filter.js';
import { DEFAULT_COPART_CATEGORIES, buildCopartSearchPostBody, parseCopartSaleTarget } from '../src/scrapers/copart.js';
import { extractSodreLocation, type SodreItem } from '../src/scrapers/sodre.js';

test('reconhece o formato atual e próximo da lista de vendas Copart', () => {
  const target = parseCopartSaleTarget(
    '/salesListResult/saleListResult/10451/2026-09-22?location=Curitiba+-+PR&saleDate=1790096400000&yardNum=53',
    '22.09.2026',
    ['PR'],
  );

  assert.equal(target?.miscFilter, 'auction_id:10451');
  assert.equal(target?.location, 'Curitiba - PR');
});

test('mantém o filtro de UF ao descobrir leilões Copart', () => {
  const target = parseCopartSaleTarget(
    '/salesListResult/saleListResult/10451/2026-09-22?location=Curitiba+-+PR&yardNum=53',
    '22.09.2026',
    ['SP'],
  );

  assert.equal(target, null);
});

test('inclui picapes grandes na consulta da Copart', () => {
  const body = buildCopartSearchPostBody('auction_id:10451', [
    ...DEFAULT_COPART_CATEGORIES,
  ]);

  assert.match(body.get('filter[categoria]') ?? '', /Picapes Grandes/);
});

test('combina cidade e estado retornados pela Sodré', () => {
  const location = extractSodreLocation({
    lot_city: 'Guarulhos',
    lot_state: 'São Paulo',
    lot_location: 'Pátio Guarulhos',
    lot_description: 'Veículo disponível para visitação.',
  } as unknown as SodreItem);

  assert.equal(location.city, 'Guarulhos');
  assert.equal(location.state, 'SP');
  assert.match(location.yard ?? '', /SP/);
});

test('infere SP para pátio Sodré em Guarulhos e aplica o filtro geográfico', () => {
  const location = extractSodreLocation({
    lot_location: 'Guarulhos',
    lot_description: 'Local do lote: Guarulhos',
  } as unknown as SodreItem);

  assert.equal(location.state, 'SP');
  assert.equal(matchesAuctionVehicleGeoFilters({
    source: 'sodre',
    brand: 'BMW',
    model: '320i',
    year: 2020,
    damage: null,
    price: null,
    priceRaw: null,
    imageUrls: [],
    description: 'Sem localização adicional',
    url: 'https://leilao.sodresantoro.com.br/leilao/1/lote/2/',
    auctionDate: null,
    yard: location.yard,
    city: location.city,
    state: location.state,
  }, { states: ['SP'] }), true);
});
