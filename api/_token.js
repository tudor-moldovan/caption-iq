// Shared HMAC-SHA256 helpers for server-side Pro token signing/verification.
// Token format: base64(sig)|until|customerId

async function importKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signProToken(customerId, until, secret) {
  const key = await importKey(secret);
  const data = `${customerId}|${until}`;
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `${b64}|${until}|${customerId}`;
}

// Extract fields from a token without verifying. Only call after verifyProToken returns true.
export function parseProToken(token) {
  try {
    const firstPipe = token.indexOf('|');
    const secondPipe = token.indexOf('|', firstPipe + 1);
    if (firstPipe === -1 || secondPipe === -1) return null;
    return {
      until: parseInt(token.slice(firstPipe + 1, secondPipe)),
      customerId: token.slice(secondPipe + 1),
    };
  } catch { return null; }
}

export async function verifyProToken(token, secret) {
  try {
    if (!token || typeof token !== 'string') return false;
    // Token has exactly 3 pipe-delimited parts: b64sig | until | customerId
    // customerId itself never contains '|', so split from the left to be safe
    const firstPipe = token.indexOf('|');
    const secondPipe = token.indexOf('|', firstPipe + 1);
    if (firstPipe === -1 || secondPipe === -1) return false;
    const b64sig = token.slice(0, firstPipe);
    const until  = token.slice(firstPipe + 1, secondPipe);
    const customerId = token.slice(secondPipe + 1);
    if (parseInt(until) < Date.now()) return false;
    const key = await importKey(secret);
    const data = `${customerId}|${until}`;
    const sigBytes = Uint8Array.from(atob(b64sig), c => c.charCodeAt(0));
    return await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(data));
  } catch { return false; }
}
