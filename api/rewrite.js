export const config = { runtime: 'edge' };

import { verifyProToken } from './_token.js';

const rateLimit = new Map(); // fallback when Redis is not configured
const FREE_LIMIT = 3;

// Upstash Redis REST helper — uses pipeline for atomic INCR + EXPIRE
async function checkRedisRateLimit(ip) {
  const base = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) return null; // Redis not configured → caller uses in-memory fallback

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const key = `captioniq:rl:${ip}:${today}`;

  const res = await fetch(`${base}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([
      ['INCR', key],
      ['EXPIRE', key, 90000], // 25 hours, covers timezone edge cases
    ]),
  });

  if (!res.ok) return null;
  const data = await res.json();
  const count = data?.[0]?.result ?? 1;
  return count;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { caption, platform, niche, proToken } = body;

  // ── Pro verification ────────────────────────────────────────────────────────
  const signingSecret = process.env.PRO_SIGNING_SECRET;
  const isPro = signingSecret && proToken
    ? await verifyProToken(proToken, signingSecret)
    : false;

  // ── Rate limiting (free users only) ────────────────────────────────────────
  if (!isPro) {
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

    const redisCount = await checkRedisRateLimit(ip).catch(() => null);

    if (redisCount !== null) {
      // Redis-backed: reliable across cold starts and regions
      if (redisCount > FREE_LIMIT) {
        return new Response(
          JSON.stringify({ error: 'Daily limit reached. Upgrade to Pro for unlimited rewrites.' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
    } else {
      // In-memory fallback (Redis not configured)
      const now = Date.now();
      const hourAgo = now - 60 * 60 * 1000;
      const timestamps = (rateLimit.get(ip) || []).filter(t => t > hourAgo);
      if (timestamps.length >= FREE_LIMIT) {
        return new Response(
          JSON.stringify({ error: 'Rate limit reached. You get 3 free AI rewrites per hour.' }),
          { status: 429, headers: { 'Content-Type': 'application/json' } }
        );
      }
      timestamps.push(now);
      rateLimit.set(ip, timestamps);
    }
  }

  if (!caption || caption.trim().length < 10) {
    return new Response(JSON.stringify({ error: 'Caption is too short to rewrite.' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'AI service not configured.' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const platformName = platform === 'tiktok' ? 'TikTok' : 'Instagram';
  const nicheName = niche || 'Lifestyle';

  const systemPrompt = `You are a top-tier social media strategist specialising in ${platformName} content for ${nicheName} creators.

Rewrite the caption to maximise genuine engagement. Follow these rules:
- First line must hook immediately — stop the scroll. No fluff, no generic openers.
- Keep the creator's authentic voice and core message.
- Use a natural, conversational tone — not corporate, not generic.
- Include a strong, platform-native CTA (${platform === 'tiktok' ? 'comment bait, duet prompt, or follow CTA' : '"Save this", question for comments, or tag someone'}).
- Keep a similar length to the original unless it was too long.
- Preserve existing hashtags at the end if present.
- Return ONLY the rewritten caption. No preamble, no explanation, no "Here is your rewrite:" — just the caption text.`;

  const userPrompt = `Rewrite this ${platformName} caption for a ${nicheName} creator:\n\n${caption}`;

  let groqRes;
  try {
    groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 600,
        temperature: 0.82,
      }),
    });
  } catch {
    return new Response(JSON.stringify({ error: 'Could not reach AI service. Try again.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!groqRes.ok) {
    return new Response(JSON.stringify({ error: 'AI service returned an error. Try again.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const data = await groqRes.json();
  const text = data.choices?.[0]?.message?.content?.trim();

  if (!text) {
    return new Response(JSON.stringify({ error: 'AI returned an empty response. Try again.' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(JSON.stringify({ text }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
