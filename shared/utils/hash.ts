export async function sha1(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const buf = await globalThis.crypto.subtle.digest('SHA-1', data)
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function buildExternalId(source: string, url: string): Promise<string> {
  return sha1(source + url)
}
