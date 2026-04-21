# Powder — US Ski Conditions App
## Claude Code Handoff Document

---

## Project Overview

**Powder** is a mobile-first, single-page web app (one HTML file) for US ski resort conditions. It shows real-time weather, snowfall forecasts, drive times, road conditions, and a trip planner for 48 major US resorts.

**Current state:** Working prototype — fully functional in browser, hosted as a static HTML file. The next step is converting this to a production Next.js app with a real backend, Supabase auth, and Stripe payments.

**File:** `powder-app.html` — 2,851 lines, ~170KB, zero dependencies (vanilla JS + Google Fonts only).

---

## Architecture

### Single-File Structure
```
powder-app.html
├── <style>          CSS (lines 8–400) — CSS variables, all component styles
├── HTML skeleton    Static page structure, nav, modals (lines 401–670)
└── <script>         All JavaScript (lines 671–2851)
    ├── State & constants      (671–750)
    ├── Resort data            (694–748)
    ├── Page navigation        (750–795)
    ├── Open-Meteo integration (815–933)
    ├── Data loading & cache   (934–1155)
    ├── Conditions rendering   (1156–1283)
    ├── Forecast tab           (1284–1520)
    ├── Trip planner wizard    (1521–2338)
    ├── Alerts page            (2339–2388)
    ├── Drive time & Caltrans  (2389–2841)
    └── Init                   (2842–2851)
```

---

## Data Sources

| Data | Source | Accuracy | Cache TTL |
|------|---------|----------|-----------|
| Temperature, wind | Open-Meteo API (free, no key) | ✅ Real | 1 hour |
| Snowfall 24h / 7-day | Open-Meteo `past_days=7` | ✅ Real | 1 hour |
| 7-day snowfall forecast | Open-Meteo `forecast_days=7` | ✅ Real | 1 hour |
| Weather condition pill | WMO weather codes from Open-Meteo | ✅ Real | 1 hour |
| Base depth | Claude AI estimate | ❌ AI only | 4 hours |
| Lifts open / Trails open | Claude AI estimate | ❌ AI only | 4 hours |
| Resort status (open/partial/closed) | Claude AI estimate | ❌ AI only | 4 hours |
| Season total snowfall | Claude AI estimate | ❌ AI only | 4 hours |
| Chain control status (CA) | Caltrans QuickMap KML (live) | ✅ Real | 5 min |
| Drive time | Haversine formula (straight-line) | ⚠️ Estimate | Session |
| Conditions verdict | Claude AI | ⚠️ AI | Session |

**Priority improvement:** Replace Claude AI ops data (base, lifts, trails) with scraped resort website data. Each resort publishes a daily snow report page.

---

## Key Constants & State

### Global State Variables
```javascript
let allData = []          // Array of resort objects — all rendered data lives here
let activeRegion = 'all'  // Current filter tab
let searchTerm = ''       // Search input value
let isPro = false         // Unlocked via localStorage 'powder_pro'='true'
let sortMode = 'base'     // 'base' | 'fresh' | 'name'
let forecastCache = {}    // resortName -> forecast object (session cache)
let driveCache = {}       // resortName -> {time, chain, verdict} (session cache)
let userLocation = null   // {lat, lng, city} from browser geolocation
let caltransData = null   // Parsed KML array from Caltrans (5-min cache)
let wiz = { ... }         // Trip planner wizard state (step, group, dates, etc.)
```

### Cache Keys (localStorage)
```javascript
const CACHE_KEY_WX  = 'powder_wx_v2'   // Open-Meteo weather data
const CACHE_KEY_OPS = 'powder_ops_v2'  // Claude ops data (base, lifts, trails)
const CACHE_TTL_WX  = 60 * 60 * 1000  // 1 hour
const CACHE_TTL_OPS = 4 * 60 * 60 * 1000 // 4 hours
```

