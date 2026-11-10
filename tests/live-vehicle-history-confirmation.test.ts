import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

test('bot exige confirmação do arquivo de monta e mantém compatibilidade com capturas sem histórico', async () => {
  let archived: boolean | undefined
  const exported: { syncVehicleToPicareta?: (_payload: unknown) => Promise<boolean> } = {}
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../layers/cars/server/utils/picareta-sync.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    exports: exported, process: { env: {} }, AbortSignal, console,
    setTimeout: (callback: () => void) => { callback() },
    useRuntimeConfig: () => ({ picaretaIngestUrl: 'https://picareta.test/ingest', picaretaIngestKey: 'test-key' }),
    fetch: async () => ({ ok: true, json: async () => ({ ok: true, received: 1, matched: 1, damageHistoryArchived: archived }) }),
  })
  const send = exported.syncVehicleToPicareta!
  assert.equal(await send({ source: 'copart', damage: 'Média monta' }), true)
  await assert.rejects(send({ damageHistory: [{ damage: 'Média monta' }] }), /não confirmou o arquivo/)
  archived = true
  assert.equal(await send({ damageHistory: [{ damage: 'Média monta' }] }), true)
})
