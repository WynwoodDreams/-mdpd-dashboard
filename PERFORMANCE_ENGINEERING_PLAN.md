# MDPD Dashboard — Performance Engineering Plan

> Prepared for the MDPD Live Traffic Feed Dashboard
> Focus: Reduce API load, improve speed, keep data reliable — without changing core infrastructure

---

## Current Architecture Summary

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS single-page app (1 HTML file, ~1950 lines) |
| Map | Leaflet.js 1.9.4 + MarkerCluster 1.5.3 |
| Backend | Vercel serverless proxy (`/api/traffic`) |
| Data Source | `https://traffic.mdpd.com/api/traffic` (JSON array of incidents) |
| Secondary Sources | NWS Weather API, Google Street View (optional) |
| Caching | Vercel ISR (30s/60s stale), localStorage (12h history chart) |
| Refresh | 60-second polling interval via `setInterval` |
| Fallback | 3-tier: Vercel proxy → Direct MDPD API → Embedded fallback data |

**Data shape per incident:**
```json
{
  "CreateTime": "2026-03-11T23:47:33",
  "Signal": "TRAFFIC ACCIDENT WITH INJURIES",
  "Address": "NW 2ND AVE / NW 175TH ST",
  "Location": "OAK GROVE PK",
  "Grid": "0186",
  "Longitude": -80.20506181,
  "Latitude": 25.93521252
}
```

---

## 1. Likely Bottlenecks

| # | Bottleneck | Severity | Why It Matters |
|---|-----------|----------|----------------|
| 1 | **Every 60s: full dataset re-fetch + full DOM rebuild + full map clear/rebuild** | HIGH | Every poll wipes all markers and cards, even if nothing changed. This is the single biggest performance issue. |
| 2 | **No diff detection before re-render** | HIGH | `render()` clears `layerGroup` and `feedList.innerHTML` every time, even when data is identical to the last fetch. |
| 3 | **No client-side data cache between fetches** | MEDIUM | If the Vercel proxy returns the same data, the app still does full DOM + map work. |
| 4 | **NWS weather fetch on every `initFloodLayer()` call** | LOW-MEDIUM | Called on init; not re-called on poll. Acceptable, but should cache if you add a refresh button for it. |
| 5 | **`fitBounds()` on every render** | MEDIUM | Map viewport jumps every 60 seconds. Disorienting if a user is zoomed in on a specific area. |
| 6 | **No request deduplication** | MEDIUM | If a user clicks "Refresh" while auto-refresh fires, two concurrent fetches hit the API. |
| 7 | **`classify()` called per-item multiple times per render** | LOW | Called in stats count, in render loop, and in filter. Minor, but easy to fix with a single pass. |
| 8 | **All markers + cards rendered regardless of viewport** | MEDIUM | With MarkerCluster this is partially mitigated for the map, but the feed list renders everything. |

---

## 2. Quick Wins (Implement First)

### Quick Win #1: Diff-Based Rendering
**Impact: HIGH | Effort: LOW**

Stop clearing and rebuilding everything on each poll. Compare incoming data to the previous dataset.

```javascript
// Store previous data
let previousData = [];

async function loadData() {
  // ... fetch data ...

  // Only re-render if data actually changed
  const dataHash = JSON.stringify(data.map(d => d.CreateTime + '|' + d.Address + '|' + d.Signal));
  const prevHash = JSON.stringify(previousData.map(d => d.CreateTime + '|' + d.Address + '|' + d.Signal));

  if (dataHash === prevHash && !isFirstLoad) {
    // Data unchanged — just update timestamps, skip full re-render
    updateTimestamps();
    btn.classList.remove('busy');
    btn.textContent = 'Refresh';
    startCountdown();
    return;
  }

  previousData = data;
  render(data, isFirstLoad);
  // ... rest of function
}
```

### Quick Win #2: Request Deduplication Guard
**Impact: MEDIUM | Effort: VERY LOW**

