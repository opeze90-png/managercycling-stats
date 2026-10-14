#!/usr/bin/env node
// Actualiza los datos de la web a partir del foro Managercycling.
//
// 1. Guarda cada tema del foro tal cual en raw/<año>/<tipo>-<id>.json.gz
//    (solo descarga los temas nuevos o con respuestas nuevas).
// 2. Reconstruye data/ entero desde raw/ con el analizador actual, así
//    cualquier mejora del analizador se aplica también a temporadas pasadas.
//
//  node scripts/update.js            incremental
//  node scripts/update.js --full     vuelve a descargar la temporada actual
//  node scripts/update.js --rebuild  solo reconstruye data/ desde raw/
// Sin dependencias: Node 18+.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const here = __dirname;
require(path.join(here, 'mcparse.js'));
require(path.join(here, 'build.js'));
require(path.join(here, 'forum.js'));

const ROOT = path.resolve(here, '..');
const DATA = path.join(ROOT, 'data');
const RAW = path.join(ROOT, 'raw');
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
const FULL = process.argv.includes('--full');
const ONLY_REBUILD = process.argv.includes('--rebuild');
const DEADLINE = Date.now() + (+(process.env.MAX_MINUTES || 300)) * 60000;

const idxFile = path.join(RAW, 'index.json');
const index = fs.existsSync(idxFile) ? JSON.parse(fs.readFileSync(idxFile, 'utf8')) : { topics: {}, done: [] };
const saveIndex = () => { fs.mkdirSync(RAW, { recursive: true }); fs.writeFileSync(idxFile, JSON.stringify(index, null, 0)); };
const rawPath = (y, kind, id) => path.join(RAW, String(y), `${kind}-${id}.json.gz`);

function storeTopic(y, x) {
  const p = rawPath(y, x.t.kind, x.id);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, zlib.gzipSync(JSON.stringify(x), { level: 9 }));
  index.topics[x.t.kind + '-' + x.id] = { y, r: x.t.replies, t: x.t.title, im: 1 };
}

async function download(F, y, kind, topics) {
  let n = 0;
  for (const t of topics) {
    if (Date.now() > DEADLINE) { console.log('  Tiempo agotado, se seguirá en la próxima ejecución.'); return false; }
    try { storeTopic(y, await F.topic(t, kind)); n++; if (n % 25 === 0) { saveIndex(); process.stdout.write(`${n} `); } }
    catch (e) { console.log(`\n  Error en ${t.title}: ${e.message}`); }
  }
  saveIndex();
  if (n) console.log(`  ${kind}: ${n} temas guardados`);
  return true;
}

