import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase';

// ─── SNOTEL (USDA snow sensors — free, real, updated daily) ──────────────────
// Maps each resort to the nearest SNOTEL station that measures snow depth
const RESORT_SNOTEL = {
  'Palisades Tahoe':      '784:CA:SNTL',  // Squaw Valley station, 6190ft
  'Northstar California': '695:CA:SNTL',  // Norden station, 6700ft
  'Sugar Bowl':           '695:CA:SNTL',  // Norden station, 6700ft
  'Boreal':               '695:CA:SNTL',  // Norden station, 6700ft
  'Donner Ski Ranch':     '695:CA:SNTL',  // Norden station, 6700ft
  'Soda Springs':         '695:CA:SNTL',  // Norden station, 6700ft
  'Heavenly':             '539:CA:SNTL',  // Kirkwood Meadows station, 7600ft
  'Kirkwood':             '539:CA:SNTL',  // Kirkwood Meadows station, 7600ft
  'Sierra-at-Tahoe':      '539:CA:SNTL',  // Kirkwood Meadows station, 7600ft
  'Mt. Rose':             '637:NV:SNTL',  // Mt Rose Summit station, 8640ft
  'Diamond Peak':         '637:NV:SNTL',  // Mt Rose Summit station, 8640ft
};

// Fetch snow depth from all SNOTEL stations in one batch request
async function fetchAllSnotel() {
  const today = new Date().toISOString().split('T')[0];
  const uniqueStations = [...new Set(Object.values(RESORT_SNOTEL))].join(',');

  try {
    const url = `https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stationData` +
      `?stationTriplets=${uniqueStations}` +
      `&elements=SNWD` +
      `&beginDate=${today}&endDate=${today}` +
      `&periodRef=END&duration=DAY&granularity=DAILY`;

    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'PowderApp/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`SNOTEL HTTP ${res.status}`);

    const data = await res.json();
    const result = {};

    for (const station of (data || [])) {
      const triplet = station.stationTriplet;
      const snwdEntry = station.data?.find(d => d.elementCd === 'SNWD');
      const val = snwdEntry?.values?.[0];
      if (val !== null && val !== undefined && !isNaN(val) && val > 0) {
        result[triplet] = Math.round(val);
      }
    }

    console.log('SNOTEL data fetched:', result);
    return result;
  } catch (e) {
    console.error('SNOTEL fetch failed:', e.message);
    return {};
  }
}

// ─── HTML HELPERS ─────────────────────────────────────────────────────────────
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Deep search for a key in a nested object
function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = deepFind(val, keys);
      if (found !== null && found !== undefined) return found;
    }
  }
  return null;
}

// Parse lifts, trails, status from a resort's page text
function parseOpsFromText(text) {
  // Lifts open/total
  const liftsPatterns = [
    /(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i,
    /lifts?\s*(?:open|operating|running)?\s*:?\s*(\d+)\s*(?:of|\/|out of)\s*(\d+)/i,
    /(\d+)\s*lifts?\s*open/i,
  ];
  let lifts_open = null, lifts_total = null;
  for (const p of liftsPatterns) {
    const m = text.match(p);
    if (m) { lifts_open = parseInt(m[1]); lifts_total = m[2] ? parseInt(m[2]) : null; break; }
  }

  // Trails open/total
  const trailsPatterns = [
    /(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:trails|runs)/i,
    /(?:trails|runs)\s*(?:open)?\s*:?\s*(\d+)\s*(?:of|\/|out of)\s*(\d+)/i,
  ];
  let trails_open = null, trails_total = null;
  for (const p of trailsPatterns) {
    const m = text.match(p);
    if (m) { trails_open = parseInt(m[1]); trails_total = m[2] ? parseInt(m[2]) : null; break; }
  }

  // Season total
  const seasonPatterns = [
    /season\s*(?:total|snowfall|snow)?\s*:?\s*(\d+)/i,
    /(\d+)["\s]*(?:inches?|in|")\s*(?:season|ytd|year)/i,
  ];
  let season_total = null;
  for (const p of seasonPatterns) {
    const m = text.match(p);
    if (m && parseInt(m[1]) > 10) { season_total = parseInt(m[1]); break; }
  }

  // Status
  const isClosed = /closed\s+for\s+(?:the\s+)?season|season\s+(?:has\s+)?ended|not\s+open/i.test(text);
  const isOpen = /(?:resort|mountain)\s+(?:is\s+)?open|lifts?\s+(?:are\s+)?(?:open|operating)/i.test(text);

  return {
    status: isClosed ? 'closed' : isOpen ? 'open' : 'partial',
    season_total,
    lifts_open,
    lifts_total,
    trails_open,
    trails_total,
  };
}

// ─── VAIL RESORTS — get lifts/trails/status from their API ───────────────────
async function scrapeVailOps(resortSlug) {
  try {
    const url = `https://www.${resortSlug}.com/api/reporting/snowreport`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    const statusRaw = deepFind(d, ['resortStatus', 'status', 'resortOpen']);
    const liftsOpen = deepFind(d, ['liftsOpen', 'openLifts', 'openLiftCount']);
    const liftsTotal = deepFind(d, ['liftsTotal', 'totalLifts', 'totalLiftCount']);
    const trailsOpen = deepFind(d, ['trailsOpen', 'openTrails', 'openRunCount', 'openTrailCount']);
    const trailsTotal = deepFind(d, ['trailsTotal', 'totalTrails', 'totalRunCount', 'totalTrailCount']);
    const seasonTotal = deepFind(d, ['seasonSnowfall', 'seasonTotal', 'snowfallSeason', 'ytdSnowfall']);

    return {
      status: statusRaw === 'Open' || statusRaw === true ? 'open'
            : statusRaw === 'Closed' || statusRaw === false ? 'closed' : 'partial',
      season_total: seasonTotal ? parseInt(seasonTotal) : null,
      lifts_open: liftsOpen !== null ? parseInt(liftsOpen) : null,
      lifts_total: liftsTotal !== null ? parseInt(liftsTotal) : null,
      trails_open: trailsOpen !== null ? parseInt(trailsOpen) : null,
      trails_total: trailsTotal !== null ? parseInt(trailsTotal) : null,
    };
  } catch (e) {
    // Fallback: scrape HTML
    try {
      const html = await fetchHtml(`https://www.${resortSlug}.com/the-mountain/mountain-conditions/snow-report.aspx`);
      const $ = cheerio.load(html);
      return parseOpsFromText($('body').text());
    } catch { return {}; }
  }
}

// ─── INDIVIDUAL RESORT OPS SCRAPERS ──────────────────────────────────────────
async function scrapePalisadesOps() {
  try {
    const html = await fetchHtml('https://www.palisadestahoe.com/mountain-information/snow-report');
    const $ = cheerio.load(html);
    return parseOpsFromText($('body').text());
  } catch { return {}; }
}

async function scrapeHtmlOps(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    return parseOpsFromText($('body').text());
  } catch { return {}; }
}

