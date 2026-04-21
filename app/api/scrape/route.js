import * as cheerio from 'cheerio';
import { supabaseAdmin } from '@/lib/supabase';

// ─── SCRAPERS ───────────────────────────────────────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PowderApp/1.0)' },
    signal: AbortSignal.timeout(10000),
  });
  return res.text();
}

// Parses numbers like "12/40", "12 of 40", or just "12"
function parseSlash(text) {
  const m = text?.match(/(\d+)\s*(?:\/|of)\s*(\d+)/);
  if (m) return { open: parseInt(m[1]), total: parseInt(m[2]) };
  const n = text?.match(/(\d+)/);
  return n ? { open: parseInt(n[1]), total: null } : null;
}

function parseInches(text) {
  const m = text?.match(/(\d+)/);
  return m ? parseInt(m[1]) : null;
}

// ─── VAIL RESORTS (Heavenly, Northstar, Kirkwood) ────────────────────────────
async function scrapeVail(resortSlug) {
  try {
    const url = `https://www.${resortSlug}.com/api/reporting/snowreport`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      const d = await res.json();
      return {
        status: d.resortStatus === 'Open' ? 'open' : d.resortStatus === 'Closed' ? 'closed' : 'partial',
        base_inches: d.snowDepthBase || d.snowReport?.snowDepthBase || null,
        season_total: d.seasonSnowfall || null,
        lifts_open: d.liftsOpen || null,
        lifts_total: d.liftsTotal || null,
        trails_open: d.trailsOpen || null,
        trails_total: d.trailsTotal || null,
      };
    }
  } catch {}

  // Fallback: scrape HTML
  try {
    const slugMap = { skiheavenly: 'heavenly', northstarcalifornia: 'northstar', kirkwood: 'kirkwood' };
    const html = await fetchHtml(`https://www.${resortSlug}.com/the-mountain/mountain-conditions/snow-report.aspx`);
    const $ = cheerio.load(html);
    const getText = (sel) => $(sel).first().text().trim();
    return {
      status: 'open',
      base_inches: parseInches(getText('[class*="base"], [class*="Base"]')),
      season_total: parseInches(getText('[class*="season"], [class*="Season"]')),
      lifts_open: parseSlash(getText('[class*="lift"], [class*="Lift"]'))?.open || null,
      lifts_total: parseSlash(getText('[class*="lift"], [class*="Lift"]'))?.total || null,
      trails_open: parseSlash(getText('[class*="trail"], [class*="Trail"]'))?.open || null,
      trails_total: parseSlash(getText('[class*="trail"], [class*="Trail"]'))?.total || null,
    };
  } catch { return null; }
}

// ─── PALISADES TAHOE ─────────────────────────────────────────────────────────
async function scrapePalisades() {
  try {
    const html = await fetchHtml('https://www.palisadestahoe.com/mountain-information/snow-report');
    const $ = cheerio.load(html);
    const text = $('body').text();
    const baseM = text.match(/base[^0-9]*(\d+)["\s]*in/i);
    const liftsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i);
    const trailsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*trails/i);
    return {
      status: 'open',
      base_inches: baseM ? parseInt(baseM[1]) : null,
      season_total: null,
      lifts_open: liftsM ? parseInt(liftsM[1]) : null,
      lifts_total: liftsM ? parseInt(liftsM[2]) : null,
      trails_open: trailsM ? parseInt(trailsM[1]) : null,
      trails_total: trailsM ? parseInt(trailsM[2]) : null,
    };
  } catch { return null; }
}

// ─── SUGAR BOWL ───────────────────────────────────────────────────────────────
async function scrapeSugarBowl() {
  try {
    const html = await fetchHtml('https://www.sugarbowl.com/conditions');
    const $ = cheerio.load(html);
    const text = $('body').text();
    const baseM = text.match(/(\d+)["']?\s*(?:inches|in|")\s*base/i) || text.match(/base[^0-9]*(\d+)/i);
    const liftsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i);
    const trailsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:trails|runs)/i);
    return {
      status: 'open',
      base_inches: baseM ? parseInt(baseM[1]) : null,
      season_total: null,
      lifts_open: liftsM ? parseInt(liftsM[1]) : null,
      lifts_total: liftsM ? parseInt(liftsM[2]) : null,
      trails_open: trailsM ? parseInt(trailsM[1]) : null,
      trails_total: trailsM ? parseInt(trailsM[2]) : null,
    };
  } catch { return null; }
}

