import fs from 'node:fs';
import path from 'node:path';

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

function buildBrUrl(hand, season) {
  const handKey = String(hand).toLowerCase().startsWith('r') ? 'RHP' : 'LHP';
  const params = new URLSearchParams({ full: '1', params: `plato|vs ${handKey}|ML|${season}|bat|AB|` });
  return `https://www.baseball-reference.com/split_stats_lg.cgi?${params}`;
}

function loadBundledBrHtml(hand) {
  const preferred = String(hand || 'lhp').toLowerCase().startsWith('r') ? 'br_rhp.html' : 'br_lhp.html';
  const fallbacks = [preferred, 'br_lhp.html', 'br_lhp_test.html'];
  for (const file of fallbacks) {
    try {
      const full = path.join(process.cwd(), file);
      if (fs.existsSync(full)) {
        const html = fs.readFileSync(full, 'utf8');
        if (html && html.length > 1000) return html;
      }
    } catch {}
  }
  return '';
}

function parseBrSplitRanks(html) {
  const stripTags = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim();
  const getCellRaw = (row, stat) => {
    const m = row.match(new RegExp(`data-stat="${stat}"[^>]*>([\\s\\S]*?)<\\/t[dh]>`, 'i'));
    return m ? stripTags(m[1]) : '';
  };
  const toNum = value => {
    const cleaned = String(value || '').replace(/,/g, '').trim();
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  // Parse any row that has both rank and team cells (works even if table id changes)
  const rowMatches = Array.from(html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi));
  return rowMatches.map(match => {
    const row = match[1];
    if (!/data-stat="ranker"/i.test(row) || !/data-stat="team"/i.test(row)) return null;

    const rank = toNum(getCellRaw(row, 'ranker'));
    const team = getCellRaw(row, 'team') || null;
    const games = toNum(getCellRaw(row, 'G'));
    const pa = toNum(getCellRaw(row, 'PA'));
    const ab = toNum(getCellRaw(row, 'AB'));
    const r = toNum(getCellRaw(row, 'R'));
    const h = toNum(getCellRaw(row, 'H'));
    const hr = toNum(getCellRaw(row, 'HR'));
    const so = toNum(getCellRaw(row, 'SO'));
    const opsRaw = getCellRaw(row, 'onbase_plus_slugging');
    const ops = opsRaw || null;
    const kPct = pa > 0 ? ((so / pa) * 100).toFixed(1) : null;
    const rankValue = rank || null;
    return team ? { rank: rankValue, team: team.trim(), games, pa, ab, r, h, hr, so, kPct, ops } : null;
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
    const { hand = 'lhp', season = String(new Date().getFullYear()) } = rest;
    url = buildBrUrl(hand, season);
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

    if (source === 'br') {
      const requestedSeason = Number(rest.season || new Date().getFullYear());
      const seasonCandidates = [requestedSeason, requestedSeason - 1, requestedSeason - 2]
        .filter((v, i, arr) => Number.isFinite(v) && v > 2000 && arr.indexOf(v) === i);
      let chosenBody = '';
      let chosenStatus = 404;
      let chosenContentType = 'text/html';
      let chosenSeason = String(requestedSeason);
      let rankings = [];

      for (const s of seasonCandidates) {
        const tryUrl = buildBrUrl(rest.hand || 'lhp', s);
        const upstream = await fetch(tryUrl, { headers });
        const body = await upstream.text();
        const contentType = upstream.headers.get('content-type') || 'text/html';
        const parsed = upstream.ok ? parseBrSplitRanks(body) : [];

        chosenBody = body;
        chosenStatus = upstream.status;
        chosenContentType = contentType;
        chosenSeason = String(s);
        rankings = parsed;

        if (upstream.ok && parsed.length) break;
      }

      let bundledUsed = false;
      if (!rankings.length) {
        const bundled = loadBundledBrHtml(rest.hand || 'lhp');
        if (bundled) {
          rankings = parseBrSplitRanks(bundled);
          bundledUsed = rankings.length > 0;
        }
      }

      const teamCode = rest.team ? String(rest.team).toUpperCase() : null;
      const teamData = teamCode ? rankings.find(r => r.team === teamCode) || null : null;

      // Always return 200 JSON for source=br so frontend can render fallback rows.
      res.status(200)
         .setHeader('Content-Type', 'application/json')
         .setHeader('Cache-Control', ttlMs > 0 ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'public, s-maxage=300')
         .setHeader('X-Proxy-Cache', 'MISS')
         .json({
           source: 'br',
           hand: String(rest.hand || 'lhp').toLowerCase(),
           season: chosenSeason,
           requestedSeason: String(rest.season || requestedSeason),
           team: teamCode,
           rank: teamData?.rank ?? null,
           teamStats: teamData,
           rankings,
           fallbackUsed: chosenSeason !== String(rest.season || requestedSeason) || bundledUsed,
           upstreamStatus: chosenStatus
         });
      return;
    }

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

    res.status(upstream.status)
       .setHeader('Content-Type', contentType)
       .setHeader('Cache-Control', ttlMs > 0 ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'public, s-maxage=300')
       .setHeader('X-Proxy-Cache', 'MISS')
       .send(body);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
