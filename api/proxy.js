const ODDS_KEY = process.env.ODDS_API_KEY || 'acb869ede8a223bb73fec28b9290f78dd9fc26e75d58e8427e4c63b3060b5106';
const cache = new Map();

function getTtlMs(source, path) {
  if (source === 'odds' && path === '/events') return 15 * 60 * 1000;
  if (source === 'odds' && path === '/odds') return 15 * 60 * 1000;
  if (source === 'odds' && path === '/odds/multi') return 15 * 60 * 1000;
  if (source === 'mlb' && path === '/api/v1/schedule') return 10 * 60 * 1000;
  if (source === 'br') return 30 * 60 * 1000;
  return 0;
}

function parseBrSplitRanks(html) {
  const tableMatch = html.match(/<table[^>]+id="split1"[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return [];
  const rows = Array.from(tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  return rows.map(match => {
    const row = match[1];
    const rank = Number((row.match(/data-stat="ranker"[^>]*>(\d+)/) || [])[1] || 0);
    const team = (row.match(/data-stat="team"[^>]*>([^<]+)/) || [])[1] || null;
    const games = Number((row.match(/data-stat="G"[^>]*>(\d+)/) || [])[1] || 0);
    const ab = Number((row.match(/data-stat="AB"[^>]*>(\d+)/) || [])[1] || 0);
    const r = Number((row.match(/data-stat="R"[^>]*>(\d+)/) || [])[1] || 0);
    const h = Number((row.match(/data-stat="H"[^>]*>(\d+)/) || [])[1] || 0);
    const hr = Number((row.match(/data-stat="HR"[^>]*>(\d+)/) || [])[1] || 0);
    const ops = (row.match(/data-stat="onbase_plus_slugging"[^>]*>([^<]+)/) || [])[1] || null;
    const rankValue = rank || null;
    return team ? { rank: rankValue, team: team.trim(), games, ab, r, h, hr, ops } : null;
  }).filter(Boolean);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { source = 'odds', path = '', ...rest } = req.query;

  const ttlMs = getTtlMs(source, path);
  let url;
  if (source === 'br') {
    const { hand = 'lhp', season = '2026' } = rest;
    const handKey = String(hand).toLowerCase().startsWith('r') ? 'RHP' : 'LHP';
    const params = new URLSearchParams({ full: '1', params: `plato|vs ${handKey}|ML|${season}|bat|AB|` });
    url = `https://www.baseball-reference.com/split_stats_lg.cgi?${params}`;
  } else if (source === 'mlb') {
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
    const headers = { 'User-Agent': 'Mozilla/5.0' };
    if (source === 'br') headers.Accept = 'text/html';
    else headers.Accept = 'application/json';

    const upstream = await fetch(url, { headers });
    const body = await upstream.text();
    const contentType = upstream.headers.get('content-type') || (source === 'br' ? 'text/html' : 'application/json');

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

    if (source === 'br' && upstream.ok) {
      const rankings = parseBrSplitRanks(body);
      const teamCode = rest.team ? String(rest.team).toUpperCase() : null;
      const teamData = teamCode ? rankings.find(r => r.team === teamCode) || null : null;
      const json = {
        source: 'br',
        hand: String(rest.hand || 'lhp').toLowerCase(),
        season: String(rest.season || '2026'),
        team: teamCode,
        rank: teamData?.rank ?? null,
        teamStats: teamData,
        rankings
      };
      res.status(upstream.status)
         .setHeader('Content-Type', 'application/json')
         .setHeader('Cache-Control', ttlMs > 0 ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'public, s-maxage=300')
         .setHeader('X-Proxy-Cache', 'MISS')
         .json(json);
      return;
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
