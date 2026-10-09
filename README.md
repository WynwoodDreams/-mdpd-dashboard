# MDPD Live Traffic Feed

A single-page live operations console for Miami-Dade Police Department traffic
incidents: a dark, high-density map + feed showing active accidents, injuries,
hit & runs and other incidents from `traffic.mdpd.com`.

## Layout

| Path | Purpose |
|------|---------|
| `index.html` | The entire app: styles, SVG icon sprite, markup and JavaScript. No build step. |
| `api/traffic.js` | Vercel serverless function served at `/api/traffic`. Proxies the MDPD feed with edge caching (30 s fresh, 60 s stale-while-revalidate). |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable PWA. The service worker caches only the app shell, fonts and map libraries; the feed itself is never cached by it. |
| `vercel.json` | Security headers and cache rules for the service worker, manifest and icons. |
| `DESIGN_REFINEMENT.md` | V2 design guidelines and guardrails. All Section 3 and 4 items are implemented. |
| `PERFORMANCE_ENGINEERING_PLAN.md` | Performance plan with an implementation-status table. |

## Data flow

1. `GET /api/traffic` (Vercel proxy, edge cached)
2. `GET https://traffic.mdpd.com/api/traffic` directly (works only if CORS allows it)
3. Last-known-good payload from this session or `localStorage`
4. Embedded `FALLBACK_DATA` in `index.html`

Whenever the data is not live, the header badge shows `CACHED · <age> OLD` and the
footer turns yellow with a `Retrying in …` countdown.

Polling runs every 60 s while the tab is visible and every 5 min while hidden. While
no live source answers, the interval backs off (2 m, 4 m, 8 m, capped at 10 m); a
manual Refresh or the browser's `online` event resets it. Unchanged data skips the
DOM and marker rebuild. Incidents are always de-duplicated and sorted newest first.

## Deploy

Deploy the repository root to Vercel. No configuration file is required: `index.html`
is served statically and `api/traffic.js` becomes the `/api/traffic` function.

To enable Street View thumbnails in marker popups, set `GOOGLE_API_KEY` at the top of
the script in `index.html` to a key with the Street View Static API enabled.

## Local development

Open `index.html` through any static server (for example `python3 -m http.server`).
Without the Vercel function the app falls through to the direct MDPD fetch and then to
the embedded fallback data, so the UI still loads.
