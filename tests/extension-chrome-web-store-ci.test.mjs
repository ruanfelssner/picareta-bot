import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/chrome-web-store.yml', import.meta.url), 'utf8')
const publisher = readFileSync(new URL('../scripts/chrome-web-store-publish.mjs', import.meta.url), 'utf8')

test('CD publica somente por tag de versão ou execução manual', () => {
  assert.match(workflow, /tags:\s*\n\s*- 'extension-v\*'/)
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/extension-v'\)/)
  assert.match(workflow, /GITHUB_REF_NAME !== expectedTag/)
})

test('autenticação usa identidade temporária e escopo mínimo da Chrome Web Store', () => {
  assert.match(workflow, /google-github-actions\/auth@v3/)
  assert.match(workflow, /workload_identity_provider:/)
  assert.match(workflow, /access_token_scopes: https:\/\/www\.googleapis\.com\/auth\/chromewebstore/)
  assert.doesNotMatch(workflow, /credentials_json|GOOGLE_CREDENTIALS/)
})

test('publicador usa API V2 e só publica depois de confirmar o upload', () => {
  assert.match(publisher, /chromewebstore\.googleapis\.com\/upload\/v2/)
  assert.match(publisher, /uploadState !== 'SUCCEEDED'/)
  assert.match(publisher, /:fetchStatus/)
  assert.match(publisher, /:publish/)
  assert.match(publisher, /blockOnWarnings: true/)
})
