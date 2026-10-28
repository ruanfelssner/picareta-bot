<script setup lang="ts">
import type { AuctionArchiveEvidencePage, AuctionArchiveOrigin, AuctionArchivePage, AuctionArchiveSession } from '#shared/types/live-auction-archive'

const emit = defineEmits<{ select: [session: AuctionArchiveSession] }>()
const route = useRoute()
const router = useRouter()
const routeText = (key: string) => typeof route.query[key] === 'string' ? route.query[key] as string : ''
const search = ref(routeText('q'))
const source = ref(routeText('source'))
const period = ref(routeText('from') || routeText('to') ? 'custom' : 'all')
const fromDate = ref(routeText('from'))
const toDate = ref(routeText('to'))
const applied = ref({ q: search.value, source: source.value, from: fromDate.value ? `${fromDate.value}T00:00:00-03:00` : '', to: toDate.value ? `${toDate.value}T23:59:59.999-03:00` : '' })
const formError = ref('')
const sessionPage = ref(1)
const selectedKey = ref(routeText('sessionKey').toLowerCase())
const selected = ref<AuctionArchiveSession | null>(null)
const recordSearch = ref(search.value)
const origin = ref('')
const recordPage = ref(1)
const recordFilter = ref({ q: search.value, origin: '' })
const endpoint = '/api/vehicles/live-audit/archive'
const { data, status, error, refresh } = await useFetch<AuctionArchivePage<AuctionArchiveSession>>(endpoint, {
  query: computed(() => ({ ...applied.value, page: sessionPage.value })), watch: false,
})
const sessions = computed(() => data.value?.items ?? [])
const { data: evidence, status: evidenceStatus, error: evidenceError, refresh: refreshEvidence } = await useFetch<AuctionArchiveEvidencePage>(endpoint, {
  query: computed(() => ({ ...recordFilter.value, sessionKey: selectedKey.value, page: recordPage.value, from: applied.value.from, to: applied.value.to })),
  immediate: false, watch: false,
})
const pending = computed(() => status.value === 'pending')
const evidencePending = computed(() => evidenceStatus.value === 'pending')
const origins: Record<AuctionArchiveOrigin, string> = {
  log: 'Log no Picareta', outbox: 'Log no Bot', capture: 'Extensão · último estado',
  vehicle: 'Cadastro no Bot', result: 'Resultado consolidado', catalog: 'Coleta do catálogo',
}
const statuses: Record<string, string> = { sold: 'Vendido', conditional: 'Condicional', not_sold: 'Não vendido', unknown: 'Sem resultado confirmado' }

function dateTime(value: string | null) {
  if (!value) return 'Sem data registrada'
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value))
}
function money(value: number) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value)
}
function safeUrl(value: string | null) {
  try {
    const url = new URL(value || '')
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined
  }
  catch { return undefined }
}
function syncRoute() {
  void router.replace({ query: { ...route.query, view: 'saved', q: applied.value.q || undefined, source: applied.value.source || undefined, from: applied.value.from.slice(0, 10) || undefined, to: applied.value.to.slice(0, 10) || undefined, sessionKey: selectedKey.value || undefined } })
}
function selectSession(session: AuctionArchiveSession) {
  selected.value = session
  recordPage.value = 1
  recordSearch.value = applied.value.q
  origin.value = ''
  recordFilter.value = { q: applied.value.q, origin: '' }
  selectedKey.value = session.sessionKey
  emit('select', session)
  syncRoute()
  void refreshEvidence()
}
watch(sessions, (items) => {
  if (selected.value) return
  const match = items.find(item => item.sessionKey === selectedKey.value)
  if (selectedKey.value && !match) {
    const source = selectedKey.value.split(':')[0] ?? ''
    selectSession({ sessionKey: selectedKey.value, source, auctionId: selectedKey.value.split(':')[1] ?? null,
      label: selectedKey.value, lastEventAt: null, recordCount: 0, rawCount: 0, sample: { lot: null, code: null, title: null } })
  }
  else if (match || items[0]) selectSession(match ?? items[0]!)
}, { immediate: true })

async function runSearch() {
  formError.value = ''
  let from = ''
  let to = ''
  if (period.value === 'custom') {
    from = fromDate.value ? `${fromDate.value}T00:00:00-03:00` : ''
    to = toDate.value ? `${toDate.value}T23:59:59.999-03:00` : ''
    if (from && to && from > to) {
      formError.value = 'A data inicial deve ser anterior à final.'
      return
    }
  }
  else if (period.value !== 'all') from = new Date(Date.now() - Number(period.value) * 86_400_000).toISOString()
  applied.value = { q: search.value.trim(), source: source.value, from, to }
  sessionPage.value = 1
  await refresh()
  if (error.value) return
  if (sessions.value[0]) selectSession(sessions.value[0])
  else { selected.value = null; selectedKey.value = ''; syncRoute() }
}
async function changeSessionPage(delta: number) {
  sessionPage.value += delta
  await refresh()
}
async function filterRecords() {
  recordPage.value = 1
  recordFilter.value = { q: recordSearch.value.trim(), origin: origin.value }
  await refreshEvidence()
}
async function changeRecordPage(delta: number) {
  recordPage.value += delta
  await refreshEvidence()
}
</script>

