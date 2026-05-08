import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase';

// ─── SNOTEL (USDA snow sensors) ───────────────────────────────────────────────
// Used ONLY as a fallback for resorts that are open but whose websites we can't scrape.
// SNOTEL measures alpine snowpack (8000ft+), NOT resort base lodge depth.
const RESORT_SNOTEL = {
  'Palisades Tahoe':      '784:CA:SNTL',
  'Northstar California': '541:CA:SNTL',
  'Sugar Bowl':           '784:CA:SNTL',
  'Boreal':               '784:CA:SNTL',
  'Donner Ski Ranch':     '784:CA:SNTL',
  'Soda Springs':         '784:CA:SNTL',
  'Heavenly':             '518:CA:SNTL',
  'Kirkwood':             '1067:CA:SNTL',
  'Sierra-at-Tahoe':      '463:CA:SNTL',
  'Mt. Rose':             '652:NV:SNTL',
  'Diamond Peak':         '652:NV:SNTL',
};

async function fetchSnotelStation(triplet) {
  const url = `https://wcc.sc.egov.usda.gov/reportGenerator/view_csv/customSingleStationReport/daily/start_of_period/${triplet}%7Cid%3D%22%22%7Cname/-5,0/SNWD::value`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/csv,*/*' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const lines = text.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    const dataLines = lines.slice(1).filter(l => l.trim());
    if (!dataLines.length) return null;
    const val = parseFloat(dataLines[dataLines.length - 1].split(',')[1]);
    return (!isNaN(val) && val >= 0) ? Math.round(val) : null;
  } catch { return null; }
}

async function fetchAllSnotel() {
  const uniqueStations = [...new Set(Object.values(RESORT_SNOTEL))];
  const results = await Promise.allSettled(
    uniqueStations.map(t => fetchSnotelStation(t).then(val => ({ t, val })))
  );
  const data = {};
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value.val !== null) data[r.value.t] = r.value.val;
  }
  return data;
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

function deepFind(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  for (const val of Object.values(obj)) {
    if (typeof val === 'object') {
      const found = deepFind(val, keys);
      if (found !== null) return found;
    }
  }
  return null;
}

// ─── BASE DEPTH PARSER ────────────────────────────────────────────────────────
// Extracts base lodge snow depth from resort page text.
// IMPORTANT: allows 0" — a closed resort legitimately has 0" base.
function parseBaseFromText(text) {
  const patterns = [
    // "Base: 0″" or "Base: 36"" (Sierra-at-Tahoe, most resort sites)
    /base\s*(?:depth|area|lodge|elevation)?\s*:?\s*(\d+)\s*(?:"|″|inches?|\bin\b)/i,
    // "0" Base Depth" or "36" Base"
    /(\d+)\s*(?:"|″)\s*base(?:\s+depth)?(?!\s*(?:elevation|lodge|area))/i,
    // "Base Depth  0""
    /base\s+depth[\s\S]{0,30}?(\d+)\s*(?:"|″)/i,
  ];

  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      const val = parseInt(m[1]);
      if (!isNaN(val) && val >= 0 && val <= 300) return val;
    }
  }
  return null;
}

// ─── OPS + BASE PARSER ────────────────────────────────────────────────────────
function parseFromText(text) {
  // Base depth (resort website value — most accurate)
  const base_html = parseBaseFromText(text);

  // Lifts
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

  // Trails
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
    if (m && parseInt(m[1]) > 10 && parseInt(m[1]) < 800) { season_total = parseInt(m[1]); break; }
  }

  // Status
  const isClosed = /closed\s+for\s+(?:the\s+)?season|season\s+(?:has\s+)?ended|not\s+open/i.test(text);
  const isOpen = /(?:resort|mountain)\s+(?:is\s+)?open|lifts?\s+(?:are\s+)?(?:open|operating)/i.test(text);

  return {
    base_html,
    status: isClosed ? 'closed' : isOpen ? 'open' : 'partial',
    season_total,
    lifts_open,
    lifts_total,
    trails_open,
    trails_total,
  };
}

// ─── VAIL RESORTS ─────────────────────────────────────────────────────────────
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
    const baseDepth = deepFind(d, ['baseDepth', 'baseSnow', 'snowDepthBase', 'baseConditions', 'lowerBaseDepth', 'upperBaseDepth', 'snowDepth']);

    return {
      base_html: baseDepth !== null ? parseInt(baseDepth) : null,
      status: statusRaw === 'Open' || statusRaw === true ? 'open'
            : statusRaw === 'Closed' || statusRaw === false ? 'closed' : 'partial',
      season_total: seasonTotal ? parseInt(seasonTotal) : null,
      lifts_open: liftsOpen !== null ? parseInt(liftsOpen) : null,
      lifts_total: liftsTotal !== null ? parseInt(liftsTotal) : null,
      trails_open: trailsOpen !== null ? parseInt(trailsOpen) : null,
      trails_total: trailsTotal !== null ? parseInt(trailsTotal) : null,
    };
  } catch {
    // Fallback: scrape HTML page
    try {
      const html = await fetchHtml(`https://www.${resortSlug}.com/the-mountain/mountain-conditions/snow-report.aspx`);
      const $ = cheerio.load(html);
      return parseFromText($('body').text());
    } catch { return {}; }
  }
}

async function scrapeHtmlOps(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    return parseFromText($('body').text());
  } catch { return {}; }
}

// ─── COMBINE ALL DATA ─────────────────────────────────────────────────────────
async function scrapeAll() {
  // 1. SNOTEL — alpine snowpack, used only as last-resort fallback
  const snotelData = await fetchAllSnotel();

  // 2. Resort ops + base depth from their own websites
  const [
    palisadesOps, northstarOps, sugarBowlOps, borealOps, donnerOps,
    sodaOps, heavenlyOps, kirkwoodOps, sierraOps, mtRoseOps, diamondOps,
  ] = await Promise.allSettled([
    scrapeHtmlOps('https://www.palisadestahoe.com/conditions'),
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

  const records = resorts.map(({ name, ops }) => {
    // Is this resort effectively closed? (0 lifts AND 0 trails open)
    const isEffectivelyClosed =
      ops.status === 'closed' ||
      (ops.lifts_open === 0 && ops.trails_open === 0) ||
      (ops.lifts_open === 0 && ops.trails_open === null && ops.status !== 'open');

    // Base depth priority:
    // 1. Resort's own website (most accurate, includes 0" when closed)
    // 2. 0 if resort is clearly closed and website didn't report
    // 3. SNOTEL only if resort appears open (alpine sensor fallback)
    let base_inches;
    if (ops.base_html !== null && ops.base_html !== undefined) {
      base_inches = ops.base_html;           // Resort's own measurement
    } else if (isEffectivelyClosed) {
      base_inches = 0;                       // Closed = 0" base for skiers
    } else {
      base_inches = snotelData[RESORT_SNOTEL[name]] ?? null; // Open + no website data
    }

    return {
      name,
      status: ops.status || 'partial',
      base_inches,
      season_total: ops.season_total || null,
      lifts_open:   ops.lifts_open  ?? null,
      lifts_total:  ops.lifts_total ?? null,
      trails_open:  ops.trails_open ?? null,
      trails_total: ops.trails_total ?? null,
    };
  });

  return records;
}

// ─── ROUTE ────────────────────────────────────────────────────────────────────
export async function GET(request) {
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

  const records = await scrapeAll();
  const errors = [];

  for (const resort of records) {
    const { name, ...fields } = resort;
    const { error } = await supabaseAdmin
      .from('resort_conditions')
      .upsert(
        { resort_name: name, ...fields, scraped_at: new Date().toISOString() },
        { onConflict: 'resort_name' }
      );
    if (error) errors.push({ resort: name, error: error.message });
  }

  return Response.json({ scraped: records.length, data: records, errors });
}
