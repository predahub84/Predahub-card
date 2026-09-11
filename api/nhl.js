export default async function handler(req, res) {
  const path = (req.query.path || '').replace(/^\/+/, '');
  if (!/^[\w\-\/\.]+$/.test(path)) { res.status(400).json({ error: 'bad path' }); return; }
  try {
    const r = await fetch('https://api-web.nhle.com/v1/' + path);
    const data = await r.text();
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600');
    res.status(r.status).setHeader('Content-Type', 'application/json').send(data);
  } catch (e) { res.status(502).json({ error: String(e) }); }
}
