# MDPD Live Traffic Feed — Design Refinement Guidelines (V2)

**Role of this document.** A senior product-design pass on an already-successful product.
The goal is V2 of *this* product — tighter, calmer, more trustworthy — not a different
application. Nothing here changes the visual identity, the palette, the typography, or
the two-panel layout.

---

## 1. What This Product Is (and Why the Identity Must Not Change)

This dashboard is a **live operations console**: a dark, high-density, monospace
"mission control" surface for Miami-Dade traffic incidents. Its identity is defined by:

- **The dark tactical palette** — near-black surfaces (`--bg-primary: #0a0a0c`) with a
  small set of semantic neon accents: red = accident, orange = injury, yellow = hit & run,
  blue = other, cyan = system/live-status.
- **JetBrains Mono for data, Inter Tight for headlines** — the mono/display split is the
  product's voice: telemetry vs. identity.
- **Motion that means something** — the pulsing live dot, the ring-out marker animation,
  the staggered card slide-in. Every animation currently signals "this is live."
- **The scanline overlay and gradient top bar** — pure character. Cheap, distinctive, keep.

A note on generic "minimal design" checklists (white space, large rounded cards, one
accent color): they do not apply literally here. This product's users come for *density
and immediacy* — a dispatcher-console aesthetic where five semantic colors are a feature,
not bloat. The correct reading of "minimal" for this product is: **no decoration that
doesn't carry information, and no interaction that doesn't reduce time-to-answer.**
Every recommendation below is filtered through that lens, plus four questions:
Would Apple ship it? Would Linear keep it? Does it reduce friction? Does it improve the
workflow? Anything that failed is not in this document.

**The one user question this product answers:** *"What's happening on the roads right
now — and is it near me?"* V2 should make that answer faster, not add more answers.

---

## 2. Features to Keep Exactly As They Are

These work. Do not touch them.

| Feature | Why it stays |
|---|---|
| **Two-panel layout** (map left, feed right, 440px rail) | The canonical ops-console layout. Map = spatial answer, feed = temporal answer. Both visible at once on desktop is the whole value proposition. |
| **Semantic color system** (red/orange/yellow/blue per incident type) | Used consistently across card edge, badge, marker, chip, filter tab, and legend. This is textbook design-system discipline — one meaning per color, everywhere. |
| **Filter tabs with live counts** (`All 24 · Accident 12 …`) | Counts-in-tabs is the Linear pattern: the control is also the summary. Zero-friction triage. |
| **Card → map fly-to** (click a card, map flies to the marker and opens its popup, switching tabs on mobile) | The single best interaction in the product. One obvious action per card. |
| **Stale dimming** (>3h incidents at 0.35 opacity, desaturated) | Communicates recency without removing data. Exactly right. |
| **Graceful degradation chain** (proxy → direct API → embedded fallback; Leaflet failure hides the map rather than breaking the feed) | Invisible when it works, saves the product when it doesn't. This is the engineering equivalent of good manners. |
| **LIVE / CACHED source badge** | Honest about data provenance. Rare and valuable. (One refinement below.) |
| **60s auto-refresh with visible countdown** in footer and refresh button | Sets expectations; the user never wonders if the page is alive. |
| **Mobile tab switcher** (Map / Incident Feed) | Correct mobile decomposition of the two-panel layout. Don't attempt a split view on phones. |
| **Collapsible map layers + 24H activity chart** | Progressive disclosure done right — advanced context available, never in the way. |
| **`esc()` on all API-sourced strings** | Not visible design, but it *is* design: the product can't be defaced by its data source. |

---

## 3. Small Improvements

Low-cost refinements. Each reuses existing components and patterns; none adds UI surface.

### 3.1 Filters should apply to the map, not just the feed ⭐ (consistency bug)
`setFilter()` hides feed cards but leaves all markers on the map. Selecting "Hit & Run"
currently produces a feed and a map that disagree — the worst kind of inconsistency in a
two-panel product, and invisible on mobile until the user switches tabs.
**Fix:** in `setFilter()`, rebuild `layerGroup` from `markerRefs` whose incident type
matches (markers already know their type via the icon class). No new UI. The filter tabs
become the single filtering brain for the whole screen.

