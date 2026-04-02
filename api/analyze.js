export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'JPM', 'V', 'BRK-B', 'SPY', 'QQQ'];

async function fetchSingleQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=false`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data.chart?.result?.[0]?.meta;
    if (!meta || !meta.regularMarketPrice) return null;
    const prev = meta.previousClose || meta.chartPreviousClose || meta.regularMarketPrice;
    return {
      price: meta.regularMarketPrice,
      changePercent: prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0,
      name: meta.shortName || meta.longName || symbol,
      prevClose: prev,
    };
  } catch {
    return null;
  }
}

async function fetchQuotes(symbols) {
  const unique = [...new Set(symbols)];
  const settled = await Promise.allSettled(unique.map(s => fetchSingleQuote(s)));
  const quotes = {};
  for (let i = 0; i < unique.length; i++) {
    if (settled[i].status === 'fulfilled' && settled[i].value) {
      quotes[unique[i]] = settled[i].value;
    }
  }
  return quotes;
}

function buildPortfolioContext(portfolio, quotes) {
  const holdingsValue = (portfolio.holdings || []).reduce((sum, h) => {
    return sum + h.shares * (quotes[h.symbol]?.price || h.avgCost);
  }, 0);
  const totalValue = holdingsValue + (portfolio.cash || 0);
  const totalReturn = ((totalValue - 50000) / 50000) * 100;

  const holdingsText = portfolio.holdings && portfolio.holdings.length > 0
    ? portfolio.holdings.map(h => {
        const q = quotes[h.symbol] || {};
        const price = q.price || h.avgCost;
        const value = h.shares * price;
        const cost = h.shares * h.avgCost;
        const pnl = value - cost;
        const pnlPct = (pnl / cost) * 100;
        return `  ${h.symbol} (${q.name || h.name || h.symbol}): ${h.shares} shares @ $${h.avgCost.toFixed(2)} avg, now $${price.toFixed(2)}, value $${value.toFixed(0)}, P&L ${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%`;
      }).join('\n')
    : '  (none — 100% in cash)';

  const marketText = WATCHLIST.map(sym => {
    const q = quotes[sym];
    if (!q) return null;
    return `  ${sym} (${q.name}): $${q.price.toFixed(2)} ${q.changePercent >= 0 ? '+' : ''}${q.changePercent.toFixed(2)}% today`;
  }).filter(Boolean).join('\n');

  const recentTrades = (portfolio.trades || []).slice(-5).map(t =>
    `  ${new Date(t.date).toLocaleDateString()} — ${t.action} ${t.shares} ${t.symbol} @ $${t.price?.toFixed(2)}`
  ).join('\n');

  return { totalValue, totalReturn, holdingsValue, holdingsText, marketText, recentTrades };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'ANTHROPIC_API_KEY is not configured on this deployment.' }),
      { status: 503, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const { portfolio, question } = body;
  if (!portfolio) {
    return new Response(JSON.stringify({ error: 'portfolio is required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  // Fetch live prices for holdings + watchlist
  const holdingSymbols = (portfolio.holdings || []).map(h => h.symbol);
  const allSymbols = [...new Set([...holdingSymbols, ...WATCHLIST])];
  const quotes = await fetchQuotes(allSymbols);

  const { totalValue, totalReturn, holdingsText, marketText, recentTrades } =
    buildPortfolioContext(portfolio, quotes);

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const systemPrompt = `You are Claude, an autonomous AI stock portfolio manager. You started with $50,000 and your goal is to outperform the S&P 500 over the long term.

You make ONE clear trade recommendation per analysis. Be specific, decisive, and data-driven.

Respond with ONLY valid JSON — no markdown code fences, no preamble, just the JSON object:
{
  "action": "BUY" | "SELL" | "HOLD",
  "symbol": "TICKER or null for HOLD",
  "name": "Full company name or null",
  "shares": <positive integer, or 0 for HOLD>,
  "estimatedPrice": <current price as a number, or null>,
  "rationale": "<2-3 sentences explaining the investment thesis>",
  "risks": "<1-2 sentences on key risks to this trade>",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "portfolioNote": "<1 sentence on overall portfolio positioning>"
}

Constraints:
- BUY: shares × estimatedPrice must not exceed available cash
- SELL: only sell shares already held
- Avoid putting more than 35% of total portfolio in any single position
- Consider diversification across sectors
- Think like a long-term investor, not a day trader`;

  const userMsg = `Date: ${today}

PORTFOLIO STATUS:
Total Value: $${totalValue.toFixed(2)} (started $50,000)
Total Return: ${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%
Cash Available: $${(portfolio.cash || 0).toFixed(2)}

CURRENT HOLDINGS:
${holdingsText}

LIVE MARKET DATA:
${marketText || '  (unavailable)'}

RECENT TRADES:
${recentTrades || '  None yet'}

${question ? `QUESTION: ${question}` : 'What is your next recommended move?'}`;

  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 2048,
        thinking: { type: 'adaptive' },
        system: systemPrompt,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Could not reach Claude API: ' + e.message }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  if (!claudeRes.ok) {
    const errText = await claudeRes.text();
    return new Response(
      JSON.stringify({ error: `Claude API error (${claudeRes.status})`, detail: errText }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  const claudeData = await claudeRes.json();
  const textBlock = claudeData.content?.find(b => b.type === 'text');
  const rawText = textBlock?.text?.trim() || '';

  // Extract JSON — handle any surrounding text or code fences Claude might add
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return new Response(
      JSON.stringify({ error: 'Unexpected response format from Claude', raw: rawText.slice(0, 500) }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  let recommendation;
  try {
    recommendation = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Could not parse Claude recommendation', raw: rawText.slice(0, 500) }),
      { status: 502, headers: { 'Content-Type': 'application/json', ...CORS } }
    );
  }

  // Attach live price from fetched data (more accurate than what Claude estimated)
  if (recommendation.symbol && quotes[recommendation.symbol]) {
    recommendation.estimatedPrice = quotes[recommendation.symbol].price;
  }

  recommendation.quotes = quotes;
  recommendation.portfolioValue = totalValue;
  recommendation.portfolioReturn = totalReturn;

  return new Response(JSON.stringify(recommendation), {
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