### Resort Data Shape
Each resort in `allData` has this shape after merging:
```javascript
{
  // From ALL_RESORTS metadata
  name: "Palisades Tahoe",
  state: "CA",
  region: "california",    // 'california'|'colorado'|'utah'|'wyoming'|'montana'|'idaho'|'pacific_nw'|'northeast'
  pass: "ikon",            // 'epic'|'ikon'|'none'
  camUrl: "https://...",

  // From Claude (ops — AI estimated)
  status: "open",          // 'open'|'partial'|'closed'
  base_inches: 74,
  season_total: 182,
  lifts_open: 24,
  lifts_total: 42,
  trails_open: 120,
  trails_total: 170,

  // From Open-Meteo (real weather)
  new_24h: 4,              // inches yesterday
  new_7day: 12,            // inches past 7 days (actual)
  summit_temp_f: 28,
  wind_mph: 12,
  condition: "powder",     // derived from WMO code
  weather_code: 71,        // WMO code
  _wxSource: "open-meteo", // 'open-meteo'|'ai'

  // Forecast (Open-Meteo, pre-cached)
  _omForecast: [{day:"Mon", date:"2026-04-18", icon:"❄️", snow_inches:3, high_f:28, low_f:14, wind_mph:8, condition:"powder"}, ...],
  _omForecastTotal: 11,    // total inches forecast next 7 days
  _omBestDay: "Wed",       // day with most forecast snow
}
```

---

## APIs Used

### 1. Anthropic Claude API (claude-sonnet-4-6)
- **Endpoint:** `POST https://api.anthropic.com/v1/messages`
- **Auth:** API key in browser (⚠️ must move to server-side proxy for production)
- **Used for:**
  - Resort ops data (base, lifts, trails, status) — batches of 16 resorts
  - 7-day forecast narrative summary (enrichFCSummary)
  - Trip planner AI recommendation (runWizardPlanner)
  - Drive time verdict (loadDriveTime)
  - Mini forecast when Open-Meteo unavailable (loadMiniFC fallback)
- **Cost issue:** Each page load without cache hits Claude 3-4 times at max_tokens:800

### 2. Open-Meteo API
- **Endpoint:** `GET https://api.open-meteo.com/v1/forecast`
- **Auth:** None (completely free, CORS-enabled)
- **Params used:**
  ```
  latitude, longitude      (comma-separated for multi-location)
  daily=snowfall_sum,precipitation_sum,temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max
  current=temperature_2m,weather_code,snowfall,wind_speed_10m
  past_days=7              (actual historical snowfall)
  forecast_days=7          (forward forecast)
  temperature_unit=fahrenheit
  wind_speed_unit=mph
  precipitation_unit=inch
  timezone=auto
  ```
- **Batching:** 10 resorts per call (multi-location API), 5 parallel calls for 48 resorts

### 3. Caltrans QuickMap KML (California chain control only)
- **Endpoint:** `https://quickmap.dot.ca.gov/data/cc.kml`
- **Auth:** None (public)
- **CORS workaround:** Fetched via `https://corsproxy.io/?url=<encoded>`
- **Parse:** Browser DOMParser → extract Placemark nodes → highway, level (R1/R2/R3/closed), GPS coords
- **Cache:** 5 minutes (in-memory, `caltransData` variable)
- **Scope:** California resorts only. CO/UT/WY fall back to snowfall-based estimate

### 4. Nominatim Reverse Geocoding
- **Endpoint:** `https://nominatim.openstreetmap.org/reverse?lat=X&lon=Y&format=json`
- **Auth:** None (free)
- **Used for:** Converting user GPS coords → city name for display

---

## Pages & Navigation

5 pages rendered in `<div class="page" id="page-{name}">`, shown/hidden via JS:

| Page ID | Tab | Pro? | Key function |
|---------|-----|------|-------------|
| `conditions` | 🏔 | Free | `renderConditions()` |
| `watchlist` | ❤️ | Free | `renderWatchlist()` |
| `forecast` | 📅 | Pro | `renderForecastPage()` |
| `planner` | ✈️ | Pro | `renderPlannerPage()` |
| `alerts` | 🔔 | Pro | `renderAlertsPage()` |

### Pro Gating
- `showProPage(id, btn)` — checks `isPro`, redirects to pricing modal if false
- `isPro` = `localStorage.getItem('powder_pro') === 'true'`
- `activatePro()` — sets localStorage, updates UI badges
- **TODO:** Replace localStorage with real Supabase auth + Stripe webhook

---

## Feature Map

### Conditions Page
- Hero with SVG mountain silhouette + animated snowflakes
- Stats strip: resorts count, open count, avg base, best 7-day, total lifts
- Search + region filter tabs + sort (Base/Fresh/A-Z)
- Resort cards with: base depth bar, snowfall metrics, lifts/trails, condition pill, temp badge
- **Live badge** (`⛅ LIVE`) on temp when Open-Meteo data is fresh
- Heart button → watchlist
- 📷 Cam drawer per card → links to official resort webcam
- 7-day forecast mini strip per card (Pro, tap to load from Open-Meteo cache)
- 🚗 Drive row per card (loads on location grant) → Caltrans chain badge + AI verdict