```javascript
let fetchInProgress = false;

async function loadData() {
  if (fetchInProgress) return; // Prevent concurrent fetches
  fetchInProgress = true;
  try {
    // ... existing fetch logic ...
  } finally {
    fetchInProgress = false;
  }
}
```

### Quick Win #3: Preserve Map Viewport
**Impact: MEDIUM | Effort: VERY LOW**

Only call `fitBounds()` on first load. On subsequent polls, preserve the user's zoom/pan.

```javascript
// Replace the fitBounds block at the end of render():
if (firstLoad && pts.length > 1) {
  map.fitBounds(pts, { padding: [40, 40], maxZoom: 13 });
}
// On subsequent renders, markers update in place without moving the viewport
```

### Quick Win #4: Single-Pass Classification
**Impact: LOW | Effort: VERY LOW**

Classify once, attach to each item, reuse everywhere:

```javascript
function render(data, firstLoad) {
  // Classify once
  data.forEach(d => { d._type = classify(d.Signal); });

  // Use d._type everywhere instead of calling classify() repeatedly
  const injCount = data.filter(d => d._type === 'injury').length;
  // ...
}
```

---

## 3. Caching Strategy

### What to Cache and For How Long

| Data | Cache Location | Duration | Reason |
|------|---------------|----------|--------|
| **Live traffic incidents** | Vercel ISR (current) | 30s server / 60s stale | This is already correct. Source updates in near-real-time. |
| **Live traffic incidents** | In-memory (client) | 60s (between polls) | Prevents redundant DOM rebuilds when data hasn't changed. |
| **NWS weather alerts** | In-memory (client) | 10–15 minutes | Weather alerts don't change second-by-second. |
| **Landmark/highway data** | Hardcoded (current) | Infinite | Static data. Already correct. |
| **Flood hotspots** | Hardcoded (current) | Infinite | Static data. Already correct. |
| **24h history chart** | localStorage (current) | 12 hours | Already correct. |
| **Incident counts by hour** | localStorage | 24 hours | For the history chart; already implemented. |

### Future: If You Add Arrests, Bookings, Charges, Demographics

| Data Type | Recommended Cache | Duration |
|-----------|------------------|----------|
| Historical arrests/bookings | CDN / static JSON | 24 hours (rebuild nightly) |
| Charge category rollups | Pre-computed JSON | 24 hours |
| Demographic breakdowns | Pre-computed JSON | 24 hours |
| District/grid summaries | Pre-computed JSON | 6–24 hours |
| Trend data (30/60/90 day) | Pre-computed JSON | 24 hours |
| "Today" counts | Vercel ISR | 5 minutes |
| Live feed (current feature) | Vercel ISR | 30 seconds (current) |

### Cache Key Strategy for Query Combinations

When you expand to support filters, use deterministic cache keys:

```
/api/summary?range=30d&district=all&type=all  →  cache key: "summary:30d:all:all"
/api/summary?range=7d&district=north&type=dui  →  cache key: "summary:7d:north:dui"
```

Pre-warm the most common combinations:
- All districts + all types + 7d/30d/90d
- Top 5 districts + all types + 30d
- All districts + top 5 charge types + 30d

---

## 4. Request-Flow Strategy

### Before (Current Flow)

```
Every 60 seconds:
  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
  │  Browser     │────▶│ Vercel Proxy │────▶│ MDPD API     │
  │  (fetch)     │◀────│ /api/traffic │◀────│ traffic.mdpd │
  └─────────────┘     └──────────────┘     └──────────────┘
         │
         ▼
  ┌─────────────────────────────────────┐
  │ Clear ALL markers                   │
  │ Clear ALL feed cards                │
  │ Rebuild ALL markers from scratch    │
  │ Rebuild ALL feed cards from scratch │
  │ fitBounds() — viewport jumps        │
  └─────────────────────────────────────┘
```

**Problems:**
- Full teardown + rebuild every 60s even if nothing changed
- Two concurrent fetches possible (manual + auto)
- No data comparison before rendering

### After (Optimized Flow)