### 3.2 Stop yanking the map on auto-refresh (respect user intent)
`render()` calls `map.fitBounds()` on every load — including the silent 60-second
auto-refresh. A user who has zoomed into their neighborhood gets teleported back to the
county view once a minute.
**Fix:** fit bounds on first load only; afterwards, re-fit only when the user presses
Refresh explicitly. (One boolean. Apple would call this "respecting the user's camera.")

### 3.3 Preserve selection and scroll across refreshes
The full `innerHTML = ''` re-render every 60s drops the `.selected` card state, and the
slide-in animation replays for unchanged cards, making the feed feel like it's churning.
**Fix:** re-apply `.selected` by `incidentKey()` after render, and only apply the
`slideIn` animation/`animationDelay` to keys in `newKeys`. Existing cards should be
still; *new* cards should move. Motion regains its meaning.

### 3.4 Keep relative timestamps honest between refreshes
"2m ago" is computed at render time and can drift up to 60s stale — on a product whose
brand is "live," a wrong clock is a broken promise.
**Fix:** re-run the `ago()` text on the existing once-per-second `tick()` (or a 30s
interval) by updating the `.card-meta` age spans in place. No layout change.

### 3.5 CACHED badge should say how old the cache is
The embedded fallback data can be months old, yet the UI shows only "CACHED." A user
glancing at the dashboard during a storm could mistake archival incidents for current ones.
**Fix:** when the source is `cached`, render the age of the newest record into the
existing badge — `CACHED · 4mo old` — using the `ago()` helper and yellow badge styling
already in place. Honesty is the product's differentiator; extend it.

### 3.6 Empty state for filtered feed
Filtering to a type with zero incidents leaves a blank scroll area.
**Fix:** reuse `.loader-wrap`/`.loader-text` ("NO HIT & RUN INCIDENTS ACTIVE") — the
quiet-state component already exists; it just isn't wired to this case.

### 3.7 Marker → card echo (close the loop)
Card → map is wired; map → feed is not. Clicking a marker should also highlight and
scroll to its feed card (desktop only — on mobile the feed is hidden, do nothing).
**Fix:** on marker click, apply the existing `.selected` treatment and
`scrollIntoView({block:'nearest'})`. Reuses the exact visual state users already know.

### 3.8 `prefers-reduced-motion`
The scanline overlay, pulse rings, and flashing NEW badge are identity — but vestibular
users need an out, and this is table stakes for a public-facing government-data product.
**Fix:** one media query disabling `ring-out`, `pulse-dot`, `new-flash`, `flood-pulse`,
and the card slide-in. The static design already reads perfectly without motion.

### 3.9 Persist user preferences
Layer toggles, the active filter, and the history-chart open/closed state reset on every
visit. The product already uses `localStorage` (history chart) — extend the same pattern
to these three settings. Returning users find the console exactly as they left it, which
is what makes a tool feel *theirs*.

### 3.10 Keyboard and semantics pass
Filter tabs and layer toggles are mouse-only in practice. Add `aria-pressed` to filter
tabs, `role="status"` on the LIVE/CACHED badge and footer, and make cards focusable
(`tabindex="0"`, Enter = the existing click action). No visual change whatsoever.

---

## 4. High-Impact New Features

Held to the strictest bar. Three made the cut; each answers the product's core question
better rather than adding a new question.

### 4.1 "Near Me" — geolocation + distance on cards ⭐
**Why:** the #1 unspoken user question is *"is this near me?"* Today users must visually
triangulate the map. Distance turns the feed from a list of streets into a personal
ranking.
**Where:** a single locate button appended to the existing Leaflet zoom control stack
(top-right) — the standard, discoverable place. Once located: a small cyan "you" marker
(reuse `.lm-marker` styling), and each feed card's existing `.card-meta` row gains one
span: `2.3 MI`. No new panel, no new screen.
**Discovery:** the locate icon is a universal map convention; zero teaching needed.
**Interplay:** distance sorts nothing and filters nothing by default — it annotates.
Cards, filters, and refresh behave exactly as before. Location is requested only on tap
(never on load), and never stored.
**Would Linear keep it?** Yes — it's one glyph of UI for a permanent reduction in
map-squinting.

