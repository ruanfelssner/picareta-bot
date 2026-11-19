import assert from 'node:assert/strict'
import test from 'node:test'
import { toSearchConfigOverride } from '../src/commands/web-search'
import { normalizeMarketplaceLocation, normalizeMarketplaceSearchOptions } from '../shared/utils/marketplace-search-options'

test('opções do Marketplace são sanitizadas antes de chegar ao worker', () => {
  assert.equal(normalizeMarketplaceSearchOptions(null), null)
  assert.equal(normalizeMarketplaceSearchOptions({}), null)
  assert.deepEqual(
    normalizeMarketplaceSearchOptions({ locationId: 'São Paulo', radiusKm: 9999, minPrice: '500', maxPrice: 100, condition: 'seminovo' }),
    { locationId: 'saopaulo', radiusKm: null, minPrice: 500, maxPrice: null, condition: null },
  )
  assert.equal(normalizeMarketplaceLocation('113048332042619'), '113048332042619')
  assert.equal(normalizeMarketplaceLocation('x'), null)
})

test('toSearchConfigOverride mantém o padrão do bot para campos ausentes', () => {
  assert.equal(toSearchConfigOverride(null), null)
  assert.deepEqual(
    toSearchConfigOverride({ locationId: 'curitiba', radiusKm: 60, minPrice: null, maxPrice: 800, condition: 'usado' }),
    { locationId: 'curitiba', radiusKm: 60, maxPrice: 800, itemCondition: 'used_like_new,used_good,used_fair' },
  )
})