```
Every 60 seconds:
  ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
  │  Browser     │────▶│ Vercel Proxy │────▶│ MDPD API     │
  │  (fetch)     │◀────│ /api/traffic │◀────│ traffic.mdpd │
  └─────────────┘     └──────────────┘     └──────────────┘
         │
         ▼
  ┌──────────────────────┐
  │ Compare with previous│
  │ data (hash/diff)     │
  └──────┬───────────────┘
         │
    ┌────┴────┐
    │ Changed?│
    └────┬────┘
     NO  │  YES
     │   │
     │   ▼
     │  ┌─────────────────────────────┐
     │  │ Compute diff:               │
     │  │  - added incidents          │
     │  │  - removed incidents        │
     │  │  - unchanged incidents      │
     │  └─────────────────────────────┘
     │   │
     │   ▼
     │  ┌─────────────────────────────┐
     │  │ Patch DOM + map:            │
     │  │  - Add new markers/cards    │
     │  │  - Remove stale ones        │
     │  │  - Keep existing untouched  │
     │  │  - Preserve viewport        │
     │  └─────────────────────────────┘
     │
     ▼
  ┌──────────────────────┐
  │ Update timestamps    │
  │ Update countdown     │
  │ (skip re-render)     │
  └──────────────────────┘
```

---

## 5. Frontend Improvements

### 5a. Debounce & Throttle

Your current app doesn't have search or complex filters that hit APIs — filters are pure CSS show/hide, which is already fast. However, for future expansion:

| Interaction | Technique | Delay |
|------------|-----------|-------|
| Search input (future) | Debounce | 300ms |
| Date range filter (future) | Debounce | 500ms |
| Map pan/zoom (for viewport-based loading) | Throttle | 200ms |
| Rapid filter tab clicks | Already instant (CSS) | N/A — no API call |

### 5b. Staged Loading

Currently everything loads at once. Prioritize:

```
Phase 1 (0ms):    Header stats, filter tabs, countdown badge  ← instant
Phase 2 (0-100ms): Feed cards (above the fold first)          ← visible immediately
Phase 3 (100ms+):  Map markers added to cluster layer          ← Leaflet batches internally
Phase 4 (deferred): NWS weather alerts, flood layer            ← non-critical overlay
Phase 5 (on-demand): Street View thumbnails in popups          ← only when popup opens
```

Implementation for deferred overlay loading:

```javascript
// Instead of calling initOverlays() at page load alongside loadData():
loadData();
// Delay overlay init so the critical path (incidents) loads first
setTimeout(initOverlays, 500);
```

### 5c. Prevent Redundant Work on Tab Switches (Mobile)

The `switchTab()` function (mobile view) should not re-trigger any data fetches. Currently it doesn't — good. But if you add any `onVisible` logic later, gate it:

```javascript
function switchTab(tab) {
  // Only invalidate map size, don't re-fetch
  if (tab === 'map') {
    map.invalidateSize();
  }
  // No data re-fetch needed
}
```

### 5d. Visibility API — Pause Polling When Tab Is Hidden

Stop hitting the API when the user isn't even looking at the page:

```javascript
let pollInterval = null;

function startPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(loadData, 60000);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopPolling();
  } else {
    loadData(); // Immediate refresh when user returns
    startPolling();
  }
});

// Replace the current: setInterval(loadData, 60000);
startPolling();
```

**This is a HIGH-impact, LOW-effort change.** A user with 10 tabs open means 10 polls every 60 seconds. With this, only the active tab polls.

---

## 6. Backend/API Improvements

### 6a. Conditional Responses (ETag / Last-Modified)

Add ETag support to your Vercel proxy so the client can skip parsing unchanged responses:

```javascript
// api/traffic.js (enhanced)
import { createHash } from 'crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  try {
    const response = await fetch('https://traffic.mdpd.com/api/traffic');
    if (!response.ok) throw new Error(`MDPD API returned ${response.status}`);
    const data = await response.json();

    // Generate ETag from response content
    const body = JSON.stringify(data);
    const etag = '"' + createHash('md5').update(body).digest('hex') + '"';

    // Check If-None-Match
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Failed to reach MDPD API', detail: err.message });
  }
}
```