### 4.2 New-incident awareness while you're not looking
**Why:** the product refreshes silently every 60s, but if the tab is backgrounded — or
the user is on the mobile Map tab — new incidents arrive unannounced. For the audience
this product implies (reporters, dispatch-adjacent staff, commuters during storms),
*knowing something new happened* is the job.
**Where:** two tiny surfaces, both reusing the existing NEW badge language:
1. Document title becomes `(3) MDPD // LIVE TRAFFIC FEED` while the tab is hidden;
   clears on focus.
2. On mobile, the inactive "Incident Feed" tab button shows the same cyan count dot the
   NEW badge already uses.
**Discovery:** ambient — it appears exactly when it's relevant and never otherwise.
**Interplay:** driven by the `newKeys` set `render()` already computes; no new data path.
**Would Apple ship it?** This is precisely how Messages badges the dock. Yes.

### 4.3 Shareable incident links
**Why:** a live dashboard's incidents get shared — group chats, newsroom Slack, HOA
threads. Today the only shareable artifact is a Google Maps pin, which strips the
incident context (type, time, signal). Sharing is how this product grows.
**Where:** selecting a card sets `#i=<incidentKey>` in the URL (replaceState — no history
spam). On load, if the hash matches an active incident, auto-select it: the existing
card-click behavior (highlight + fly-to + popup) *is* the landing experience. A small
"copy link" affordance can live inside the map popup next to the existing "↗ Open in
Google Maps" link — same `.maps-link` styling.
**Interplay:** if the incident has expired by open time, fall back silently to the normal
view — never an error screen for a link that aged out.
**Cost:** ~30 lines, zero new components, zero new visual language.

**Explicitly considered and rejected** (bloat by this product's standards): search box
(the feed is ~20–40 items; filter tabs + map already cover it), severity sorting
(chronological is the correct order for a live feed), push notifications (scope creep
into an alerting product), light theme (the dark console *is* the brand), incident
comments/social anything (this is a data instrument, not a community).

---

## 5. Nice-to-Have Future Ideas

Worth keeping on the radar; none should ship before Section 3 and 4 are done.

1. **Installable PWA** — a manifest + minimal service worker. The product already has a
   fallback-data story; offline-last-known-state is a natural extension, and "on the home
   screen" is where a live dashboard wants to live. (The cached-age badge from 3.5
   becomes essential here.)
2. **Server-backed 24h history** — the activity chart is per-device (`localStorage`), so
   first-time visitors see an empty chart. A tiny time-series endpoint beside the
   existing `/api/traffic` proxy would give every visitor the full 24h picture. Same
   chart, better data; no UI change.
3. **Hotspot heat layer** — a fourth checkbox in the existing Map Layers panel rendering
   a subtle density heat from the last N hours of incident positions. Answers "where is
   today bad?" spatially, the way the chart answers it temporally.
4. **Street View thumbnails, shipped** — the popup Street View support is fully built and
   gated only on an API key. Turning it on is the cheapest "wow" available; popups grow
   a photo of the actual intersection.
5. **Event-aware context** — Hard Rock Stadium and Kaseya Center are already landmarks;
   a small badge on game/event days ("EVENT TONIGHT") would explain incident clusters.
   Only worth it if a reliable free events source exists — otherwise skip forever.

---

## 6. Guardrails for Anyone Touching This Product

1. **No new colors.** If a new element can't be expressed with the existing accent
   variables, question the element.
2. **No new fonts, weights are fine.** JetBrains Mono + Inter Tight, period.
3. **Motion must mean "live data changed."** No decorative animation beyond the existing
   identity pieces (scanline, pulse dot).
4. **Uppercase + letterspacing is for labels, never body content.** Addresses and
   incident details stay sentence-form.
5. **Every interactive element must exist in the mobile tabbed view** or degrade
   deliberately (like marker→card echo, which no-ops on mobile).
6. **The feed is chronological. Always.** Filters subset it; nothing re-orders it.
7. **Honesty over polish** — data age, source, and staleness are always visible. This is
   the product's trust contract.