### Forecast Tab (Pro)
- Resort list sorted by 7-day snow
- Select resort → full panel with:
  - Tappable day picker (7 days)
  - Per-day detail: snowfall, high/low, wind, condition
  - Powder day callout
  - 7-day summary stats
  - AI narrative summary (enrichFCSummary — lazy loaded)
  - Source: Open-Meteo real data

### Trip Planner (Pro) — 6-step wizard
```
Step 0: Dates      — departure + return date pickers
Step 1: Group      — add people, set skill level per person
                     live terrain fit preview against top 3 resorts
                     compatibility warning for wide skill ranges
Step 2: Budget     — Under $150 / $150-300 / $300+ / Any
Step 3: Distance   — drive time filter (2/4/6hr/any) with live resort count
Step 4: Region+Pass — multi-select region and Epic/Ikon/No Pass
Step 5: Review     — summary before running
Results:            — AI-powered recommendation with:
                     per-person terrain breakdown for top pick
                     7-day forecast strip
                     full weekend itinerary
                     ranked alternatives with scores
                     budget breakdown
                     pass savings calculation
```

**Key wizard functions:**
- `renderPlannerPage()` — resets wiz state, starts at step 0
- `renderWizStep()` — renders current step
- `stepGroup()` — the enhanced group builder with terrain fit preview
- `runWizardPlanner()` — filters candidates, scores them, calls Claude
- `renderWizResults()` — displays full results including terrain breakdown

**Scoring algorithm** (`runWizardPlanner`):
```javascript
score = forecastSnow * 4       // snow during trip dates
      + overnight_snow * 3
      + base * 0.12
      + (liftsOpen/liftsTotal) * 15
      + groupFitScore * 20     // terrain compatibility
      + proximityScore         // closer = higher
      + passBonus 10           // if user's pass works here
```

### Drive Time & Road Conditions
- Triggered by browser geolocation grant
- **Distance:** Haversine formula (straight-line, adjusted for snow conditions)
- **Speed model:** 55mph clear / 48mph light snow / 42mph moderate / 35mph heavy
- **CA chain control:** Live Caltrans KML → parsed → matched to resort by highway + proximity (80km radius)
- **Other regions:** Estimated from `estimateChainLikelihood(new_24h, new_7day)`
- **AI verdict:** Claude rates "strong yes / yes / borderline / probably not" with pros/cons/tip
- Badge shows `LIVE` or `est.` and links to Caltrans QuickMap or state DOT

---

## Key Data Tables (embedded in JS)

### `ALL_RESORTS` (line 694)
48 resorts: `{name, state, region, pass, camUrl}`

### `RESORT_COORDS` (line 2432)
48 resorts: `{name: [lat, lng]}`

### `LIFT_PRICES` (line 1543)
Walk-up lift ticket prices per resort (48 entries + default $165)

### `TERRAIN_MIX` (line 1561)
`{b:%, i:%, a:%}` — beginner/intermediate/advanced terrain split per resort

### `CA_HIGHWAY_RESORT_MAP` (line 2497)
Maps CA mountain highways (I-80, US-50, SR-89, HWY 395, HWY 18) to which resorts they serve

---

## CSS Design System

```css
/* Colors */
--white: #fff
--off: #f7f8fa         /* page background */
--pale: #eef1f6        /* borders */
--mist: #dde3ed
--steel: #8a97aa       /* secondary text */
--slate: #4a5568       /* body text */
--ink: #1a202c         /* headings */
--blue: #2563eb        /* primary */
--sky: #60a5fa
--frost: #bfdbfe
--green: #16a34a       /* open/good */
--amber: #d97706       /* partial/warning */
--red: #dc2626         /* closed/danger */
--pro: #7c3aed         /* Pro purple */

/* Typography */
DM Mono — numbers, metrics, monospaced values
DM Sans — all UI text

/* Key layout vars */
--nav-h: 60px          /* top nav height */
--bottom-h: 64px       /* bottom nav height */
```