Client-side:

```javascript
let lastETag = null;

async function fetchWithETag(url) {
  const headers = {};
  if (lastETag) headers['If-None-Match'] = lastETag;

  const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });

  if (r.status === 304) return null; // Data unchanged
  if (!r.ok) throw new Error(r.status);

  lastETag = r.headers.get('ETag');
  return r.json();
}
```

### 6b. Future Endpoint Structure

When you expand beyond live traffic to arrests, bookings, charges, etc., structure endpoints like this:

```
/api/traffic                          ← current (live incidents, 30s cache)

/api/summary?range=7d                 ← pre-aggregated KPI data (5min cache)
/api/trends?range=30d&bucket=day      ← time-series for charts (1hr cache)
/api/charges?range=30d&top=20         ← charge category rollups (1hr cache)
/api/districts?range=30d              ← per-district summaries (1hr cache)
/api/demographics?range=30d           ← age/demographic breakdowns (1hr cache)

/api/incidents?page=1&limit=50        ← paginated raw records (on drill-down only)
/api/map/clusters?zoom=12&bounds=...  ← viewport-aware map data (no cache, fast)
```

### 6c. Response Shaping — Return Only What's Needed

For future aggregate endpoints, don't return full records:

```javascript
// BAD: Return 10,000 full records for a chart that only needs daily counts
{ records: [{ CreateTime, Signal, Address, Location, Grid, Lat, Lng, ... }, ...] }

// GOOD: Return pre-aggregated data
{ dailyCounts: [{ date: "2026-03-15", total: 47, injury: 8, hitrun: 3 }, ...] }
```

---

## 7. Map Performance Improvements

### 7a. Current State (Already Good)

Your current setup uses MarkerCluster with `maxClusterRadius: 50`, which handles grouping well. For ~20-80 live traffic incidents, this is fine. No immediate map performance problem.

### 7b. When You Scale to Historical Data (Thousands of Points)

| Technique | When to Use | How |
|-----------|-------------|-----|
| **Viewport-based loading** | 1,000+ markers | Only fetch/render markers within `map.getBounds()`. Re-fetch on `moveend` (throttled 200ms). |
| **Server-side clustering** | 5,000+ markers | Pre-cluster on the backend. Return cluster centroids with counts at low zoom, individual points at high zoom. |
| **Tile-based heatmaps** | 10,000+ points | Generate heatmap tiles server-side. Use Leaflet.heat or vector tiles. |
| **Grid aggregation** | Any density | Divide Miami-Dade into a grid (e.g., Grid codes you already have). Return counts per grid cell. |

### 7c. Viewport-Based Loading (Implementation Sketch)

```javascript
// Throttled map movement handler
let moveTimeout;
map.on('moveend', () => {
  clearTimeout(moveTimeout);
  moveTimeout = setTimeout(() => {
    const bounds = map.getBounds();
    const zoom = map.getZoom();
    fetchMapData(bounds, zoom);
  }, 200);
});

async function fetchMapData(bounds, zoom) {
  const params = new URLSearchParams({
    north: bounds.getNorth(),
    south: bounds.getSouth(),
    east: bounds.getEast(),
    west: bounds.getWest(),
    zoom: zoom
  });

  const data = await fetch(`/api/map/clusters?${params}`);
  // Update only changed markers
}
```

### 7d. Prevent Map Thrash on Polling

Current code clears all markers and re-adds them every 60s. This causes a visible flicker. Fix:

```javascript
function updateMarkers(newData) {
  const newKeys = new Map(newData.map(d => [incidentKey(d), d]));
  const oldKeys = new Map(previousData.map(d => [incidentKey(d), d]));

  // Remove markers for incidents no longer in the data
  oldKeys.forEach((item, key) => {
    if (!newKeys.has(key) && markerMap.has(key)) {
      layerGroup.removeLayer(markerMap.get(key));
      markerMap.delete(key);
    }
  });

  // Add markers for new incidents only
  newKeys.forEach((item, key) => {
    if (!oldKeys.has(key)) {
      const marker = createMarker(item);
      layerGroup.addLayer(marker);
      markerMap.set(key, marker);
    }
  });
}
```

