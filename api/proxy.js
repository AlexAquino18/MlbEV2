const ODDS_KEY = process.env.ODDS_API_KEY || 'acb869ede8a223bb73fec28b9290f78dd9fc26e75d58e8427e4c63b3060b5106';
const cache = new Map();

function getTtlMs(source, path) {
  if (source === 'odds' && path === '/events') return 15 * 60 * 1000;
  if (source === 'odds' && path === '/odds/multi') return 15 * 60 * 1000;
  if (source === 'mlb' && path === '/api/v1/schedule') return 10 * 60 * 1000;
  return 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { source = 'odds', path = '', ...rest } = req.query;

  const ttlMs = getTtlMs(source, path);
  let url;
  if (source === 'mlb') {
    // MLB Stats API - free, no key needed
    const params = new URLSearchParams(rest);
    url = `https://statsapi.mlb.com${path}${params.toString() ? '?' + params : ''}`;
  } else {
    // Odds-API.io
    const params = new URLSearchParams({ ...rest, apiKey: ODDS_KEY });
    url = `https://api.odds-api.io/v3${path}?${params}`;
  }

  if (ttlMs > 0) {
    const hit = cache.get(url);
    if (hit && (Date.now() - hit.time) < ttlMs) {
      res.status(hit.status)
         .setHeader('Content-Type', hit.contentType)
         .setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600')
         .setHeader('X-Proxy-Cache', 'HIT')
         .send(hit.body);
      return;
    }
  }

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || 'application/json';

    if (upstream.ok && ttlMs > 0) {
      cache.set(url, { time: Date.now(), status: upstream.status, body, contentType });
    }

    if (upstream.status === 429 && ttlMs > 0) {
      const stale = cache.get(url);
      if (stale) {
        res.status(stale.status)
           .setHeader('Content-Type', stale.contentType)
           .setHeader('Cache-Control', 'public, s-maxage=900, stale-while-revalidate=3600')
           .setHeader('X-Proxy-Cache', 'STALE')
           .send(stale.body);
        return;
      }
    }

    res.status(upstream.status)
       .setHeader('Content-Type', contentType)
       .setHeader('Cache-Control', ttlMs > 0 ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'public, s-maxage=300')
       .setHeader('X-Proxy-Cache', 'MISS')
       .send(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
