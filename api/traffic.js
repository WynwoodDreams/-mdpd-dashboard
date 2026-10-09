// Vercel serverless proxy for the MDPD traffic feed.
// Lives at /api/traffic — the frontend tries this first, then the MDPD API
// directly, then the embedded fallback data.
const UPSTREAM = 'https://traffic.mdpd.com/api/traffic';
const UPSTREAM_TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  // Edge cache for 30s; serve stale for a further 60s while revalidating,
  // so every dashboard tab polling at 60s shares at most ~2 upstream hits/min.
  res.setHeader('Cache-Control', 's-maxage=30, stale-while-revalidate=60');

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const response = await fetch(UPSTREAM, {
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: { 'Accept': 'application/json' }
    });
    if (!response.ok) throw new Error(`MDPD API returned ${response.status}`);
    const data = await response.json();
    if (!Array.isArray(data)) throw new Error('MDPD API returned a non-array payload');
    res.status(200).json(data);
  } catch (err) {
    // Don't let the edge cache a failure.
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: 'Failed to reach MDPD API', detail: err.message });
  }
}