**Card anatomy:**
```
.card
  .cbar              colored top bar (blue=open, amber=partial, gray=closed)
  .card-head         resort name + state + pass badge + heart + status badge
  .sep
  .metrics           3-col: base / 24h snow / 7-day snow
  .basebar           depth bar + season total
  .sep
  .cfoot             lifts + trails + temp + condition pill
  .cam-row           webcam toggle
  .cam-drawer        webcam content (collapsible)
  .drive-row         drive time + chain badge (loads on location)
  .drive-verdict     AI worth-the-drive verdict
  .card-forecast     mini 7-day forecast strip (Pro)
```

---

## Pricing & Monetization

| Plan | Price | Features |
|------|-------|----------|
| Free | $0 | Conditions, watchlist, webcams, basic drive time |
| Pro Monthly | $4.99/mo | + Forecast, Trip Planner, Alerts, all drive features |
| Pro Annual | $29.99/yr | Same as Pro Monthly (saves 50%) |
| Family | $7.99/mo | 4 users (planned, not built) |

**Revenue streams (planned):**
1. Subscriptions (Stripe) — primary
2. Google AdSense on free pages
3. Affiliate hotel links (Booking.com 4-6% commission)
4. Family plan

---

## What Needs to Be Built for Production

### Critical (do first)
1. **Backend API proxy** — Move Anthropic API key to server. Currently exposed in browser.
   - Create `POST /api/claude` serverless function
   - Update all `fetch('https://api.anthropic.com/...')` calls to `fetch('/api/claude')`

2. **Real user auth** — Replace `localStorage` Pro flag with Supabase Auth
   - Email + Google OAuth
   - `users` table: `{id, email, is_pro, stripe_customer_id, created_at}`
   - Check `is_pro` on load → unlock features

3. **Stripe integration** — Replace `activatePro()` alert with real checkout
   - Products: Pro Monthly ($4.99) + Pro Annual ($29.99)
   - Webhook: `checkout.session.completed` → flip `is_pro=true` in Supabase
   - Webhook: `customer.subscription.deleted` → flip `is_pro=false`
   - Customer Portal for self-serve cancel/upgrade

4. **Data disclaimer** — Add to every card: "Base depth AI-estimated. Verify at resort website."

### High Priority
5. **Resort data scraping** — Replace Claude ops estimates with real scraped data
   - Each resort publishes a daily snow report page
   - Python scraper → store in Supabase → app reads from DB instead of calling Claude
   - This eliminates the biggest Claude API cost and makes data accurate

6. **Real drive times** — Replace Haversine with Google Maps Distance Matrix API
   - Free tier: 1,000 requests/month
   - Returns actual road distance + ETA accounting for traffic

7. **PWA manifest** — Make it installable to home screen
   ```json
   {"name":"Powder","short_name":"Powder","display":"standalone","start_url":"/","theme_color":"#2563eb"}
   ```

8. **Analytics** — PostHog or Mixpanel (free tier)
   - Track: page views, feature usage, conversion funnel, Pro upgrades

### Nice to Have
9. **Push notifications** (Powder Alerts) — OneSignal free tier
10. **Native iOS/Android app** — React Native, reuse most logic
11. **SEO pages** — Individual `/resorts/mammoth-mountain` pages for Google indexing
12. **Google AdSense** — Apply for approval, add to free-tier pages only

---

## Recommended Production Stack

```
Frontend:  Next.js (convert from HTML → React components)
Backend:   Next.js API routes (serverless, on Vercel)
Database:  Supabase (Postgres + Auth + Storage + Realtime)
Payments:  Stripe (subscriptions + webhooks + customer portal)
Hosting:   Vercel (free hobby → $20/mo Pro)
Domain:    Namecheap (~$12/yr)
Weather:   Open-Meteo (free, keep as-is)
Alerts:    OneSignal (free tier → push notifications)
Analytics: PostHog (free tier)
```

---

## Known Issues & Technical Debt

| Issue | Severity | Fix |
|-------|----------|-----|
| Anthropic API key exposed in browser | 🔴 Critical | Move to backend proxy |
| Pro status in localStorage (resets on clear) | 🔴 Critical | Supabase auth |
| Base/lifts/trails data is AI-estimated | 🟡 High | Scrape resort pages |
| Drive time uses straight-line distance | 🟡 Medium | Google Maps Distance Matrix |
| No error boundary UI (silent failures) | 🟡 Medium | Add error states |
| No loading skeleton (cards pop in) | 🟢 Low | Add skeleton placeholders |
| corsproxy.io dependency (Caltrans fetch) | 🟡 Medium | Move to backend proxy |
| Single HTML file (hard to maintain) | 🟡 Medium | Convert to Next.js |
| No tests | 🟡 Medium | Add Jest/Playwright |

