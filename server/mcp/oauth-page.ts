import { randomBytes } from 'node:crypto'
import type { H3Event } from 'h3'
import { setResponseHeaders, setResponseStatus } from 'h3'

/**
 * Tela de autorização OAuth do MCP. HTML servido pelo Nitro (fora do app Vue) para não depender do bundle
 * do cliente; segue os tokens visuais do app (superfície neutra, acento azul, tema claro/escuro).
 */

export interface ConsentPageInput {
  clientName: string
  redirectHost: string
  hiddenFields: Record<string, string>
  error?: string | null
  locked?: boolean
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const STYLES = `
:root{--bg:#f4f5f7;--surface:#fff;--text:#111827;--muted:#4b5563;--border:#d1d5db;--accent:#2563eb;--accent-hover:#1d4ed8;--accent-text:#fff;--danger-bg:#fef2f2;--danger-text:#b91c1c;--danger-border:#fecaca;--focus:#93c5fd;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0b0f17;--surface:#151b26;--text:#f3f4f6;--muted:#9ca3af;--border:#2d3748;--accent:#3b82f6;--accent-hover:#60a5fa;--accent-text:#fff;--danger-bg:#2a1215;--danger-text:#fca5a5;--danger-border:#7f1d1d;--focus:#1e40af;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px 16px;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:28px 24px}
h1{font-size:1.25rem;line-height:1.3;margin:0 0 4px}
.lead{color:var(--muted);margin:0 0 20px}
ul{margin:0 0 20px;padding:0;list-style:none;display:grid;gap:8px}
li{display:flex;gap:10px;align-items:flex-start;color:var(--muted);font-size:.95rem}
li::before{content:"";flex:none;width:8px;height:8px;margin-top:8px;border-radius:50%;background:var(--accent)}
label{display:block;font-weight:600;margin-bottom:6px}
input[type=password]{width:100%;min-height:44px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:transparent;color:var(--text);font:inherit}
input[type=password]:focus{outline:3px solid var(--focus);outline-offset:1px;border-color:var(--accent)}
.hint{color:var(--muted);font-size:.85rem;margin:6px 0 0}
.alert{margin:0 0 16px;padding:10px 12px;border-radius:10px;background:var(--danger-bg);color:var(--danger-text);border:1px solid var(--danger-border);font-size:.95rem}
.actions{display:flex;flex-direction:column-reverse;gap:10px;margin-top:20px}
@media (min-width:480px){.actions{flex-direction:row;justify-content:flex-end}}
button{min-height:44px;padding:10px 18px;border-radius:10px;font:inherit;font-weight:600;cursor:pointer;border:1px solid transparent;transition:background-color .15s ease,opacity .15s ease}
button:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.primary{background:var(--accent);color:var(--accent-text)}
.primary:hover{background:var(--accent-hover)}
.secondary{background:transparent;color:var(--text);border-color:var(--border)}
button:disabled{opacity:.6;cursor:not-allowed}
.footer{margin:16px 0 0;color:var(--muted);font-size:.8rem;word-break:break-word}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
`

function sendHtml(event: H3Event, status: number, body: string, formActionOrigin: string | null, nonce: string) {
  setResponseStatus(event, status)
  setResponseHeaders(event, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    // form-action inclui a origem do redirect: o Chrome aplica a diretiva também ao 302 pós-envio.
    'Content-Security-Policy': [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
      `form-action 'self'${formActionOrigin ? ` ${formActionOrigin}` : ''}`,
      `frame-ancestors 'none'`,
      `base-uri 'none'`,
    ].join('; '),
  })
  return body
}

function document(title: string, content: string, nonce: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style nonce="${nonce}">${STYLES}</style></head><body><main>${content}</main></body></html>`
}

export function renderConsentPage(event: H3Event, input: ConsentPageInput, status = 200, redirectOrigin: string | null = null) {
  const nonce = randomBytes(16).toString('base64')
  const hidden = Object.entries(input.hiddenFields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('')
  const alert = input.error ? `<p class="alert" role="alert">${escapeHtml(input.error)}</p>` : ''
  const disabled = input.locked ? ' disabled' : ''

  const content = `
<h1>Conectar ao Bot-Anúncios</h1>
<p class="lead"><strong>${escapeHtml(input.clientName)}</strong> quer usar as ferramentas de consulta do bot.</p>
<ul>
  <li>Pesquisar Facebook Marketplace, leilões, Mercado Livre e web.</li>
  <li>Somente leitura: não publica anúncios nem envia mensagens.</li>
  <li>O acesso expira se a chave do servidor for trocada.</li>
</ul>
<form method="post" action="/oauth/authorize" id="consent">
  ${hidden}
  ${alert}
  <label for="password">Chave de acesso do MCP</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required autofocus${disabled}>
  <p class="hint">Valor de <code>MCP_ACCESS_KEY</code> configurado no servidor.</p>
  <div class="actions">
    <button class="secondary" type="submit" name="decision" value="deny" formnovalidate>Cancelar</button>
    <button class="primary" type="submit" name="decision" value="allow" id="allow"${disabled}>Autorizar</button>
  </div>
</form>
<p class="footer">Após autorizar, você volta para ${escapeHtml(input.redirectHost)}.</p>
<script nonce="${nonce}">
document.getElementById('consent').addEventListener('submit', function (event) {
  var allow = document.getElementById('allow');
  if (event.submitter === allow) { setTimeout(function () { allow.disabled = true; allow.textContent = 'Autorizando…'; }, 0); }
});
</script>`

  return sendHtml(event, status, document('Autorizar acesso — Bot-Anúncios', content, nonce), redirectOrigin, nonce)
}

export function renderOAuthErrorPage(event: H3Event, message: string, status = 400) {
  const nonce = randomBytes(16).toString('base64')
  const content = `
<h1>Não foi possível autorizar</h1>
<p class="alert" role="alert">${escapeHtml(message)}</p>
<p class="lead">Volte ao aplicativo de origem e tente conectar o servidor MCP novamente.</p>`
  return sendHtml(event, status, document('Erro de autorização — Bot-Anúncios', content, nonce), null, nonce)
}
