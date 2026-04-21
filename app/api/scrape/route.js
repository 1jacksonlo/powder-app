import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase';

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseInches(text) {
  if (!text) return null;
  const m = text.match(/(\d+)/);
  const v = m ? parseInt(m[1]) : null;
  return v && v > 0 ? v : null;
}

function parseSlash(text) {
  if (!text) return null;
  const m = text?.match(/(\d+)\s*(?:\/|of)\s*(\d+)/);
  if (m) return { open: parseInt(m[1]), total: parseInt(m[2]) };
  const n = text?.match(/(\d+)/);
  return n ? { open: parseInt(n[1]), total: null } : null;
}

// Extract JSON embedded in <script> tags (window.__STATE__, next data, etc.)
function extractScriptJson($) {
  let data = null;
  $('script').each((i, el) => {
    const src = $(el).html() || '';
    // Next.js __NEXT_DATA__
    const nextM = src.match(/__NEXT_DATA__\s*=\s*(\{[\s\S]+?\})\s*<\/script>/);
    if (nextM) { try { data = JSON.parse(nextM[1]); return false; } catch (e) {} }
    // window.__STATE__ or similar
    const stateM = src.match(/window\.__(?:STATE|DATA|APP)__\s*=\s*(\{[\s\S]+?\});/);
    if (stateM) { try { data = JSON.parse(stateM[1]); return false; } catch (e) {} }
  });
  return data;
}

// Deep search for a key in a nested object
function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = deepFind(val, keys);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

// ─── VAIL RESORTS (Heavenly, Northstar, Kirkwood) ────────────────────────────
async function scrapeVail(resortSlug) {
  // Try multiple API endpoint formats
  const endpoints = [
    `https://www.${resortSlug}.com/api/reporting/snowreport`,
    `https://www.${resortSlug}.com/api/snowreport`,
    `https://www.${resortSlug}.com/the-mountain/mountain-conditions/snow-report.aspx`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json, text/html, */*',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        const d = await res.json();
        // Try many possible field name combinations
        const base = deepFind(d, [
          'snowDepthBase', 'baseSnowDepth', 'baseDepth', 'snowDepth',
          'base_snow_depth', 'baseSnow', 'snowBase', 'primaryBaseDepth',
        ]);
        const liftsOpen = deepFind(d, ['liftsOpen', 'openLifts', 'lifts_open', 'openLiftCount']);
        const liftsTotal = deepFind(d, ['liftsTotal', 'totalLifts', 'lifts_total', 'totalLiftCount']);
        const trailsOpen = deepFind(d, ['trailsOpen', 'openTrails', 'trails_open', 'openRunCount']);
        const trailsTotal = deepFind(d, ['trailsTotal', 'totalTrails', 'trails_total', 'totalRunCount']);
        const seasonTotal = deepFind(d, ['seasonSnowfall', 'seasonTotal', 'season_snowfall', 'snowfallSeason', 'ytdSnowfall']);
        const statusRaw = deepFind(d, ['resortStatus', 'status', 'resortOpen', 'isOpen']);

        if (base !== null || liftsOpen !== null) {
          return {
            status: statusRaw === 'Open' || statusRaw === true ? 'open'
                  : statusRaw === 'Closed' || statusRaw === false ? 'closed' : 'partial',
            base_inches: base ? parseInt(base) : null,
            season_total: seasonTotal ? parseInt(seasonTotal) : null,
            lifts_open: liftsOpen ? parseInt(liftsOpen) : null,
            lifts_total: liftsTotal ? parseInt(liftsTotal) : null,
            trails_open: trailsOpen ? parseInt(trailsOpen) : null,
            trails_total: trailsTotal ? parseInt(trailsTotal) : null,
          };
        }
      }
    } catch (e) { /* try next */ }
  }

  // Fallback: scrape HTML
  try {
    const html = await fetchHtml(`https://www.${resortSlug}.com/the-mountain/mountain-conditions/snow-report.aspx`);
    const $ = cheerio.load(html);
    const text = $('body').text();
    return parseSnowText(text, $);
  } catch { return null; }
}

