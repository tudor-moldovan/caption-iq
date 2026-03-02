export const config = { runtime: 'edge' };

const rateLimit = new Map();
const MAX_PER_HOUR = 3;

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

  // Basic IP-based rate limiting (in-memory, resets on cold start)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const timestamps = (rateLimit.get(ip) || []).filter(t => t > hourAgo);

  if (timestamps.length >= MAX_PER_HOUR) {
    return new Response(
      JSON.stringify({ error: 'Rate limit reached. You get 3 free AI rewrites per hour.' }),
      { status: 429, headers: { 'Content-Type': 'application/json' } }
    );
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

  const { caption, platform, niche } = body;

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

  // Record successful request after response is ready
  timestamps.push(now);
  rateLimit.set(ip, timestamps);

  return new Response(JSON.stringify({ text, remaining: MAX_PER_HOUR - timestamps.length }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