---

## 8. Data Refresh Schedule

| Data Type | Refresh Frequency | Strategy |
|-----------|------------------|----------|
| **Live traffic incidents** | 60 seconds (current) | Polling with diff check. Pause when tab hidden. |
| **NWS weather alerts** | 10–15 minutes | Cache in memory. Re-fetch on manual refresh or timer. |
| **Landmarks, highways, flood hotspots** | Never (static) | Hardcoded. Already correct. |
| **24h history chart** | On each data poll | localStorage accumulation. Already correct. |
| **Street View thumbnails** | On-demand only | Loaded when popup opens. Already correct. |

### Future Data (Arrests, Bookings, Charges)

| Data Type | Freshness Need | Refresh Strategy |
|-----------|---------------|-----------------|
| Today's incidents/arrests | Near-real-time | 5-minute ISR cache |
| This week's totals | Hourly is fine | 1-hour ISR cache |
| 30/60/90-day trends | Daily is fine | Pre-compute nightly, serve from static JSON or CDN |
| Historical charge breakdowns | Daily is fine | Pre-compute nightly |
| Demographic rollups | Daily is fine | Pre-compute nightly |
| District comparisons | Daily is fine | Pre-compute nightly |
| Year-over-year trends | Weekly is fine | Pre-compute weekly |

**Key insight for police/public-safety data:** Most historical data is immutable. An arrest from last month won't change. Only "today" and "this week" need frequent refreshes. Everything else can be pre-computed and served as static files.

---

## 9. Rate Limiting & Resilience

### 9a. Client-Side Rate Limiting

```javascript
// Minimum interval between manual refreshes: 10 seconds
let lastManualRefresh = 0;
const MIN_REFRESH_INTERVAL = 10000;

function manualRefresh() {
  const now = Date.now();
  if (now - lastManualRefresh < MIN_REFRESH_INTERVAL) {
    // Show "please wait" instead of hammering the API
    return;
  }
  lastManualRefresh = now;
  loadData();
}
```

### 9b. Exponential Backoff on Failure

```javascript
let consecutiveFailures = 0;

async function loadData() {
  try {
    // ... fetch logic ...
    consecutiveFailures = 0; // Reset on success
  } catch {
    consecutiveFailures++;
    // Back off: 60s, 120s, 240s, max 300s
    const backoff = Math.min(60000 * Math.pow(2, consecutiveFailures - 1), 300000);
    nextRefreshAt = Date.now() + backoff;
    startCountdown();
  }
}
```

### 9c. Vercel Proxy Rate Limiting (Future)

If you add more endpoints for expanded data:

```javascript
// Simple in-memory rate limiter for serverless (per-instance)
const rateMap = new Map();

function rateLimit(ip, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const record = rateMap.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count++;
  rateMap.set(ip, record);

  return record.count > limit; // true = blocked
}
```

---

## 10. Priority Order

### HIGH Priority (Do This Week)

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 1 | **Visibility API — pause polling when tab hidden** | Eliminates waste from background tabs | 15 min |
| 2 | **Diff-based rendering — skip re-render when data unchanged** | Eliminates ~90% of unnecessary DOM/map rebuilds | 30 min |
| 3 | **Request deduplication guard** | Prevents double-fetches | 5 min |
| 4 | **Preserve map viewport on re-render** (`fitBounds` only on first load) | Stops disorienting viewport jumps | 5 min |
| 5 | **Incremental marker updates** (add/remove diff, not clear-all) | Eliminates map flicker on every poll | 45 min |