// ─── PALISADES TAHOE ─────────────────────────────────────────────────────────
async function scrapePalisades() {
  // Try their JSON API first
  const apiUrls = [
    'https://www.palisadestahoe.com/api/resort-conditions',
    'https://www.palisadestahoe.com/api/snow-report',
    'https://www.palisadestahoe.com/api/snowReport',
  ];
  for (const url of apiUrls) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok && res.headers.get('content-type')?.includes('json')) {
        const d = await res.json();
        const base = deepFind(d, ['snowDepthBase', 'baseDepth', 'base', 'baseSnowDepth']);
        if (base) return {
          status: 'open',
          base_inches: parseInt(base),
          season_total: deepFind(d, ['seasonSnowfall', 'seasonTotal']) || null,
          lifts_open: deepFind(d, ['liftsOpen', 'openLifts']) || null,
          lifts_total: deepFind(d, ['liftsTotal', 'totalLifts']) || null,
          trails_open: deepFind(d, ['trailsOpen', 'openTrails']) || null,
          trails_total: deepFind(d, ['trailsTotal', 'totalTrails']) || null,
        };
      }
    } catch {}
  }

  // HTML fallback
  try {
    const html = await fetchHtml('https://www.palisadestahoe.com/mountain-information/snow-report');
    const $ = cheerio.load(html);
    const text = $('body').text();
    return parseSnowText(text, $);
  } catch { return null; }
}

// ─── SUGAR BOWL ───────────────────────────────────────────────────────────────
async function scrapeSugarBowl() {
  try {
    const html = await fetchHtml('https://www.sugarbowl.com/conditions');
    const $ = cheerio.load(html);
    const text = $('body').text();
    return parseSnowText(text, $);
  } catch { return null; }
}

// ─── MT. ROSE ─────────────────────────────────────────────────────────────────
async function scrapeMtRose() {
  try {
    const html = await fetchHtml('https://skirose.com/snow-report/');
    const $ = cheerio.load(html);
    const text = $('body').text();
    return parseSnowText(text, $);
  } catch { return null; }
}

// ─── DIAMOND PEAK ─────────────────────────────────────────────────────────────
async function scrapeDiamondPeak() {
  try {
    const html = await fetchHtml('https://www.diamondpeak.com/mountain/snow-report');
    const $ = cheerio.load(html);
    const text = $('body').text();
    return parseSnowText(text, $);
  } catch { return null; }
}