// ─── COMBINE SNOTEL + OPS DATA ────────────────────────────────────────────────
async function scrapeAll() {
  // 1. Fetch all SNOTEL snow depths in one request
  const snotelData = await fetchAllSnotel();

  // 2. Fetch ops data (lifts, trails, status) per resort concurrently
  const [
    palisadesOps,
    northstarOps,
    sugarBowlOps,
    borealOps,
    donnerOps,
    sodaOps,
    heavenlyOps,
    kirkwoodOps,
    sierraOps,
    mtRoseOps,
    diamondOps,
  ] = await Promise.allSettled([
    scrapePalisadesOps(),
    scrapeVailOps('northstarcalifornia'),
    scrapeHtmlOps('https://www.sugarbowl.com/conditions'),
    scrapeHtmlOps('https://www.borealski.com/mountain-conditions/'),
    scrapeHtmlOps('https://www.donnerskiranch.com/ski-report/'),
    scrapeHtmlOps('https://skisodasprings.com/snow-report/'),
    scrapeVailOps('skiheavenly'),
    scrapeVailOps('kirkwood'),
    scrapeHtmlOps('https://www.sierraattahoe.com/conditions'),
    scrapeHtmlOps('https://skirose.com/snow-report/'),
    scrapeHtmlOps('https://www.diamondpeak.com/mountain/snow-report'),
  ]).then(results => results.map(r => r.status === 'fulfilled' ? r.value : {}));

  // 3. Build final records — SNOTEL base depth + ops data
  const resorts = [
    { name: 'Palisades Tahoe',      ops: palisadesOps },
    { name: 'Northstar California', ops: northstarOps },
    { name: 'Sugar Bowl',           ops: sugarBowlOps },
    { name: 'Boreal',               ops: borealOps },
    { name: 'Donner Ski Ranch',     ops: donnerOps },
    { name: 'Soda Springs',         ops: sodaOps },
    { name: 'Heavenly',             ops: heavenlyOps },
    { name: 'Kirkwood',             ops: kirkwoodOps },
    { name: 'Sierra-at-Tahoe',      ops: sierraOps },
    { name: 'Mt. Rose',             ops: mtRoseOps },
    { name: 'Diamond Peak',         ops: diamondOps },
  ];

  return resorts.map(({ name, ops }) => {
    const stationId = RESORT_SNOTEL[name];
    const base_inches = stationId ? (snotelData[stationId] ?? null) : null;
    return {
      name,
      status: ops.status || 'partial',
      base_inches,
      season_total: ops.season_total || null,
      lifts_open: ops.lifts_open ?? null,
      lifts_total: ops.lifts_total ?? null,
      trails_open: ops.trails_open ?? null,
      trails_total: ops.trails_total ?? null,
    };
  });
}

// ─── ROUTE ────────────────────────────────────────────────────────────────────
export async function GET(request) {
  // Allow: manual calls with x-scrape-secret header, query param, or Vercel cron
  const secret = request.headers.get('x-scrape-secret');
  const url = new URL(request.url);
  const querySecret = url.searchParams.get('secret');
  const authHeader = request.headers.get('authorization');
  const isVercelCron = authHeader === `Bearer ${process.env.CRON_SECRET}`;

  const isAuthorized = secret === process.env.SCRAPE_SECRET
    || querySecret === process.env.SCRAPE_SECRET
    || isVercelCron;

  if (!isAuthorized && process.env.NODE_ENV === 'production') {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await scrapeAll();
  const errors = [];

  for (const resort of data) {
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
