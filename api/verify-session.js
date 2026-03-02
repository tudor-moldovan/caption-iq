export const config = { runtime: 'edge' };

// Pro token is valid for 35 days (slightly more than 30-day billing cycle)
const PRO_TTL_MS = 35 * 24 * 60 * 60 * 1000;

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('id');

  if (!sessionId) {
    return new Response(JSON.stringify({ error: 'Missing session ID' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  let stripeRes;
  try {
    stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Bearer ${stripeKey}` } }
    );
  } catch {
    return new Response(JSON.stringify({ error: 'Could not reach Stripe' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }

  const session = await stripeRes.json();

  if (!stripeRes.ok) {
    return new Response(JSON.stringify({ error: 'Invalid session' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (session.payment_status !== 'paid') {
    return new Response(JSON.stringify({ error: 'Payment not completed' }), {
      status: 402, headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({
    pro: true,
    customerId: session.customer,
    email: session.customer_details?.email || null,
    until: Date.now() + PRO_TTL_MS,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