<template>
  <section aria-label="Consultar registros salvos" class="space-y-4 motion-reduce:[&_*]:transition-none">
    <UiCard class="p-4">
      <h2 class="text-base font-bold text-strong">Pesquisar lotes e leilões</h2>
      <p class="mt-1 text-xs leading-relaxed text-soft">Consulte o que ainda está salvo, mesmo quando o log bruto já não estiver disponível. Horários de Brasília.</p>
      <form class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1fr)_150px_220px_auto]" @submit.prevent="runSearch">
        <label class="block text-xs font-semibold text-soft">Lote, leilão, veículo ou URL<UiInput v-model="search" size="lg" type="search" maxlength="200" placeholder="Ex.: 1162845, lote 61 ou leilão 112097" class="mt-2" /></label>
        <label class="block text-xs font-semibold text-soft">Leiloeiro<UiSelect v-model="source" size="lg" class="mt-2 min-h-11 w-full"><option value="">Todos</option><option value="copart">Copart</option><option value="sodre">Sodré</option><option value="vipleiloes">VIP</option><option value="pestana">Pestana</option></UiSelect></label>
        <label class="block text-xs font-semibold text-soft">Período<UiSelect v-model="period" size="lg" class="mt-2 min-h-11 w-full"><option value="all">Todo o histórico salvo</option><option value="7">Últimos 7 dias</option><option value="30">Últimos 30 dias</option><option value="custom">Escolher datas</option></UiSelect></label>
        <UiButton type="submit" variant="primary" size="lg" class="self-end" :loading="pending">Pesquisar</UiButton>
        <div v-if="period === 'custom'" class="grid gap-3 sm:col-span-2 sm:grid-cols-2 xl:col-span-4">
          <label class="text-xs text-soft">Data inicial<UiInput v-model="fromDate" size="lg" type="date" class="mt-2" /></label>
          <label class="text-xs text-soft">Data final<UiInput v-model="toDate" size="lg" type="date" class="mt-2" /></label>
        </div>
        <p v-if="formError" role="alert" class="text-xs text-danger sm:col-span-2 xl:col-span-4">{{ formError }}</p>
      </form>
    </UiCard>
    <UiCard v-if="error" role="alert" class="border-danger-line p-4 text-sm text-danger">Não foi possível pesquisar os registros. Verifique a conexão e tente novamente.</UiCard>
    <div v-else class="grid items-start gap-4 lg:grid-cols-[300px_minmax(0,1fr)]">
      <UiCard class="min-w-0 overflow-hidden" :aria-busy="pending">
        <header class="border-b border-line p-4"><h3 class="text-sm font-bold text-strong">Resultados da busca</h3><p role="status" class="mt-1 text-xs text-soft">{{ data?.total ?? 0 }} resultado(s)</p></header>
        <p v-if="pending" role="status" class="p-4 text-sm text-soft">Consultando o histórico salvo…</p>
        <p v-else-if="!sessions.length" class="p-4 text-sm text-soft">Nenhum registro encontrado. Confira o código ou amplie o período.</p>
        <div v-else class="max-h-[45vh] overflow-y-auto scrollbar-dark lg:max-h-[65vh]">
          <button v-for="session in sessions" :key="session.sessionKey" type="button" :aria-pressed="selectedKey === session.sessionKey" class="block min-h-11 w-full border-b border-line-soft p-4 text-left transition last:border-0 hover:bg-surface focus-visible:outline-2 focus-visible:outline-accent" :class="selectedKey === session.sessionKey ? 'bg-surface-active ring-1 ring-inset ring-accent' : ''" @click="selectSession(session)">
            <strong class="block break-words text-sm text-strong">{{ session.label }}</strong>
            <span class="mt-1 block break-all text-xs text-accent-soft">{{ session.sessionKey }}</span>
            <span class="mt-2 block text-xs text-soft">{{ dateTime(session.lastEventAt) }}</span>
            <span v-if="session.sample.title || session.sample.lot" class="mt-2 block text-xs text-soft">{{ session.sample.title }}<span v-if="session.sample.lot"> · Lote {{ session.sample.lot }}</span><span v-if="session.sample.code"> · {{ session.sample.code }}</span></span>
          </button>
        </div>
        <nav v-if="data && data.total > data.pageSize" aria-label="Páginas dos leilões" class="flex items-center justify-between gap-2 border-t border-line p-3 text-xs text-soft">
          <UiButton size="lg" :disabled="pending || sessionPage <= 1" @click="changeSessionPage(-1)">Anterior</UiButton><span>{{ sessionPage }} / {{ Math.ceil(data.total / data.pageSize) }}</span><UiButton size="lg" :disabled="pending || sessionPage * data.pageSize >= data.total" @click="changeSessionPage(1)">Próxima</UiButton>
        </nav>
      </UiCard>
      <UiCard class="min-w-0 overflow-hidden" :aria-busy="evidencePending">
        <template v-if="selectedKey">
          <header class="border-b border-line p-4">
            <h3 class="break-words text-base font-bold text-strong">{{ selected?.label || selectedKey }}</h3><p class="mt-1 break-all text-xs text-accent-soft">{{ selectedKey }}</p>
            <form class="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_210px_auto]" @submit.prevent="filterRecords">
              <label class="text-xs text-soft">Filtrar registros deste leilão<UiInput v-model="recordSearch" size="lg" type="search" maxlength="200" placeholder="Lote, código ou mensagem" class="mt-2" /></label>
              <label class="text-xs text-soft">Origem<UiSelect v-model="origin" size="lg" class="mt-2 min-h-11 w-full"><option value="">Todos os registros</option><option v-for="(label, key) in origins" :key="key" :value="key">{{ label }}</option></UiSelect></label>
              <UiButton type="submit" size="lg" class="self-end" :loading="evidencePending">Filtrar</UiButton>
            </form>
          </header>
          <p v-if="evidencePending" role="status" class="p-5 text-sm text-soft">Carregando registros salvos…</p>
          <div v-else-if="evidenceError" role="alert" class="p-4 text-sm text-danger">Não foi possível carregar os registros. <UiButton size="lg" @click="refreshEvidence()">Tentar novamente</UiButton></div>
          <template v-else-if="evidence">
            <div class="border-b border-line p-4 text-xs leading-relaxed text-soft">
              <p v-if="!evidence.rawCount" class="rounded-control border border-warning/30 bg-warning-bg p-3 text-warning"><strong>Log bruto indisponível nesta sessão.</strong> As capturas e os resultados abaixo continuam disponíveis, mas não reconstituem a conversa completa do leilão.</p>
              <p v-else>{{ evidence.rawCount }} registro(s) de chat disponíveis. Capturas e cadastros são identificados separadamente e podem conter apenas o último estado salvo.</p>
              <p role="status" class="mt-3">{{ evidence.total }} registro(s) neste filtro · mais recentes primeiro</p>
            </div>
            <p v-if="!evidence.items.length" class="p-5 text-sm text-soft">Nenhum registro corresponde a este filtro. Limpe a busca ou escolha outra origem.</p>
            <div v-else class="divide-y divide-line-soft">
              <article v-for="item in evidence.items" :key="item.id" class="p-4">
                <div class="flex flex-wrap items-center justify-between gap-2"><UiBadge variant="info">{{ origins[item.origin] }}</UiBadge><time class="text-xs text-soft">{{ dateTime(item.observedAt) }}</time></div>
                <h4 class="mt-3 break-words text-sm font-bold text-strong">{{ item.title || 'Veículo não identificado' }}</h4>
                <p class="mt-1 break-words text-xs text-soft">Lote {{ item.lot || 'não informado' }}<span v-if="item.code"> · Código {{ item.code }}</span><span v-if="item.status"> · {{ statuses[item.status] || item.status }}</span><span v-if="item.kind"> · {{ item.kind }}</span></p>
                <p v-if="item.amount !== null" class="mt-3 text-lg font-bold text-strong">{{ money(item.amount) }}</p>
                <p v-if="item.amount !== null && item.fipe && item.fipe > 0" class="mt-1 text-xs text-soft"><span class="whitespace-nowrap">{{ (item.amount / item.fipe * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) }}% da FIPE</span> · <span class="whitespace-nowrap">FIPE {{ money(item.fipe) }}</span></p>
                <blockquote v-if="item.message" class="mt-3 whitespace-pre-wrap break-words border-l-2 border-accent pl-3 text-sm leading-relaxed text-body">{{ item.message }}</blockquote>
                <p v-else class="mt-2 text-xs text-soft">Este registro não contém mensagem do chat.</p>
                <a v-if="safeUrl(item.url)" :href="safeUrl(item.url)" target="_blank" rel="noopener noreferrer" class="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-accent-soft underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent">Abrir anúncio original <span class="sr-only">em nova aba</span> ↗</a>
              </article>
            </div>
            <nav v-if="evidence.total > evidence.pageSize" aria-label="Páginas dos registros" class="flex items-center justify-between gap-2 border-t border-line p-4 text-xs text-soft"><UiButton size="lg" :disabled="evidencePending || recordPage <= 1" @click="changeRecordPage(-1)">Anterior</UiButton><span>{{ recordPage }} / {{ Math.ceil(evidence.total / evidence.pageSize) }}</span><UiButton size="lg" :disabled="evidencePending || recordPage * evidence.pageSize >= evidence.total" @click="changeRecordPage(1)">Próxima</UiButton></nav>
          </template>
        </template>
        <p v-else class="p-5 text-sm text-soft">Pesquise um lote ou leilão e selecione um resultado para consultar o que ficou salvo.</p>
      </UiCard>
    </div>
  </section>
</template>