// ─── GENERIC SNOW TEXT PARSER ─────────────────────────────────────────────────
// Used by all HTML scrapers — handles many different text formats
function parseSnowText(text, $) {
  // Base depth — many formats:
  // "48" base", "Base: 48"", "Base Depth 48 inches", "48 inches base"
  const basePatterns = [
    /(\d+)["\s]*(?:inches?|in|")\s*(?:of\s+)?base/i,
    /base\s*(?:depth|snow)?\s*:?\s*(\d+)/i,
    /(\d+)["']?\s*base\s*depth/i,
    /base\s*(?:depth)?\s*(?:is|=|:)?\s*(\d+)/i,
    /(\d+)\s*(?:"|inches?)\s*(?:base|summit|mid)/i,
  ];
  let base_inches = null;
  for (const p of basePatterns) {
    const m = text.match(p);
    if (m && parseInt(m[1]) > 0) { base_inches = parseInt(m[1]); break; }
  }

  // Season total
  const seasonPatterns = [
    /season\s*(?:total|snowfall|snow)?\s*:?\s*(\d+)/i,
    /(\d+)["\s]*(?:inches?|in|")\s*(?:season|ytd|year)/i,
    /(\d+)\s*(?:"|inches?)\s*season\s*total/i,
  ];
  let season_total = null;
  for (const p of seasonPatterns) {
    const m = text.match(p);
    if (m && parseInt(m[1]) > 0) { season_total = parseInt(m[1]); break; }
  }

  // Lifts open/total
  const liftsPatterns = [
    /(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i,
    /lifts?\s*(?:open|running)?\s*:?\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
    /open\s*lifts?\s*:?\s*(\d+)/i,
  ];
  let lifts_open = null, lifts_total = null;
  for (const p of liftsPatterns) {
    const m = text.match(p);
    if (m) {
      lifts_open = parseInt(m[1]);
      lifts_total = m[2] ? parseInt(m[2]) : null;
      break;
    }
  }

  // Trails open/total
  const trailsPatterns = [
    /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:trails|runs)/i,
    /(?:trails|runs)\s*(?:open)?\s*:?\s*(\d+)\s*(?:of|\/)\s*(\d+)/i,
    /open\s*(?:trails|runs)\s*:?\s*(\d+)/i,
  ];
  let trails_open = null, trails_total = null;
  for (const p of trailsPatterns) {
    const m = text.match(p);
    if (m) {
      trails_open = parseInt(m[1]);
      trails_total = m[2] ? parseInt(m[2]) : null;
      break;
    }
  }

  // Status
  const isOpen = /resort\s*(?:is\s*)?open|lifts?\s*(?:are\s*)?open|skiing\s*(?:is\s*)?open|now\s*open/i.test(text);
  const isClosed = /resort\s*(?:is\s*)?closed|season\s*(?:is\s*)?over|closed\s*for\s*(?:the\s*)?season/i.test(text);

  return {
    status: isClosed ? 'closed' : isOpen || base_inches ? 'open' : 'partial',
    base_inches,
    season_total,
    lifts_open,
    lifts_total,
    trails_open,
    trails_total,
  };
}

// ─── RESORT CONFIG ────────────────────────────────────────────────────────────
async function scrapeAll() {
  const results = await Promise.allSettled([
    scrapePalisades().then(d => ({ name: 'Palisades Tahoe', ...d })),
    scrapeVail('northstarcalifornia').then(d => ({ name: 'Northstar California', ...d })),
    scrapeSugarBowl().then(d => ({ name: 'Sugar Bowl', ...d })),
    fetchHtml('https://www.borealski.com/mountain-conditions/').then(async html => {
      const $ = cheerio.load(html);
      return { name: 'Boreal', ...parseSnowText($('body').text(), $) };
    }).catch(() => ({ name: 'Boreal' })),
    fetchHtml('https://www.donnerskiranch.com/ski-report/').then(async html => {
      const $ = cheerio.load(html);
      return { name: 'Donner Ski Ranch', ...parseSnowText($('body').text(), $) };
    }).catch(() => ({ name: 'Donner Ski Ranch' })),
    fetchHtml('https://skisodasprings.com/snow-report/').then(async html => {
      const $ = cheerio.load(html);
      return { name: 'Soda Springs', ...parseSnowText($('body').text(), $) };
    }).catch(() => ({ name: 'Soda Springs' })),
    scrapeVail('skiheavenly').then(d => ({ name: 'Heavenly', ...d })),
    scrapeVail('kirkwood').then(d => ({ name: 'Kirkwood', ...d })),
    fetchHtml('https://www.sierraattahoe.com/conditions').then(async html => {
      const $ = cheerio.load(html);
      return { name: 'Sierra-at-Tahoe', ...parseSnowText($('body').text(), $) };
    }).catch(() => ({ name: 'Sierra-at-Tahoe' })),
    scrapeMtRose().then(d => ({ name: 'Mt. Rose', ...d })),
    scrapeDiamondPeak().then(d => ({ name: 'Diamond Peak', ...d })),
  ]);

  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// ─── ROUTE ────────────────────────────────────────────────────────────────────
export async function GET(request) {
  const secret = request.headers.get('x-scrape-secret');
  if (secret !== process.env.SCRAPE_SECRET && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await scrapeAll();
  const errors = [];

  for (const resort of data) {
    if (!resort.name) continue;
    const { name, ...fields } = resort;
    const { error } = await supabaseAdmin
      .from('resort_conditions')
      .upsert(
        { resort_name: name, ...fields, scraped_at: new Date().toISOString() },
        { onConflict: 'resort_name' }
      );
    if (error) errors.push({ resort: name, error: error.message });
  }

  return Response.json({ scraped: data.length, data, errors });
}