// ─── MT. ROSE ─────────────────────────────────────────────────────────────────
async function scrapeMtRose() {
  try {
    const html = await fetchHtml('https://skirose.com/snow-report/');
    const $ = cheerio.load(html);
    const text = $('body').text();
    const baseM = text.match(/(\d+)["\s]*(?:inches|in|")\s*(?:base|summit|mid)/i) || text.match(/base[^0-9]*(\d+)/i);
    const liftsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i);
    const trailsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:trails|runs)/i);
    return {
      status: 'open',
      base_inches: baseM ? parseInt(baseM[1]) : null,
      season_total: null,
      lifts_open: liftsM ? parseInt(liftsM[1]) : null,
      lifts_total: liftsM ? parseInt(liftsM[2]) : null,
      trails_open: trailsM ? parseInt(trailsM[1]) : null,
      trails_total: trailsM ? parseInt(trailsM[2]) : null,
    };
  } catch { return null; }
}

// ─── DIAMOND PEAK ─────────────────────────────────────────────────────────────
async function scrapeDiamondPeak() {
  try {
    const html = await fetchHtml('https://www.diamondpeak.com/mountain/snow-report');
    const $ = cheerio.load(html);
    const text = $('body').text();
    const baseM = text.match(/(\d+)["\s]*(?:inches|in|")\s*(?:base|summit)/i) || text.match(/base[^0-9]*(\d+)/i);
    const liftsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i);
    const trailsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:trails|runs)/i);
    return {
      status: 'open',
      base_inches: baseM ? parseInt(baseM[1]) : null,
      season_total: null,
      lifts_open: liftsM ? parseInt(liftsM[1]) : null,
      lifts_total: liftsM ? parseInt(liftsM[2]) : null,
      trails_open: trailsM ? parseInt(trailsM[1]) : null,
      trails_total: trailsM ? parseInt(trailsM[2]) : null,
    };
  } catch { return null; }
}

// ─── GENERIC SCRAPER (Boreal, Donner, Soda Springs, Sierra-at-Tahoe) ─────────
async function scrapeGeneric(url) {
  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const text = $('body').text();
    const baseM = text.match(/(\d+)["\s]*(?:"|inches|in)?\s*(?:base|summit|mid[- ]?mountain)/i)
                || text.match(/base[^0-9]{0,20}?(\d+)/i);
    const liftsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*lifts/i)
                 || text.match(/lifts[^0-9]{0,10}(\d+)\s*(?:of|\/)\s*(\d+)/i);
    const trailsM = text.match(/(\d+)\s*(?:of|\/)\s*(\d+)\s*(?:trails|runs)/i)
                  || text.match(/(?:trails|runs)[^0-9]{0,10}(\d+)\s*(?:of|\/)\s*(\d+)/i);
    const isOpen = /resort.*open|lifts.*open|skiing.*open|open.*skiing/i.test(text);
    const isClosed = /resort.*closed|no skiing|not open/i.test(text);
    return {
      status: isClosed ? 'closed' : isOpen ? 'open' : 'partial',
      base_inches: baseM ? parseInt(baseM[1]) : null,
      season_total: null,
      lifts_open: liftsM ? parseInt(liftsM[1]) : null,
      lifts_total: liftsM ? parseInt(liftsM[2]) : null,
      trails_open: trailsM ? parseInt(trailsM[1]) : null,
      trails_total: trailsM ? parseInt(trailsM[2]) : null,
    };
  } catch { return null; }
}

// ─── RESORT CONFIG ────────────────────────────────────────────────────────────
async function scrapeAll() {
  const results = await Promise.allSettled([
    scrapePalisades().then(d => ({ name: 'Palisades Tahoe', ...d })),
    scrapeVail('northstarcalifornia').then(d => ({ name: 'Northstar California', ...d })),
    scrapeSugarBowl().then(d => ({ name: 'Sugar Bowl', ...d })),
    scrapeGeneric('https://www.borealski.com/mountain-conditions/').then(d => ({ name: 'Boreal', ...d })),
    scrapeGeneric('https://www.donnerskiranch.com/ski-report/').then(d => ({ name: 'Donner Ski Ranch', ...d })),
    scrapeGeneric('https://skisodasprings.com/snow-report/').then(d => ({ name: 'Soda Springs', ...d })),
    scrapeVail('skiheavenly').then(d => ({ name: 'Heavenly', ...d })),
    scrapeVail('kirkwood').then(d => ({ name: 'Kirkwood', ...d })),
    scrapeGeneric('https://www.sierraattahoe.com/conditions').then(d => ({ name: 'Sierra-at-Tahoe', ...d })),
    scrapeMtRose().then(d => ({ name: 'Mt. Rose', ...d })),
    scrapeDiamondPeak().then(d => ({ name: 'Diamond Peak', ...d })),
  ]);

  return results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);
}

// ─── ROUTE ────────────────────────────────────────────────────────────────────
export async function GET(request) {
  // Simple auth check — only allow calls with the right secret
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