### MEDIUM Priority (Do This Month)

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 6 | Defer overlay initialization (landmarks, highways, flood) by 500ms | Faster initial paint | 5 min |
| 7 | Cache NWS weather response in memory for 10 min | Reduces external API calls if flood layer is toggled | 15 min |
| 8 | Add ETag support to Vercel proxy | Saves bandwidth on unchanged responses | 30 min |
| 9 | Manual refresh cooldown (10s minimum) | Prevents user-driven API hammering | 10 min |
| 10 | Exponential backoff on fetch failures | Graceful degradation when MDPD API is down | 15 min |

### LOW Priority (Do When Expanding)

| # | Change | Impact | Effort |
|---|--------|--------|--------|
| 11 | Viewport-based map loading for historical data | Required only when marker count exceeds ~500 | 2-4 hours |
| 12 | Pre-aggregated API endpoints for dashboards | Required when adding arrests/charges/demographics views | 1-2 days |
| 13 | Server-side clustering for dense map data | Required when plotting thousands of historical points | 1 day |
| 14 | Nightly pre-computation pipeline for trend data | Required for 30/60/90-day dashboards | 1 day |
| 15 | Client-side service worker for offline fallback | Nice-to-have for resilience | 2-4 hours |

---

## 11. What NOT to Overbuild Yet

| Don't Build | Why |
|-------------|-----|
| **Redux / Zustand / state management library** | You have one data source and one page. A `previousData` variable is enough. |
| **GraphQL** | Your data model is one flat array. REST is simpler. |
| **WebSocket / SSE real-time push** | 60-second polling with ISR cache is appropriate for traffic incident data. Push adds complexity for marginal gain. |
| **Service Worker / PWA** | Not needed until you have offline requirements. |
| **Database (Postgres, Supabase, etc.)** | Not needed until you store historical data or user accounts. |
| **React / Vue / Svelte migration** | The vanilla JS approach is fast and works. Don't rewrite for rewrite's sake. |
| **Complex CDN / edge caching rules** | Vercel ISR already handles this. Don't add Cloudflare or another CDN layer yet. |
| **User authentication / sessions** | Only needed when you add personalized dashboards or saved filters. |

---

## 12. Shared Query Pattern for Dashboard Widgets

When you expand to multi-widget dashboards, use a single fetch to feed multiple components:

```javascript
// ── Shared data layer ──────────────────────────
const DataStore = {
  _cache: {},
  _pending: {},

  async fetch(endpoint, ttlMs = 60000) {
    const now = Date.now();

    // Return cached if still fresh
    if (this._cache[endpoint] && now - this._cache[endpoint].ts < ttlMs) {
      return this._cache[endpoint].data;
    }

    // Deduplicate in-flight requests
    if (this._pending[endpoint]) {
      return this._pending[endpoint];
    }

    const promise = fetch(endpoint)
      .then(r => r.json())
      .then(data => {
        this._cache[endpoint] = { data, ts: Date.now() };
        delete this._pending[endpoint];
        return data;
      })
      .catch(err => {
        delete this._pending[endpoint];
        // Return stale cache if available
        if (this._cache[endpoint]) return this._cache[endpoint].data;
        throw err;
      });

    this._pending[endpoint] = promise;
    return promise;
  }
};

// ── Multiple widgets share one fetch ────────────
async function renderDashboard() {
  // One fetch, used by 4 widgets
  const incidents = await DataStore.fetch('/api/traffic', 60000);

  renderStatsCards(incidents);   // KPI summary cards
  renderFeedList(incidents);     // Scrollable feed
  renderMapMarkers(incidents);   // Leaflet markers
  renderTypeChart(incidents);    // Type breakdown chart
}
```

---

## 13. Rollout Plan

### Phase 1 — Quick Wins (Week 1)
**Goal: Eliminate wasted work**

- [ ] Add `fetchInProgress` guard to prevent concurrent fetches
- [ ] Add Visibility API to pause/resume polling
- [ ] Store `previousData` and skip render when data unchanged
- [ ] Move `fitBounds()` to first load only
- [ ] Single-pass `classify()` (attach `_type` to each item)
- [ ] Defer `initOverlays()` by 500ms

**Expected result:** ~60-80% reduction in unnecessary DOM/map rebuilds. Zero API calls from background tabs.

