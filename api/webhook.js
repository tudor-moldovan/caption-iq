export const config = { runtime: 'edge' };

// Events we care about
const REVOKE_EVENTS = new Set([
  'customer.subscription.deleted',
  'invoice.payment_failed',
]);

// ── Stripe webhook signature verification ────────────────────────────────────
// Implements the same algorithm as the official Stripe SDK, using Web Crypto.
async function verifyStripeSignature(payload, sigHeader, secret) {
  // sigHeader format: "t=timestamp,v1=sig1,v1=sig2,..."
  const parts = Object.fromEntries(
    sigHeader.split(',').map(p => {
      const eq = p.indexOf('=');
      return [p.slice(0, eq), p.slice(eq + 1)];
    })
  );
  const timestamp = parts.t;
  const signatures = sigHeader.split(',')
    .filter(p => p.startsWith('v1='))
    .map(p => p.slice(3));

  if (!timestamp || !signatures.length) return false;

  // Reject events older than 5 minutes
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBytes = await crypto.subtle.sign(
    'HMAC', key, new TextEncoder().encode(signedPayload)
  );
  const expected = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signatures.some(s => s === expected);
}

// ── Upstash helper ────────────────────────────────────────────────────────────
async function revokeCustomer(customerId) {
  const base  = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return; // no-op if Redis not configured

  // 90-day TTL — long enough to outlast any cached proToken
  await fetch(
    `${base}/set/${encodeURIComponent(`captioniq:revoked:${customerId}`)}/1/EX/7776000`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

// ── Handler ───────────────────────────────────────────────────────────────────
export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    return new Response(JSON.stringify({ error: 'Webhook secret not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  const sigHeader = req.headers.get('stripe-signature');
  if (!sigHeader) {
    return new Response(JSON.stringify({ error: 'Missing stripe-signature header' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const rawBody = await req.text();

  const valid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!valid) {
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (REVOKE_EVENTS.has(event.type)) {
    const customerId =
      event.data?.object?.customer ||      // subscription / invoice object
      event.data?.object?.id;             // fallback if object IS the customer

    if (customerId) {
      await revokeCustomer(customerId);
    }
  }

  // Always return 200 so Stripe doesn't retry non-revocation events
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
