import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workflow = readFileSync(new URL('../.github/workflows/chrome-web-store.yml', import.meta.url), 'utf8')
const publisher = readFileSync(new URL('../scripts/chrome-web-store-publish.mjs', import.meta.url), 'utf8')

test('runner instala dependências de produção e desenvolvimento antes dos testes da extensão', () => {
  const job = workflow.slice(workflow.indexOf('  validate_package:'), workflow.indexOf('\n  publish:'))
  const setup = job.indexOf('uses: pnpm/action-setup@')
  const install = job.match(/run:\s*(pnpm install[^\n]+)/)
  const tests = job.indexOf('run: node --test')
  assert.ok(setup >= 0, 'pnpm deve ser preparado a partir do packageManager do projeto')
  assert.ok(install, 'o runner precisa instalar os módulos usados pelos testes')
  assert.ok(install.index > setup && tests > install.index, 'a instalação deve acontecer antes da suíte')
  const flags = install[1].split(/\s+/)
  assert.ok(flags.includes('--frozen-lockfile'), 'usar as dependências versionadas no lockfile')
  assert.ok(flags.includes('--prod=false'), 'incluir TypeScript, declarado em devDependencies')
  assert.ok(flags.includes('--ignore-scripts'), 'testar a extensão sem executar nuxt prepare ou scripts nativos')
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(packageJson.devDependencies.typescript)
  assert.ok(packageJson.dependencies.cheerio)
})

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
