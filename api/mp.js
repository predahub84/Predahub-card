/* =============================================================
   /api/mp  —  proxy MoneyPuck (Vercel serverless)
   -------------------------------------------------------------
   Le navigateur n'accede JAMAIS directement a MoneyPuck :
     - CORS bloque
     - certains fichiers sont des ZIP de plusieurs Mo
   Ce proxy :
     - telecharge le fichier cote serveur
     - decompresse si besoin
     - filtre sur le joueur demande AVANT d'envoyer au client
     - met en cache (memoire + CDN) pour ne pas spammer la source
   Credit obligatoire : MoneyPuck.com
   ============================================================= */

const zlib = require('zlib');

const MP = 'https://moneypuck.com/moneypuck';
const PT = 'https://peter-tanner.com/moneypuck/downloads';

/* --- catalogue des fichiers connus ------------------------- */
const SOURCES = {
  // totaux de saison, un fichier par saison (CSV direct)
  seasonSkaters: s => `${MP}/playerData/seasonSummary/${s}/regular/skaters.csv`,
  seasonGoalies: s => `${MP}/playerData/seasonSummary/${s}/regular/goalies.csv`,
  seasonLines:   s => `${MP}/playerData/seasonSummary/${s}/regular/lines.csv`,
  seasonTeams:   s => `${MP}/playerData/seasonSummary/${s}/regular/teams.csv`,
  // match par match, par equipe (CSV direct) — a confirmer par le diagnostic
  teamGameByGame: (s, t) =>
    `${MP}/playerData/teamPlayerGameByGame/${s}/regular/skaters/${t}.csv`,
  // match par match, toute la ligue (ZIP)
  seasonGameZip: s => `${PT}/seasonPlayersSummary/skaters/${s}.zip`,
  linesGameZip:  s => `${PT}/seasonPlayersSummary/lines/${s}.zip`,
  // biographies
  bios: () => `${MP}/playerData/playerBios/allPlayersLookup.csv`
};

/* --- cache memoire (persiste tant que la lambda est chaude) - */
const mem = new Map();
const TTL = 6 * 60 * 60 * 1000; // 6 h
const MAXMEM = 24;

function cacheGet(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (Date.now() - e.t > TTL) { mem.delete(k); return null; }
  return e.v;
}
function cacheSet(k, v) {
  if (mem.size >= MAXMEM) mem.delete(mem.keys().next().value);
  mem.set(k, { t: Date.now(), v });
}

/* --- anti-spam : une seule requete simultanee par URL ------- */
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/* --- telechargement + decompression ------------------------ */
async function fetchText(url) {
  const cached = cacheGet(url);
  if (cached) return cached;

  return once(url, async () => {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'PredaHUB/1.0 (contact via predahub)' }
    });
    if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { status: r.status });

    const buf = Buffer.from(await r.arrayBuffer());
    let text;
    // ZIP ? (signature PK\x03\x04)
    if (buf[0] === 0x50 && buf[1] === 0x4b) {
      text = unzipFirstCsv(buf);
    } else if (buf[0] === 0x1f && buf[1] === 0x8b) {
      text = zlib.gunzipSync(buf).toString('utf8');
    } else {
      text = buf.toString('utf8');
    }
    cacheSet(url, text);
    return text;
  });
}

/* Decompression ZIP minimale : on lit le 1er fichier .csv deflate */
function unzipFirstCsv(buf) {
  let off = 0;
  while (off < buf.length - 4) {
    if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const method = buf.readUInt16LE(off + 8);
    let compSize = buf.readUInt32LE(off + 18);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString('utf8');
    const dataStart = off + 30 + nameLen + extraLen;

    if (!/\.csv$/i.test(name)) { off = dataStart + (compSize || 1); continue; }

    // taille inconnue (streaming) -> on prend jusqu'au prochain entete
    if (compSize === 0) {
      let next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), dataStart);
      if (next < 0) next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), dataStart);
      compSize = (next < 0 ? buf.length : next) - dataStart;
    }
    const data = buf.slice(dataStart, dataStart + compSize);
    if (method === 0) return data.toString('utf8');
    if (method === 8) return zlib.inflateRawSync(data).toString('utf8');
    throw new Error('Methode de compression ZIP non supportee: ' + method);
  }
  throw new Error('Aucun CSV trouve dans le ZIP');
}

/* --- CSV -> objets ----------------------------------------- */
function splitLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
function parseCsv(text, filter) {
  const lines = text.split(/\r?\n/);
  if (!lines.length) return { header: [], rows: [] };
  const header = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    // pre-filtre texte : evite de parser 100 000 lignes inutiles
    if (filter && filter.needle && l.indexOf(filter.needle) === -1) continue;
    const c = splitLine(l);
    const o = {};
    for (let j = 0; j < header.length; j++) {
      const v = c[j];
      o[header[j]] = v === '' || v === undefined ? null
        : (isNaN(v) || v.trim() === '' ? v : Number(v));
    }
    if (filter && filter.match && !filter.match(o)) continue;
    rows.push(o);
  }
  return { header, rows };
}

/* --- handler ----------------------------------------------- */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const q = req.query || {};
  const kind = q.kind;
  const season = String(q.season || '2025');
  const team = (q.team || '').toUpperCase();
  const playerId = q.playerId ? String(q.playerId) : null;
  const name = q.name ? String(q.name) : null;
  const situation = q.situation || null; // all / 5on5 / 5on4 / 4on5 / other

  try {
    if (!SOURCES[kind]) {
      return res.status(400).json({
        error: 'kind inconnu',
        kinds: Object.keys(SOURCES)
      });
    }
    const url = kind === 'teamGameByGame' ? SOURCES[kind](season, team)
              : kind === 'bios' ? SOURCES[kind]()
              : SOURCES[kind](season);

    const text = await fetchText(url);

    // filtre : on ne renvoie au navigateur que ce qui concerne le joueur
    const needle = playerId || name || null;
    const match = o => {
      if (playerId && String(o.playerId) !== String(playerId)) return false;
      if (!playerId && name && String(o.name || '').toLowerCase() !== name.toLowerCase()) return false;
      if (situation && o.situation != null && o.situation !== situation) return false;
      return true;
    };
    const { header, rows } = parseCsv(text, (needle || situation) ? { needle, match } : null);

    // cache CDN : 6 h, revalidation en arriere-plan
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
    res.status(200).json({
      source: 'MoneyPuck.com',
      url,
      kind, season, team: team || null,
      columns: header,
      count: rows.length,
      rows,
      fetchedAt: new Date().toISOString()
    });
  } catch (e) {
    res.status(e.status === 404 ? 404 : 502).json({
      error: 'Recuperation MoneyPuck impossible',
      detail: String(e && e.message || e),
      kind, season, team: team || null
    });
  }
};
