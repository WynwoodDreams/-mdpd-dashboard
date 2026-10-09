# MDPD Live Traffic Feed

A single-page live operations console for Miami-Dade Police Department traffic
incidents: a dark, high-density map + feed showing active accidents, injuries,
hit & runs and other incidents from `traffic.mdpd.com`.

## Layout

| Path | Purpose |
|------|---------|
| `index.html` | The entire app: styles, SVG icon sprite, markup and JavaScript. No build step. |
| `api/traffic.js` | Vercel serverless function served at `/api/traffic`. Proxies the MDPD feed with edge caching (30 s fresh, 60 s stale-while-revalidate). |
| `DESIGN_REFINEMENT.md` | V2 design guidelines and guardrails. All Section 3 and 4 items are implemented. |
| `PERFORMANCE_ENGINEERING_PLAN.md` | Performance plan with an implementation-status table. |

## Data flow

1. `GET /api/traffic` (Vercel proxy, edge cached)
2. `GET https://traffic.mdpd.com/api/traffic` directly (works only if CORS allows it)
3. Embedded `FALLBACK_DATA` in `index.html` — the header badge shows `CACHED · <age> OLD`

Polling runs every 60 s while the tab is visible and every 5 min while hidden.
Unchanged data skips the DOM and marker rebuild.

## Deploy

Deploy the repository root to Vercel. No configuration file is required: `index.html`
is served statically and `api/traffic.js` becomes the `/api/traffic` function.

To enable Street View thumbnails in marker popups, set `GOOGLE_API_KEY` at the top of
the script in `index.html` to a key with the Street View Static API enabled.

## Local development

Open `index.html` through any static server (for example `python3 -m http.server`).
Without the Vercel function the app falls through to the direct MDPD fetch and then to
the embedded fallback data, so the UI still loads.
