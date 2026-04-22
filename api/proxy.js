const ODDS_KEY = process.env.ODDS_API_KEY || 'acb869ede8a223bb73fec28b9290f78dd9fc26e75d58e8427e4c63b3060b5106';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { source = 'odds', path = '', ...rest } = req.query;

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

  try {
    const upstream = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const body = await upstream.text();
    res.status(upstream.status)
       .setHeader('Content-Type', 'application/json')
       .setHeader('Cache-Control', 'public, s-maxage=300')
       .send(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
