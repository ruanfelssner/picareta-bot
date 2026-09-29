#!/usr/bin/env node

import { appendFile, readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

const CHROME_WEB_STORE_SCOPE = 'https://www.googleapis.com/auth/chromewebstore'
const UPLOAD_STATES_IN_PROGRESS = new Set(['IN_PROGRESS', 'UPLOAD_IN_PROGRESS'])
const UPLOAD_STATES_FAILED = new Set(['FAILED', 'NOT_FOUND'])
const PUBLISH_TYPES = new Set(['DEFAULT_PUBLISH', 'STAGED_PUBLISH'])

const config = {
  accessToken: requiredEnv('CWS_ACCESS_TOKEN'),
  publisherId: safeIdentifier('CWS_PUBLISHER_ID'),
  extensionId: safeIdentifier('CWS_EXTENSION_ID'),
  zipPath: requiredEnv('CWS_ZIP_PATH'),
  manifestPath: process.env.CWS_MANIFEST_PATH || '.extension/copart-live-collector/manifest.json',
  publishType: process.env.CWS_PUBLISH_TYPE || 'DEFAULT_PUBLISH',
}

if (!PUBLISH_TYPES.has(config.publishType)) {
  throw new Error(`CWS_PUBLISH_TYPE inválido: ${config.publishType}`)
}

const manifest = JSON.parse(await readFile(config.manifestPath, 'utf8'))
const manifestVersion = String(manifest.version ?? '').trim()
if (!/^\d+(?:\.\d+){1,3}$/.test(manifestVersion)) {
  throw new Error(`Versão inválida no manifesto: ${manifestVersion || '(vazia)'}`)
}

const packageBytes = await readFile(config.zipPath)
if (packageBytes.length === 0) throw new Error(`Pacote vazio: ${config.zipPath}`)

const itemName = `publishers/${config.publisherId}/items/${config.extensionId}`
const uploadUrl = `https://chromewebstore.googleapis.com/upload/v2/${itemName}:upload`
const itemUrl = `https://chromewebstore.googleapis.com/v2/${itemName}`

console.log(`Enviando Picareta Smart Assistant ${manifestVersion} (${packageBytes.length} bytes)...`)
const upload = await requestJson(uploadUrl, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${config.accessToken}`,
    'content-type': 'application/zip',
  },
  body: packageBytes,
})

let uploadState = String(upload.uploadState ?? '')
if (UPLOAD_STATES_IN_PROGRESS.has(uploadState)) {
  uploadState = await waitForUpload(itemUrl, config.accessToken)
}
if (uploadState !== 'SUCCEEDED') {
  throw new Error(`Upload não foi confirmado pela Chrome Web Store: ${uploadState || 'estado ausente'}`)
}
if (upload.crxVersion && String(upload.crxVersion) !== manifestVersion) {
  throw new Error(`A loja recebeu a versão ${upload.crxVersion}, mas o manifesto local está em ${manifestVersion}`)
}

console.log(`Upload ${manifestVersion} confirmado. Solicitando ${config.publishType}...`)
const publication = await requestJson(`${itemUrl}:publish`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${config.accessToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    publishType: config.publishType,
    blockOnWarnings: true,
  }),
})

const publicationState = String(publication.state ?? 'estado não informado')
console.log(`Chrome Web Store aceitou a versão ${manifestVersion}: ${publicationState}`)
await writeStepSummary({ manifestVersion, publicationState, publishType: config.publishType })

async function waitForUpload(baseItemUrl, accessToken) {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    await delay(5_000)
    const status = await requestJson(`${baseItemUrl}:fetchStatus`, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
    const state = String(status.lastAsyncUploadState ?? '')
    console.log(`Processamento do upload: ${state || 'aguardando'} (${attempt}/24)`)
    if (state === 'SUCCEEDED') return state
    if (UPLOAD_STATES_FAILED.has(state)) return state
  }
  throw new Error('Tempo limite excedido aguardando o processamento do upload.')
}

async function requestJson(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let body = {}
  if (text) {
    try {
      body = JSON.parse(text)
    }
    catch {
      body = { rawResponse: text }
    }
  }

  if (!response.ok) {
    const message = body?.error?.message ?? body?.rawResponse ?? `HTTP ${response.status}`
    throw new Error(`Chrome Web Store API ${response.status}: ${message}`)
  }
  return body
}

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim()
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`)
  return value
}

function safeIdentifier(name) {
  const value = requiredEnv(name)
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`${name} possui formato inválido.`)
  return value
}

async function writeStepSummary({ manifestVersion, publicationState, publishType }) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY
  if (!summaryPath) return
  await appendFile(summaryPath, [
    '## Chrome Web Store',
    '',
    `- Versão: \`${manifestVersion}\``,
    `- Tipo: \`${publishType}\``,
    `- Estado: \`${publicationState}\``,
    `- Escopo OAuth: \`${CHROME_WEB_STORE_SCOPE}\``,
    '',
  ].join('\n'))
}
