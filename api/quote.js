export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

async function fetchSingleQuote(symbol) {
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
  const changePercent = prev ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0;
  return {
    price: meta.regularMarketPrice,
    changePercent,
    name: meta.shortName || meta.longName || symbol,
    prevClose: prev,
    high: meta.regularMarketDayHigh,
    low: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
  };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const url = new URL(req.url);
  const symbols = url.searchParams.get('symbols');
  if (!symbols) {
    return new Response(JSON.stringify({ error: 'symbols parameter required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }

  const list = symbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 20);

  const settled = await Promise.allSettled(list.map(s => fetchSingleQuote(s)));

  const result = {};
  for (let i = 0; i < list.length; i++) {
    if (settled[i].status === 'fulfilled' && settled[i].value) {
      result[list[i]] = settled[i].value;
    }
  }

  return new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=60', ...CORS },
  });
}
