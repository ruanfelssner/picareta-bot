import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
import { scrapingCatalog } from '../shared/constants/scraping-catalog'
import { isAuctionSourceDisabled } from '../shared/constants/sources'

const require = createRequire(import.meta.url)
function server() {
  const exported: { testHandle?: (request: unknown, response: unknown) => Promise<void> } = {}
  let agendaCalls = 0
  const source = readFileSync(new URL('../src/cloud-service.ts', import.meta.url), 'utf8')
    .replace(/import\.meta\.url/g, '"file:///test/src/cloud-service.ts"') + '\nexports.testHandle = handle;'
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, {
    exports: exported, URL, Date, AbortSignal, Buffer,
    process: { env: { SCRAPER_SERVICE_KEY: 'private-test-key' } }, console: { log() {}, error() {} },
    require: (id: string) => {
      if (id === 'node:fs') return { readFileSync: () => '{"version":"0.49.0"}' }
      if (id === 'node:http') return { createServer: () => ({ listen() {} }) }
      if (id === 'node:os') return { hostname: () => 'test' }
      if (id === 'dotenv') return { config() {} }
      if (id === 'node-cron') return { schedule() {} }
      if (id.includes('scraping-catalog')) return { scrapingCatalog }
      if (id.includes('constants/sources')) return { isAuctionSourceDisabled }
      if (id.includes('commands/auction-search')) return { registeredAuctionSources: ['leilo', 'pampasul'] }
      if (id.includes('vip-auction-agenda')) return { collectVipAuctionAgenda: async () => { agendaCalls++; return { events: [], truncated: false } } }
      if (id.startsWith('node:')) return require(id)
      return {}
    },
  })
  return { agendaCalls: () => agendaCalls, request: async (path: string, key?: string) => {
    let status = 0, body = ''
    await exported.testHandle!({ url: path, method: 'GET', headers: { host: 'bot.test', 'x-scraper-service-key': key } }, {
      set statusCode(value: number) { status = value }, setHeader() {}, end: (value: string) => { body = value },
    })
    return { status, data: JSON.parse(body), body }
  } }
}

test('endpoint de catálogo exige chave e retorna apenas metadados públicos das fontes registradas', async () => {
  const api = server()
  assert.equal((await api.request('/internal/scraping/sources')).status, 401)
  assert.equal((await api.request('/internal/scraping/sources', 'wrong')).status, 401)
  const result = await api.request('/internal/scraping/sources', 'private-test-key')
  assert.equal(result.status, 200)
  assert.equal(result.data.schemaVersion, 1)
  assert.equal(result.data.sources.length, 2)
  assert.doesNotMatch(result.body, /private-test-key|PICARETA_INGEST_KEY/)
})
test('endpoint de agenda também exige chave e compartilha uma consulta entre leituras concorrentes', async () => {
  const api = server()
  assert.equal((await api.request('/internal/scraping/agenda/vip')).status, 401)
  const responses = await Promise.all([api.request('/internal/scraping/agenda/vip', 'private-test-key'), api.request('/internal/scraping/agenda/vip', 'private-test-key')])
  assert.ok(responses.every(response => response.status === 200))
  assert.equal(api.agendaCalls(), 1)
})
