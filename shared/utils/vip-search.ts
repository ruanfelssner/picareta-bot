export const VIP_AUTOMOBILE_SUBCATEGORY_ID = '4eb1a9c3-6c2d-41da-81e1-b3020155414e'

export interface VipSearchScope {
  name: string
  state: string | null
  damage: null
}

const BRAZIL_STATE_CODES = new Set([
  'AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT',
  'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO',
])

const VIP_CHARACTERISTIC_FIELDS = [
  ['172647ef-4ca6-4415-adff-b305012576c2', 'Lista'],
  ['202a525b-c766-427a-9de7-b30501237c0b', 'Lista'],
  ['2d29eb9d-ef50-449f-95a9-b30501228e6f', 'Lista'],
  ['855668f5-17af-43af-99c0-b3050122387a', 'Lista'],
  ['4a5b3886-495f-4b81-bd24-b30501266a21', 'Lista'],
  ['7136fb41-8440-4c78-94d4-b30501260048', 'Lista'],
  ['b1fcf39c-6e6a-415c-b319-b305011d6562', 'Lista'],
  ['105694b7-09b9-4e09-a275-b370014ec03c', 'Lista'],
  ['92293f43-a5ba-42ec-b513-b30600fed9fb', 'Lista'],
  ['92e01846-acdd-4438-bf98-b3050124f485', 'Lista'],
] as const

export function buildVipSearchScopes(states: readonly string[] | null | undefined): VipSearchScope[] {
  const normalizedStates = Array.from(new Set(
    (states ?? [])
      .map(state => state.trim().toUpperCase())
      .filter(state => BRAZIL_STATE_CODES.has(state)),
  ))

  if (normalizedStates.length === 0) {
    return [{ name: 'Automóveis', state: null, damage: null }]
  }

  return normalizedStates.map(state => ({
    name: `Automóveis/${state}`,
    state,
    damage: null,
  }))
}

export function buildVipSearchPostBody(scope: VipSearchScope, requestedPage: number): URLSearchParams {
  const pageNumber = Number.isFinite(requestedPage) && requestedPage > 0
    ? Math.floor(requestedPage)
    : 1

  const body = new URLSearchParams([
    ['Filtro.EventoId', ''],
    ['Filtro.EventoIdOriginal', ''],
    ['Filtro.IndiceEvento', ''],
    ['Filtro.CurrentPage', ''],
    ['Filtro.SomenteDestaques', 'False'],
    ['Filtro.SelecaoVeiculos', 'true'],
    ['Filtro.Texto', ''],
    ['Filtro.Classificacao', ''],
    ['Filtro.Procedencia', ''],
    ['Filtro.Monta', ''],
    ['Filtro.ComitenteId', ''],
    ['Filtro.LocalEstadoId', scope.state ?? ''],
    ['Filtro.LocalCidade', ''],
    ['Filtro.SubCategoriaId', VIP_AUTOMOBILE_SUBCATEGORY_ID],
    ['Filtro.Marca', ''],
    ['Filtro.Modelo', ''],
    ['Filtro.Ano', ''],
    ['Filtro.ValorDe', ''],
    ['Filtro.ValorAte', ''],
    ['Filtro.QuilometragemDe', ''],
    ['__Invariant', 'Filtro.QuilometragemDe'],
    ['Filtro.QuilometragemAte', ''],
    ['__Invariant', 'Filtro.QuilometragemAte'],
  ])

  for (const [index, [characteristicId, type]] of VIP_CHARACTERISTIC_FIELDS.entries()) {
    body.append(`Filtro.Caracteristicas[${index}].CaracteristicaId`, characteristicId)
    body.append(`Filtro.Caracteristicas[${index}].Tipo`, type)
  }

  body.append('Filtro.OrdenarPor', 'DataInicio')
  body.append('CurrentPage', String(Math.max(0, pageNumber - 1)))
  body.append('Filtro.SelecaoOutros', 'false')
  body.append('Filtro.Financiavel', 'false')

  return body
}