// ---------- clasificación oficial (web de Managercycling) ----------
// La web oficial publica la clasificación de corredores, la de equipos, los días de competición y qué
// pruebas/etapas ya tiene cargadas. Cada ejecución la descarga (raw/oficial-<año>.json) y calcula un ajuste:
//   total mostrado = oficial + lo que el foro tiene y la oficial todavía no (pruebas o etapas posteriores)
// Así la web cuadra con la oficial (abandonos, cronos por equipos, correcciones…) y sigue sumando sola.
const OFFICIAL = cfg.official || 'https://managercycling-web.vercel.app';
function rscArray(html, key, must) {
  const t = html.replace(/\\\\"/g, '"').replace(/\\"/g, '"');
  let from = 0;
  for (;;) {
    const i = t.indexOf('"' + key + '":[', from); if (i < 0) return null;
    let d = 0, j = i + key.length + 3;
    for (; j < t.length; j++) { const c = t[j]; if (c === '[') d++; else if (c === ']') { d--; if (!d) break; } }
    const s = t.slice(i + key.length + 3, j + 1);
    if (!must || s.includes(must)) { try { return { v: JSON.parse(s), t }; } catch (e) { /* sigue */ } }
    from = j;
  }
}
async function fetchOfficial(season) {
  const get = async u => { const r = await fetch(OFFICIAL + u, { headers: { 'user-agent': 'managercycling-stats' }, signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); };
  const rid = rscArray(await get('/clasificaciones/ciclistas'), 'rows', '"cyclist"');
  const tm = rscArray(await get('/clasificaciones'), 'rows', '"team"');
  const ev = rscArray(await get('/resultados'), 'events', '"classifications"');
  if (!rid || !tm || !ev || rid.v.length < 100) throw new Error('formato inesperado');
  const prov = (rid.t.match(/"sourceDate":"([^"]+)"/) || [])[1] || null;
  const o = { season, at: new Date().toISOString(), src: OFFICIAL, sourceDate: prov,
    riders: rid.v.map(r => [r.cyclist, r.team, r.points, r.daysCompetition]),
    teams: tm.v.map(r => [r.team, r.points]),
    events: ev.v.map(e => [e.event, e.classifications.map(c => c.name)]) };
  const f = path.join(RAW, `oficial-${season}.json`);
  const prev = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
  const strip = x => JSON.stringify({ ...x, at: null });
  if (!prev || strip(JSON.parse(prev)) !== strip(o)) { fs.mkdirSync(RAW, { recursive: true }); fs.writeFileSync(f, JSON.stringify(o)); console.log(`Clasificación oficial ${season} descargada: ${o.riders.length} corredores, ${o.events.length} pruebas.`); }
  else console.log(`Clasificación oficial ${season} sin cambios.`);
}

function officialAdjust(data) {
  const out = {};
  if (!fs.existsSync(RAW)) return out;
  for (const f of fs.readdirSync(RAW).filter(f => /^oficial-\d{4}\.json$/.test(f))) {
    const off = JSON.parse(fs.readFileSync(path.join(RAW, f), 'utf8'));
    const y = +off.season;
    if (!data.seasons.includes(y)) continue;
    const key = n => MC.riderKey(String(n));
    // la parte de la temporada que la oficial ya tiene cargada
    const evs = new Map(off.events.map(([n, cls]) => [key(n), new Set(cls)]));
    const races = [];
    for (const r of data.races) {
      if (r.s !== y) continue;
      const cls = evs.get(key(r.name)); if (!cls) continue;
      const c = JSON.parse(JSON.stringify(r));
      if (!r.multi) { if (!cls.has('Clásica')) c.st = []; }
      else {
        const k = [...cls].filter(x => /^Etapa \d/.test(x)).length;
        const order = [...new Set(r.st.map(s => Math.floor(s.n)))].sort((a, b) => a - b);
        const keep = new Set(order.slice(0, k));
        c.st = r.st.filter(s => keep.has(Math.floor(s.n)));
        if (c.cl.LDR && k < order.length) { const last = Math.max(...keep); c.cl.LDR = c.cl.LDR.filter(w => w[0] <= last); }
        if (k < order.length) c.end = '9999-12-31';
      }
      for (const [ck, on] of [['GC', 'General'], ['PTS', 'Regularidad'], ['KOM', 'Montaña'], ['YOU', 'Jóvenes'], ['TEAM', 'Equipos']]) if (c.cl[ck] && !cls.has(on)) delete c.cl[ck];
      races.push(c);
    }
    const bt = MCBuild.seasonTotals({ ...data, races }, y), nt = MCBuild.seasonTotals(data, y);
    const lev = (a, b) => { const d = []; for (let i = 0; i <= a.length; i++) { d[i] = [i]; for (let j = 1; j <= b.length; j++) d[i][j] = i ? Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) : j; } return d[a.length][b.length]; };
    const active = [...nt.riders.keys()];
    const byKey = new Map(), byTok = new Map();
    for (const i of active.concat(data.riders.map((_, i) => i))) { const n = data.riders[i][0]; if (!byKey.has(MC.riderKey(n))) byKey.set(MC.riderKey(n), i); if (!byTok.has(MC.tokenKey(n))) byTok.set(MC.tokenKey(n), i); }
    const findRider = name => {
      const n = MC.norm(String(name).replace(/\(J\)/gi, ''));
      let id = byKey.get(MC.riderKey(n)); if (id != null) return id;
      id = byTok.get(MC.tokenKey(n)); if (id != null) return id;
      const tk = MC.tokenKey(n); let best = -1, bd = 3;
      for (const i of active) { const k = MC.tokenKey(data.riders[i][0]); if (Math.abs(k.length - tk.length) > 2) continue; const d = lev(tk, k); if (d < bd) { bd = d; best = i; } }
      return bd <= (tk.length > 12 ? 2 : 1) ? best : -1;
    };
    const r = {}, seen = new Set();
    let matched = 0;
    for (const [name, team, pts, days] of off.riders) {
      const id = findRider(name); if (id < 0) continue;
      matched++; seen.add(id);
      const b = bt.riders.get(id) || { pts: 0, days: 0 };
      const c = r[id] || [0, 0]; c[0] += (pts || 0) - b.pts; c[1] += (days || 0) - b.days; r[id] = c;
    }
    for (const [id, b] of bt.riders) if (!seen.has(id) && (b.pts || b.days)) r[id] = [-b.pts, -b.days];
    for (const k of Object.keys(r)) { r[k] = [Math.round(r[k][0] * 1e4) / 1e4, r[k][1]]; if (Math.abs(r[k][0]) < 0.005 && !r[k][1]) delete r[k]; }
    const sig = n => MC.norm(n).toLowerCase().split(/[\s\-|/]+/).filter(w => w && !/^(team|cycling|pro|procycling|the|de|-)$/.test(w)).slice(0, 2).join(' ');
    const tpool = [...nt.teams.keys()];
    const findTeam = name => { const k = MC.teamKey(name); for (const t of tpool) if (MC.teamKey(data.teams[t]) === k) return t; const g = sig(name); for (const t of tpool) if (sig(data.teams[t]) === g) return t; return -1; };
    const t = {};
    for (const [name, pts] of off.teams || []) { const id = findTeam(name); if (id < 0) continue; const v = Math.round((pts - (bt.teams.get(id) || 0)) * 1e4) / 1e4; if (Math.abs(v) >= 0.005) t[id] = v; }
    out[y] = { at: off.at, src: off.src, sourceDate: off.sourceDate, r, t };
    console.log(`Clasificación oficial ${y}: ${matched}/${off.riders.length} corredores enlazados, ${races.length} pruebas en común, ${Object.keys(r).length} ajustes de corredor, ${Object.keys(t).length} de equipo.`);
  }
  return out;
}

function rebuild() {
  const comp = MCBuild.Compactor();
  const years = fs.existsSync(RAW) ? fs.readdirSync(RAW).filter(d => /^\d{4}$/.test(d)).sort() : [];
  let n = 0;
  for (const y of years) {
    const files = fs.readdirSync(path.join(RAW, y)).filter(f => f.endsWith('.json.gz')).sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));
    const topics = files.map(f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, y, f))).toString('utf8')));
    MCBuild.ingest(comp, topics, { onError: (x, e) => console.log('No se pudo leer', x.t.title, e.message) });
    n += topics.length;
  }
  const data = comp.finish({ generated: new Date().toISOString() });
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of fs.readdirSync(DATA)) if (/^s\d{4}\.json$/.test(f) && !data.seasons.includes(+f.slice(1, 5))) fs.unlinkSync(path.join(DATA, f));
  const adj = officialAdjust(data);
  for (const s of data.seasons) {
    const part = { races: data.races.filter(r => r.s === s), ins: data.ins.filter(i => i.s === s) };
    if (adj[s]) part.adj = adj[s];
    fs.writeFileSync(path.join(DATA, `s${s}.json`), JSON.stringify(part));
  }
  const core = { v: data.v, generated: data.generated, seasons: data.seasons, teams: data.teams, riders: data.riders };
  fs.writeFileSync(path.join(DATA, 'core.json'), JSON.stringify(core));
  console.log(`Datos reconstruidos desde ${n} temas: ${data.races.length} carreras, ${data.ins.length} inscripciones, ${data.riders.length} corredores.`);
}

