// Relais images NHL (photos, logos) pour que l'export PNG fonctionne
export default async function handler(req, res) {
  const url = req.query.url || '';
  if (!/^https:\/\/assets\.nhle\.com\//.test(url)) { res.status(400).send('bad url'); return; }
  try {
    const r = await fetch(url);
    if (!r.ok) { res.status(r.status).send('not found'); return; }
    const buf = Buffer.from(await r.arrayBuffer());
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/png');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=86400');
    res.status(200).send(buf);
  } catch (e) { res.status(502).send(String(e)); }
}