### Phase 2 — Incremental Updates (Week 2)
**Goal: Smooth experience on data changes**

- [ ] Replace clear-all/rebuild-all marker strategy with add/remove diff
- [ ] Replace `feedList.innerHTML = ''` with incremental card add/remove
- [ ] Add manual refresh cooldown (10s)
- [ ] Add exponential backoff on fetch failures
- [ ] Cache NWS weather response for 10 minutes

**Expected result:** No more map flicker. Graceful failure handling. Smoother UX.

### Phase 3 — Backend Optimization (Week 3-4)
**Goal: Reduce bandwidth and server load**

- [ ] Add ETag support to Vercel proxy
- [ ] Client-side ETag/304 handling
- [ ] Rename `api` file to proper `api/traffic.js` for clean routing
- [ ] Add response timing headers for monitoring

**Expected result:** ~50% bandwidth reduction on unchanged polls. Better observability.

### Phase 4 — Expansion Foundation (When Ready)
**Goal: Prepare for arrests, bookings, charges, demographics**

- [ ] Create `DataStore` shared fetch layer with TTL cache + dedup
- [ ] Design aggregate API endpoints (`/api/summary`, `/api/trends`, etc.)
- [ ] Build nightly pre-computation for historical rollups
- [ ] Add viewport-based map loading for dense historical data
- [ ] Implement server-side clustering for map views with 500+ points

---

## 14. Example: Before vs After Request Timeline

### Before — User opens dashboard, browses for 5 minutes

```
0:00  GET /api/traffic  → 200 (full JSON)  → clear ALL + rebuild ALL
0:05  (user clicks Refresh while auto-refresh fires)
      GET /api/traffic  → 200 (same data)  → clear ALL + rebuild ALL
      GET /api/traffic  → 200 (same data)  → clear ALL + rebuild ALL  ← WASTED
1:00  GET /api/traffic  → 200 (same data)  → clear ALL + rebuild ALL
1:05  (user switches to another browser tab)
2:00  GET /api/traffic  → 200 (nobody watching)  → clear ALL + rebuild ALL  ← WASTED
3:00  GET /api/traffic  → 200 (nobody watching)  → clear ALL + rebuild ALL  ← WASTED
4:00  GET /api/traffic  → 200 (nobody watching)  → clear ALL + rebuild ALL  ← WASTED
5:00  GET /api/traffic  → 200 (nobody watching)  → clear ALL + rebuild ALL  ← WASTED

Total: 6 fetches, 6 full rebuilds. 4 completely wasted.
```

### After — Same scenario, optimized

```
0:00  GET /api/traffic  → 200 (full JSON)  → full render (first load) ✓
0:05  (user clicks Refresh — deduplication blocks concurrent auto-refresh)
      GET /api/traffic  → 200 (same data)  → diff check → SKIP render ✓
1:00  GET /api/traffic  → 200 (same data)  → diff check → SKIP render ✓
1:05  (user switches to another browser tab → polling PAUSED)
2:00  (no fetch — tab hidden)
3:00  (no fetch — tab hidden)
4:00  (no fetch — tab hidden)
4:30  (user returns to tab → immediate fetch)
      GET /api/traffic  → 200 (1 new incident)  → incremental add: 1 marker + 1 card ✓

Total: 3 fetches, 1 full render, 1 incremental update. 0 wasted.
```

**Result: 50% fewer API calls. 83% fewer full rebuilds.**

---

## Summary

Your MDPD dashboard is well-built for what it does. The architecture is clean, the fallback strategy is solid, and the UX is polished. The biggest gains come from:

1. **Not doing work when nothing changed** (diff-based rendering)
2. **Not polling when nobody's watching** (Visibility API)
3. **Not clearing and rebuilding when you can patch** (incremental updates)
4. **Not re-fitting the map on every poll** (preserve viewport)

These four changes alone will cut your API load roughly in half and eliminate virtually all unnecessary DOM/map work — without touching your infrastructure, your data source, or your visual design.
