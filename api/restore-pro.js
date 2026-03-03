export const config = { runtime: 'edge' };

import { signProToken } from './_token.js';

const PRO_TTL_MS = 35 * 24 * 60 * 60 * 1000;

export default async function handler(req) {
  const { searchParams } = new URL(req.url);
  const email = searchParams.get('email')?.toLowerCase().trim();

  if (!email || !email.includes('@')) {
    return new Response(JSON.stringify({ error: 'Invalid email' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    return new Response(JSON.stringify({ error: 'Stripe not configured' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Search Stripe customers by email
  let searchRes;
  try {
    searchRes = await fetch(
      `https://api.stripe.com/v1/customers/search?query=email:'${encodeURIComponent(email)}'&limit=1`,
      { headers: { Authorization: `Bearer ${stripeKey}` } }
    );
  } catch {
    return new Response(JSON.stringify({ error: 'Could not reach Stripe' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }

  const searchData = await searchRes.json();
  if (!searchRes.ok || !searchData.data?.length) {
    return new Response(JSON.stringify({ pro: false, error: 'No account found for that email' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }

  const customer = searchData.data[0];

  // Check for active subscription
  let subRes;
  try {
    subRes = await fetch(
      `https://api.stripe.com/v1/subscriptions?customer=${customer.id}&status=active&limit=1`,
      { headers: { Authorization: `Bearer ${stripeKey}` } }
    );
  } catch {
    return new Response(JSON.stringify({ error: 'Could not verify subscription' }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    });
  }

  const subData = await subRes.json();
  if (!subRes.ok || !subData.data?.length) {
    return new Response(JSON.stringify({ pro: false, error: 'No active subscription found' }), {
      status: 404, headers: { 'Content-Type': 'application/json' },
    });
  }

  const until = Date.now() + PRO_TTL_MS;
  const signingSecret = process.env.PRO_SIGNING_SECRET;
  const proToken = signingSecret
    ? await signProToken(customer.id, until, signingSecret)
    : null;

  return new Response(JSON.stringify({
    pro: true,
    customerId: customer.id,
    email: customer.email,
    until,
    proToken,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
