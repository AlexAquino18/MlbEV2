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

async function fetchMlbJson(pathname, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `https://statsapi.mlb.com${pathname}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) return null;
  return resp.json();
}

function toNum(value) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeRankings(rankings = []) {
  const cleaned = (Array.isArray(rankings) ? rankings : [])
    .filter(r => r && r.team)
    .map(r => ({
      rank: toNum(r.rank) || null,
      team: String(r.team || '').trim().toUpperCase(),
      games: toNum(r.games),
      pa: toNum(r.pa),
      ab: toNum(r.ab),
      r: toNum(r.r),
      h: toNum(r.h),
      hr: toNum(r.hr),
      so: toNum(r.so),
      kPct: r.kPct != null && r.kPct !== '' ? String(r.kPct) : null,
      ops: r.ops != null && r.ops !== '' ? String(r.ops) : null,
      derived: !!r.derived
    }))
    .filter(r => r.team.length === 3);

  cleaned.sort((a, b) => {
    const ar = a.rank == null ? 999 : a.rank;
    const br = b.rank == null ? 999 : b.rank;
    return ar - br;
  });
  return cleaned;
}

async function buildDerivedRhpRankingsFromMlb(season, lhpRankings) {
  try {
    const teamsData = await fetchMlbJson('/api/v1/teams', { sportId: 1, season });
    const teams = Array.isArray(teamsData?.teams) ? teamsData.teams : [];
    if (!teams.length || !Array.isArray(lhpRankings) || !lhpRankings.length) return [];

    const lhpMap = new Map(lhpRankings.map(r => [String(r.team || '').toUpperCase(), r]));
    const rows = [];

    for (const team of teams) {
      const teamCode = String(team.abbreviation || '').toUpperCase();
      if (!teamCode) continue;
      const seasonStats = await fetchMlbJson(`/api/v1/teams/${team.id}/stats`, {
        stats: 'season',
        group: 'hitting',
        season,
        sportId: 1
      });
      const total = seasonStats?.stats?.[0]?.splits?.[0]?.stat;
      if (!total) continue;

      const lhp = lhpMap.get(teamCode) || {};
      const pa = Math.max(0, toNum(total.plateAppearances) - toNum(lhp.pa));
      const ab = Math.max(0, toNum(total.atBats) - toNum(lhp.ab));
      const r = Math.max(0, toNum(total.runs) - toNum(lhp.r));
      const h = Math.max(0, toNum(total.hits) - toNum(lhp.h));
      const hr = Math.max(0, toNum(total.homeRuns) - toNum(lhp.hr));
      const so = Math.max(0, toNum(total.strikeOuts) - toNum(lhp.so));
      const games = toNum(total.gamesPlayed) || 0;
      const kPctNum = pa > 0 ? (so / pa) * 100 : 0;
      rows.push({
        rank: null,
        team: teamCode,
        games,
        pa,
        ab,
        r,
        h,
        hr,
        so,
        kPct: kPctNum > 0 ? kPctNum.toFixed(1) : null,
        ops: null,
        derived: true
      });
    }

    rows.sort((a, b) => toNum(b.kPct) - toNum(a.kPct));
    rows.forEach((row, idx) => { row.rank = idx + 1; });
    return rows;
  } catch {
    return [];
  }
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
      let chosenStatus = 404;
      let chosenSeason = String(requestedSeason);
      let rankings = [];
      let sourceUsed = 'unavailable';
      let quality = 'unavailable';

      for (const s of seasonCandidates) {
        const tryUrl = buildBrUrl(rest.hand || 'lhp', s);
        const upstream = await fetch(tryUrl, { headers });
        const body = await upstream.text();
        const parsed = upstream.ok ? parseBrSplitRanks(body) : [];

        chosenStatus = upstream.status;
        chosenSeason = String(s);
        rankings = parsed;

        if (upstream.ok && parsed.length) {
          sourceUsed = s === requestedSeason ? 'live_br' : 'season_fallback_br';
          quality = s === requestedSeason ? 'high' : 'medium';
          break;
        }
      }

      let bundledUsed = false;
      let derivedUsed = false;
      if (!rankings.length) {
        const preferredBundledHand = String(rest.hand || 'lhp').toLowerCase().startsWith('r') ? 'lhp' : (rest.hand || 'lhp');
        const bundled = loadBundledBrHtml(preferredBundledHand);
        if (bundled) {
          const bundledParsed = parseBrSplitRanks(bundled);
          if (String(rest.hand || 'lhp').toLowerCase().startsWith('r')) {
            const derived = await buildDerivedRhpRankingsFromMlb(chosenSeason, bundledParsed);
            rankings = derived.length ? derived : bundledParsed;
            derivedUsed = derived.length > 0;
            sourceUsed = derivedUsed ? 'derived_mlb_totals' : 'bundled_br';
            quality = derivedUsed ? 'medium' : 'low';
          } else {
            rankings = bundledParsed;
            sourceUsed = 'bundled_br';
            quality = 'low';
          }
          bundledUsed = rankings.length > 0;
        }
      }

      rankings = normalizeRankings(rankings);

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
           fallbackUsed: chosenSeason !== String(rest.season || requestedSeason) || bundledUsed || derivedUsed,
           derivedFromMlbTotals: derivedUsed,
           upstreamStatus: chosenStatus,
           sourceUsed,
           dataQuality: rankings.length ? quality : 'unavailable',
           asOf: new Date().toISOString()
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
