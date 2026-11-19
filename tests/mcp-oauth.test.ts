import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  deriveSigningKey,
  exchangeToken,
  issueAuthorizationCode,
  OAuthError,
  parseAuthorizationRequest,
  registerClient,
  UsedCodeRegistry,
  verifyAccessToken,
} from '../server/mcp/oauth-tokens'

const KEY = deriveSigningKey('chave-de-teste-com-mais-de-24-caracteres')
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect'

function pkce() {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

function authorize(now = Date.now()) {
  const client = registerClient(KEY, { client_name: 'ChatGPT', redirect_uris: [REDIRECT] }, now)
  const { verifier, challenge } = pkce()
  const request = parseAuthorizationRequest(KEY, {
    client_id: client.clientId,
    redirect_uri: REDIRECT,
    response_type: 'code',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'abc',
  }, now)
  return { client, verifier, code: issueAuthorizationCode(KEY, request, now) }
}

function assertOAuthError(fn: () => unknown, code: OAuthError['error']) {
  assert.throws(fn, (error: unknown) => error instanceof OAuthError && error.error === code)
}

test('fluxo completo: registro, código com PKCE, access e refresh token', () => {
  const { client, verifier, code } = authorize()
  const tokens = exchangeToken(KEY, {
    grant_type: 'authorization_code',
    client_id: client.clientId,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }, new UsedCodeRegistry())

  assert.equal(tokens.token_type, 'Bearer')
  assert.equal(tokens.expires_in, ACCESS_TOKEN_TTL_SECONDS)
  assert.deepEqual(verifyAccessToken(KEY, tokens.access_token), { scope: 'search' })
  // Refresh token não serve como access token.
  assert.equal(verifyAccessToken(KEY, tokens.refresh_token), null)

  const refreshed = exchangeToken(KEY, { grant_type: 'refresh_token', client_id: client.clientId, refresh_token: tokens.refresh_token }, new UsedCodeRegistry())
  assert.ok(verifyAccessToken(KEY, refreshed.access_token))
})

test('código de autorização não pode ser reutilizado nem trocado sem o verifier correto', () => {
  const { client, verifier, code } = authorize()
  const used = new UsedCodeRegistry()
  const params = { grant_type: 'authorization_code', client_id: client.clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }

  assertOAuthError(() => exchangeToken(KEY, { ...params, code_verifier: pkce().verifier }, used), 'invalid_grant')
  exchangeToken(KEY, params, used)
  assertOAuthError(() => exchangeToken(KEY, params, used), 'invalid_grant')
})

test('código expira em 5 minutos e não serve para outro cliente', () => {
  const start = Date.now()
  const { client, verifier, code } = authorize(start)
  const other = registerClient(KEY, { redirect_uris: [REDIRECT] }, start)
  const params = { grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }

  assertOAuthError(() => exchangeToken(KEY, { ...params, client_id: other.clientId }, new UsedCodeRegistry(), start), 'invalid_grant')
  assertOAuthError(() => exchangeToken(KEY, { ...params, client_id: client.clientId }, new UsedCodeRegistry(), start + 6 * 60_000), 'invalid_grant')
})

test('access token expira e é invalidado ao trocar MCP_ACCESS_KEY', () => {
  const { client, verifier, code } = authorize()
  const tokens = exchangeToken(KEY, { grant_type: 'authorization_code', client_id: client.clientId, code, redirect_uri: REDIRECT, code_verifier: verifier }, new UsedCodeRegistry())

  assert.equal(verifyAccessToken(KEY, tokens.access_token, Date.now() + (ACCESS_TOKEN_TTL_SECONDS + 1) * 1000), null)
  assert.equal(verifyAccessToken(deriveSigningKey('outra-chave-com-mais-de-24-caracteres!'), tokens.access_token), null)
  assert.equal(verifyAccessToken(KEY, `${tokens.access_token}x`), null)
})

test('registro só aceita redirect HTTPS (ou localhost) e autorização exige redirect registrado e S256', () => {
  assertOAuthError(() => registerClient(KEY, { redirect_uris: ['http://evil.example/cb'] }), 'invalid_redirect_uri')
  assertOAuthError(() => registerClient(KEY, { redirect_uris: [] }), 'invalid_redirect_uri')
  assert.ok(registerClient(KEY, { redirect_uris: ['http://localhost:6274/oauth/callback'] }).clientId)

  const client = registerClient(KEY, { redirect_uris: [REDIRECT] })
  const base = { client_id: client.clientId, redirect_uri: REDIRECT, response_type: 'code', code_challenge: pkce().challenge, code_challenge_method: 'S256' }
  assertOAuthError(() => parseAuthorizationRequest(KEY, { ...base, redirect_uri: 'https://outro.example/cb' }), 'invalid_redirect_uri')
  assertOAuthError(() => parseAuthorizationRequest(KEY, { ...base, code_challenge_method: 'plain' }), 'invalid_request')
  assertOAuthError(() => parseAuthorizationRequest(KEY, { ...base, client_id: 'forjado.assinatura' }), 'invalid_client')
})
