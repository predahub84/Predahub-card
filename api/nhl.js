export default async function handler(req, res) {
  const path = (req.query.path || '').replace(/^\/+/, '');
  let base = 'https://api-web.nhle.com/v1/';
  let p = path;
  if (p.startsWith('stats:')) { base = 'https://api.nhle.com/stats/rest/en/'; p = p.slice(6); }
  if (!/^[\w\-\/\.]+$/.test(p)) { res.status(400).json({ error: 'bad path' }); return; }
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== 'path') qs.append(k, v);
  const url = base + p + (qs.toString() ? '?' + qs.toString() : '');
  try {
    const r = await fetch(url);
    const data = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800');
    res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) { res.status(502).json({ error: String(e) }); }
}
