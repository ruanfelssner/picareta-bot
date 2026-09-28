import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildVipSearchPostBody,
  buildVipSearchScopes,
  VIP_AUTOMOBILE_SUBCATEGORY_ID,
} from '../shared/utils/vip-search.js'

test('cria uma busca VIP por estado configurado', () => {
  const scopes = buildVipSearchScopes(['pr', 'SC', 'PR', 'invalido'])

  assert.deepEqual(scopes, [
    { name: 'Automóveis/PR', state: 'PR', damage: null },
    { name: 'Automóveis/SC', state: 'SC', damage: null },
  ])
})

test('usa uma busca nacional de automóveis quando não há estado configurado', () => {
  assert.deepEqual(buildVipSearchScopes([]), [
    { name: 'Automóveis', state: null, damage: null },
  ])
})

test('reproduz os filtros e a paginação enviados pelo site da VIP', () => {
  const [scope] = buildVipSearchScopes(['PR'])
  assert.ok(scope)

  const body = buildVipSearchPostBody(scope, 4)

  assert.equal(body.get('Filtro.LocalEstadoId'), 'PR')
  assert.equal(body.get('Filtro.SubCategoriaId'), VIP_AUTOMOBILE_SUBCATEGORY_ID)
  assert.equal(body.get('Filtro.Classificacao'), '')
  assert.equal(body.get('Filtro.SelecaoVeiculos'), 'true')
  assert.equal(body.get('Filtro.SelecaoOutros'), 'false')
  assert.equal(body.get('Filtro.OrdenarPor'), 'DataInicio')
  assert.equal(body.get('CurrentPage'), '3')
  assert.equal(body.get('Filtro.CurrentPage'), '')
  assert.deepEqual(body.getAll('__Invariant'), [
    'Filtro.QuilometragemDe',
    'Filtro.QuilometragemAte',
  ])
  assert.equal(body.get('Filtro.Caracteristicas[0].CaracteristicaId'), '172647ef-4ca6-4415-adff-b305012576c2')
  assert.equal(body.get('Filtro.Caracteristicas[9].Tipo'), 'Lista')
})