---

## File Structure for Next.js Conversion

```
powder/
├── CLAUDE.md                    ← this file
├── package.json
├── next.config.js
├── .env.local                   ← API keys (never commit)
│   ├── ANTHROPIC_API_KEY
│   ├── NEXT_PUBLIC_SUPABASE_URL
│   ├── SUPABASE_SERVICE_KEY
│   ├── STRIPE_SECRET_KEY
│   ├── STRIPE_WEBHOOK_SECRET
│   └── GOOGLE_MAPS_API_KEY
├── app/
│   ├── layout.js                ← fonts, nav, bottom nav
│   ├── page.js                  ← conditions page
│   ├── watchlist/page.js
│   ├── forecast/page.js
│   ├── planner/page.js
│   ├── alerts/page.js
│   └── api/
│       ├── claude/route.js      ← proxy to Anthropic API
│       ├── weather/route.js     ← proxy/cache Open-Meteo
│       ├── caltrans/route.js    ← proxy Caltrans KML (avoids CORS)
│       ├── stripe/checkout/route.js
│       └── stripe/webhook/route.js
├── components/
│   ├── ResortCard.jsx           ← the main card
│   ├── DriveRow.jsx
│   ├── ForecastStrip.jsx
│   ├── TripWizard/
│   │   ├── index.jsx
│   │   ├── StepDates.jsx
│   │   ├── StepGroup.jsx
│   │   ├── StepBudget.jsx
│   │   ├── StepDistance.jsx
│   │   ├── StepRegionPass.jsx
│   │   ├── StepReview.jsx
│   │   └── Results.jsx
│   └── ui/
│       ├── Modal.jsx
│       └── BottomNav.jsx
├── lib/
│   ├── resorts.js               ← ALL_RESORTS, RESORT_COORDS, LIFT_PRICES, TERRAIN_MIX
│   ├── openmeteo.js             ← fetchOpenMeteo, wmoToCondition, wmoToIcon
│   ├── caltrans.js              ← parseCaltransKML, getResortChainStatus
│   ├── scoring.js               ← groupFitScore, forecastSnowForDates, calcPassSavings
│   └── cache.js                 ← cacheGet, cacheSet, cacheAge
└── public/
    ├── manifest.json            ← PWA manifest
    └── icon.png                 ← 192×192 app icon
```

---

## Quick Start for Claude Code

```bash
# The current working prototype
open powder-app.html    # works in any browser, no server needed

# To start the Next.js conversion:
npx create-next-app@latest powder --js --tailwind --app
cd powder

# Install dependencies
npm install @supabase/supabase-js stripe

# Set up environment
cp .env.example .env.local
# Add your keys to .env.local

# The most important first task:
# 1. Create app/api/claude/route.js to proxy Anthropic calls
# 2. Move all fetch('https://api.anthropic.com') calls to fetch('/api/claude')
# 3. This alone makes the app safe to deploy publicly
```

---

## Suggested First Claude Code Tasks

**Task 1 — Backend proxy (30 min):**
> "Create a Next.js API route at `/api/claude` that proxies requests to the Anthropic API using the `ANTHROPIC_API_KEY` environment variable. Accept POST requests with the same body shape as the Anthropic messages API and forward the response."

**Task 2 — Supabase auth (2 hrs):**
> "Set up Supabase Auth in a Next.js app. Create a `users` table with `id, email, is_pro boolean, stripe_customer_id, created_at`. Add email + Google OAuth login. On login, check `is_pro` and expose it via a React context."

**Task 3 — Stripe integration (3 hrs):**
> "Wire up Stripe subscriptions. Create `/api/stripe/checkout` that creates a Stripe Checkout session for either price_monthly or price_annual. Create `/api/stripe/webhook` that listens for `checkout.session.completed` and `customer.subscription.deleted` events and updates the `is_pro` field in Supabase accordingly."

**Task 4 — Convert ResortCard (4 hrs):**
> "Convert the `cardHtml()` function from powder-app.html into a React component at `components/ResortCard.jsx`. It should accept a resort object (shape documented in CLAUDE.md) and render the same card UI using Tailwind classes instead of inline CSS."