(async () => {
  if (!ONLY_REBUILD) {
    const F = MCForum.Forum({ DOMParser: null, gap: +(process.env.GAP_MS || 900) });
    const seasons = [cfg.current, ...(cfg.seasons || [])];
    for (const s of seasons) {
      const isCurrent = s.year === cfg.current.year;
      if (!isCurrent && index.done.includes(s.year)) continue;
      console.log(`Temporada ${s.year}${isCurrent ? ' (actual)' : ''}`);
      let complete = true;
      for (const [kind, fid] of [['res', s.res], ['ins', s.ins]]) {
        const known = t => index.topics[kind + '-' + t.id];
        const fresh = t => known(t) && known(t).r === t.replies;
        const stopAt = isCurrent && !FULL ? page => page.length > 0 && page.every(t => !/^\d/.test(t.title) || fresh(t)) : null;
        const topics = (await F.forumTopics(fid, { stopAt })).filter(t => /^\d/.test(t.title));
        const todo = topics.filter(t => FULL || !fresh(t));
        console.log(`  ${kind}: ${topics.length} temas en el foro, ${todo.length} por descargar`);
        if (!(await download(F, s.year, kind, todo))) { complete = false; break; }
      }
      if (!isCurrent && complete) { index.done.push(s.year); saveIndex(); }
      if (Date.now() > DEADLINE) break;
    }
  }
  // pictures of the first post of each inscription (race profile), for topics saved before we kept them
  if (!ONLY_REBUILD) {
    const F = MCForum.Forum({ DOMParser: null, gap: +(process.env.GAP_MS || 900) });
    const todo = Object.entries(index.topics).filter(([k, v]) => k.startsWith('ins-') && !v.im).sort((a, b) => b[1].y - a[1].y);
    if (todo.length) console.log(`Fotos de perfil: ${todo.length} inscripciones por revisar`);
    let n = 0;
    for (const [k, v] of todo) {
      if (Date.now() > DEADLINE) break;
      const p = rawPath(v.y, 'ins', k.slice(4));
      if (!fs.existsSync(p)) { v.im = 1; continue; }
      try {
        const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString('utf8'));
        const im = await F.firstImages(x.t);
        if (x.posts[0]) { if (im.length) x.posts[0].im = im; else delete x.posts[0].im; }
        fs.writeFileSync(p, zlib.gzipSync(JSON.stringify(x), { level: 9 }));
        v.im = 1; n++;
        if (n % 50 === 0) { saveIndex(); process.stdout.write(`${n} `); }
      } catch (e) { console.log(`\n  Error en ${v.t}: ${e.message}`); }
    }
    saveIndex();
    if (n) console.log(`  ${n} inscripciones revisadas`);
  }
  if (!ONLY_REBUILD && cfg.current) {
    try { await fetchOfficial(cfg.current.year); } catch (e) { console.log('No se pudo leer la clasificación oficial:', e.message); }
  }
  // Topics saved before pictures were read: download them again, newest first, while time remains.
  if (!ONLY_REBUILD) {
    const F = MCForum.Forum({ DOMParser: null, gap: +(process.env.GAP_MS || 900) });
    const years = fs.existsSync(RAW) ? fs.readdirSync(RAW).filter(d => /^\d{4}$/.test(d)).sort().reverse() : [];
    let n = 0;
    outer: for (const y of years) {
      const files = fs.readdirSync(path.join(RAW, y)).filter(f => f.endsWith('.json.gz')).sort((a, b) => (+b.match(/\d+/)[0]) - (+a.match(/\d+/)[0]));
      for (const f of files) {
        if (Date.now() > DEADLINE) break outer;
        const x = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, y, f))).toString('utf8'));
        if (x.iv) continue;
        try { storeTopic(+y, await F.topic(x.t, x.t.kind)); n++; if (n % 25 === 0) { saveIndex(); process.stdout.write(`${n} `); } }
        catch (e) { console.log(`\n  Error en ${x.t.title}: ${e.message}`); }
      }
    }
    saveIndex();
    if (n) console.log(`\nImágenes: ${n} temas actualizados`);
  }
  const missing = (cfg.seasons || []).map(s => s.year).filter(y => !index.done.includes(y));
  if (missing.length && !ONLY_REBUILD && fs.existsSync(path.join(DATA, 'core.json'))) {
    console.log(`Aún faltan temas de ${missing.join(', ')}: se mantienen los datos actuales hasta tenerlo todo.`);
    return;
  }
  rebuild();
})().catch(e => { console.error(e); process.exit(1); });
