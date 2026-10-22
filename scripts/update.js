#!/usr/bin/env node
// Actualiza los datos de la web.
//
// 0. Desde 2026 los resultados salen de la web oficial (managercycling-web.vercel.app): raw/oficial/<año>/.
// 1. Del foro guarda cada tema tal cual en raw/<año>/<tipo>-<id>.json.gz (resultados de temporadas
//    anteriores e inscripciones); solo descarga los temas nuevos o con respuestas nuevas.
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
const crypto = require('crypto');
const here = __dirname;
require(path.join(here, 'mcparse.js'));
require(path.join(here, 'build.js'));
require(path.join(here, 'forum.js'));
require(path.join(here, 'official.js'));
require(path.join(here, 'predict.js'));

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

// ---------- web oficial de Managercycling ----------
// Desde la temporada OFFICIAL_FROM los resultados salen sólo de https://managercycling-web.vercel.app: cada prueba con
// todas sus clasificaciones, puntos y días, tal y como cuentan para la oficial. Se guarda una copia en
// raw/oficial/<año>/ (un archivo por prueba, así sólo cambian las pruebas que la web modifica).
const OFFICIAL = cfg.official || MCOfficial.BASE;
const OFFICIAL_FROM = +(cfg.officialFrom || 2026);
const offDir = y => path.join(RAW, 'oficial', String(y));
const gzWrite = (f, s) => fs.writeFileSync(f, zlib.gzipSync(s, { level: 9 }));
const gzRead = f => zlib.gunzipSync(fs.readFileSync(f)).toString('utf8');

function readOfficial(y) {
  const dir = offDir(y), ixf = path.join(dir, 'index.json');
  if (!fs.existsSync(ixf)) return null;
  const ix = JSON.parse(fs.readFileSync(ixf, 'utf8'));
  ix.events = ix.events.map(([e, n, type, category]) => {
    const f = path.join(dir, `e-${e}.json.gz`);
    return { e, n, type, category, rows: fs.existsSync(f) ? JSON.parse(gzRead(f)) : [] };
  });
  return ix;
}

async function fetchOfficial(season) {
  const get = async u => { const r = await fetch(OFFICIAL + u, { headers: { 'user-agent': 'managercycling-stats' }, signal: AbortSignal.timeout(90000) }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); };
  const prev = readOfficial(season);
  const res = await MCOfficial.fetchSeason({ base: OFFICIAL, season, get, getJSON: async u => JSON.parse(await get(u)), meta: prev ? prev.meta : {}, log: m => console.log('  ' + m) });
  if (res.events.length < 1 || res.events.reduce((a, e) => a + e.rows.length, 0) < 100) throw new Error('la web oficial no trae resultados');
  const dir = offDir(season); fs.mkdirSync(dir, { recursive: true });
  let changed = 0;
  const keep = new Set();
  for (const ev of res.events) {
    const f = path.join(dir, `e-${ev.e}.json.gz`), s = JSON.stringify(ev.rows);
    keep.add(path.basename(f));
    if (fs.existsSync(f) && gzRead(f) === s) continue;
    gzWrite(f, s); changed++;
  }
  for (const f of fs.readdirSync(dir)) if (/^e-\d+\.json\.gz$/.test(f) && !keep.has(f)) { fs.unlinkSync(path.join(dir, f)); changed++; }
  const ix = { season, src: res.src, sourceDate: res.sourceDate, events: res.events.map(e => [e.e, e.n, e.type, e.category, e.rows.length]), meta: res.meta, rank: res.rank };
  const ixf = path.join(dir, 'index.json');
  const old = fs.existsSync(ixf) ? JSON.parse(fs.readFileSync(ixf, 'utf8')) : null;
  if (changed || !old || JSON.stringify({ ...old, at: null }) !== JSON.stringify({ ...ix, at: null })) {
    ix.at = new Date().toISOString();
    fs.writeFileSync(ixf, JSON.stringify(ix));
  }
  console.log(`Web oficial ${season}: ${res.events.length} pruebas, ${res.events.reduce((a, e) => a + e.rows.length, 0)} filas, ${changed} pruebas nuevas o cambiadas.`);
}

// mercado de la próxima temporada (traspasos confirmados y retirados): raw/oficial/mercado.json
const marketFile = path.join(RAW, 'oficial', 'mercado.json');
async function fetchMarket() {
  const get = async u => { const r = await fetch(OFFICIAL + u, { headers: { 'user-agent': 'managercycling-stats' }, signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); };
  const m = await MCOfficial.fetchMarket({ get, log: x => console.log('  ' + x) });
  if (!m.year) throw new Error('formato inesperado');
  const old = fs.existsSync(marketFile) ? JSON.parse(fs.readFileSync(marketFile, 'utf8')) : null;
  if (old && JSON.stringify({ ...old, at: null }) === JSON.stringify({ ...m, at: null })) { console.log(`Mercado ${m.year}: sin cambios.`); return; }
  m.at = new Date().toISOString();
  fs.mkdirSync(path.dirname(marketFile), { recursive: true });
  fs.writeFileSync(marketFile, JSON.stringify(m));
  console.log(`Mercado ${m.year}: ${m.transfers.length} traspasos de corredores, ${m.retired.length} retirados.`);
}

// plantillas con medias de esta temporada y de la próxima (para la predicción): raw/oficial/plantillas.json
const rosterFile = path.join(RAW, 'oficial', 'plantillas.json');
async function fetchRostersAll(years) {
  const old = fs.existsSync(rosterFile) ? JSON.parse(fs.readFileSync(rosterFile, 'utf8')) : null;
  const chk = rosterFile.replace(/\.json$/, '.checked'); // fuera de la huella de datos: comprobar no obliga a reconstruir
  const last = fs.existsSync(chk) ? Date.parse(fs.readFileSync(chk, 'utf8')) : 0;
  if (old && Date.now() - last < 2 * 3600e3 && years.every(y => old.seasons[y])) return; // cada 2 horas basta
  const get = async u => { const r = await fetch(OFFICIAL + u, { headers: { 'user-agent': 'managercycling-stats' }, signal: AbortSignal.timeout(60000) }); if (!r.ok) throw new Error(u + ' ' + r.status); return r.text(); };
  const seasons = {};
  for (const y of years) { seasons[y] = await MCOfficial.fetchRosters({ get, season: y }); if (seasons[y].length < 500) throw new Error(`plantillas ${y} incompletas`); }
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(rosterFile), { recursive: true });
  fs.writeFileSync(chk, now);
  if (old && JSON.stringify(old.seasons) === JSON.stringify(seasons)) { console.log('Plantillas y medias: sin cambios.'); return; }
  fs.writeFileSync(rosterFile, JSON.stringify({ at: now, seasons }));
  console.log(`Plantillas y medias: ${years.map(y => `${seasons[y].length} corredores en ${y}`).join(', ')}.`);
}
function predictNext(offs) {
  if (!fs.existsSync(rosterFile) || !offs.length) return undefined;
  const R = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
  const off = offs.sort((a, b) => b.season - a.season)[0], cur = off.season, next = cur + 1;
  if (!R.seasons[cur] || !R.seasons[next]) return undefined;
  const youth = {}; let teamClass = 0;
  for (const ev of off.events) for (const x of ev.rows) { if (x[0] === 'Jóvenes' && x[2] != null) youth[x[2]] = (youth[x[2]] || 0) + (x[6] || 0); if (x[0] === 'Equipos') teamClass += x[6] || 0; }
  const t0 = Date.now();
  const p = MCPredict.run(R.seasons[cur], R.seasons[next], youth, teamClass, { year: next, from: cur });
  p.at = R.at;
  console.log(`Predicción ${next}: modelo con ${p.quality.n} corredores (R² ${p.quality.r2}, correlación ${p.quality.corr}, por equipos ${p.quality.teamCorr}) en ${Math.round((Date.now() - t0) / 1000)} s.`);
  return p;
}

// comprobación: los totales que calcula la web deben ser los de las clasificaciones oficiales
function checkOfficial(data, off) {
  if (!off.rank) return;
  const tot = MCBuild.seasonTotals(data, off.season);
  const byOid = new Map(Object.entries(data.oid || {}).map(([k, v]) => [v, +k]));
  let bad = 0, ex = [];
  for (const [oid, name, pts, days] of off.rank.riders) {
    const o = tot.riders.get(byOid.get(oid)) || { pts: 0, days: 0 };
    if (Math.abs(o.pts - pts) > 0.01 || o.days !== days) { bad++; if (ex.length < 5) ex.push(`${name} ${o.pts}/${pts} pts ${o.days}/${days} días`); }
  }
  const tName = new Map(); for (const ev of off.events) for (const x of ev.rows) if (x[4] != null && x[5]) tName.set(x[4], x[5]);
  let tbad = 0;
  for (const [tid, name, pts] of off.rank.teams) { const id = data.teams.findIndex(t => MC.teamKey(t) === MC.teamKey(tName.get(tid) || name)); const v = tot.teams.get(id) || 0; if (Math.abs(v - pts) > 0.5) { tbad++; if (ex.length < 8) ex.push(`${name} ${v}/${pts}`); } }
  console.log(`Comprobación ${off.season} con la clasificación oficial: ${off.rank.riders.length - bad}/${off.rank.riders.length} corredores y ${off.rank.teams.length - tbad}/${off.rank.teams.length} equipos cuadran${ex.length ? ' · ' + ex.join(' · ') : ''}.`);
}

// huella de todo lo que entra en la reconstrucción: si no cambia, no se reescribe data/ (ni se hace commit)
function inputsHash() {
  const h = crypto.createHash('sha1');
  const add = f => { if (fs.existsSync(f)) { h.update(f); h.update(fs.readFileSync(f)); } };
  add(path.join(RAW, 'index.json'));
  const od = path.join(RAW, 'oficial');
  if (fs.existsSync(od)) for (const y of fs.readdirSync(od).sort()) add(/\.json$/.test(y) ? path.join(od, y) : path.join(od, y, 'index.json'));
  for (const f of fs.readdirSync(here).sort()) if (/\.(js|json)$/.test(f)) add(path.join(here, f));
  return h.digest('hex').slice(0, 16);
}

function rebuild() {
  const comp = MCBuild.Compactor();
  const years = fs.existsSync(RAW) ? fs.readdirSync(RAW).filter(d => /^\d{4}$/.test(d)).sort() : [];
  let n = 0;
  const offs = [];
  for (const y of years) if (+y >= OFFICIAL_FROM) { const o = readOfficial(+y); if (o) offs.push(o); }
  const offY = new Set(offs.map(o => String(o.season)));
  for (const y of years) {
    // temporadas con web oficial: del foro sólo las inscripciones (calendario, inscritos, fotos)
    const files = fs.readdirSync(path.join(RAW, y)).filter(f => f.endsWith('.json.gz') && !(offY.has(y) && f.startsWith('res-'))).sort((a, b) => (+a.match(/\d+/)[0]) - (+b.match(/\d+/)[0]));
    const topics = files.map(f => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(RAW, y, f))).toString('utf8')));
    MCBuild.ingest(comp, topics, { onError: (x, e) => console.log('No se pudo leer', x.t.title, e.message) });
    n += topics.length;
  }
  for (const o of offs) comp.addOfficialSeason(o);
  const data = comp.finish({ generated: new Date().toISOString() });
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of fs.readdirSync(DATA)) if (/^s\d{4}\.json$/.test(f) && !data.seasons.includes(+f.slice(1, 5))) fs.unlinkSync(path.join(DATA, f));
  for (const o of offs) checkOfficial(data, o);
  const offInfo = Object.fromEntries(offs.map(o => [o.season, { at: o.at, src: o.src, sourceDate: o.sourceDate }]));
  for (const s of data.seasons) {
    const part = { races: data.races.filter(r => r.s === s), ins: data.ins.filter(i => i.s === s) };
    if (offInfo[s]) part.official = offInfo[s];
    fs.writeFileSync(path.join(DATA, `s${s}.json`), JSON.stringify(part));
  }
  const market = fs.existsSync(marketFile) ? JSON.parse(fs.readFileSync(marketFile, 'utf8')) : undefined;
  let pred; try { pred = predictNext(offs); } catch (e) { console.log('No se pudo calcular la predicción: ' + e.message); }
  // categoría de cada equipo (WT / CP) según la clasificación oficial más reciente
  const div = {};
  for (const o of offs.slice().sort((a, b) => a.season - b.season)) for (const t of (o.rank && o.rank.teams) || []) if (t[3]) div[t[1]] = t[3];
  const core = { v: data.v, generated: data.generated, inputs: inputsHash(), market, pred, div: Object.keys(div).length ? div : undefined, seasons: data.seasons, teams: data.teams, riders: data.riders, oid: data.oid, offSeasons: data.offSeasons };
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
        if (kind === 'res' && s.year >= OFFICIAL_FROM) continue; // resultados: de la web oficial
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
    for (const y of [...new Set([cfg.current.year, ...(cfg.seasons || []).map(s => s.year)])].filter(y => y >= OFFICIAL_FROM)) {
      try { await fetchOfficial(y); } catch (e) { console.log(`No se pudo leer la web oficial (${y}): ${e.message}. Se mantiene la última copia guardada.`); }
    }
    try { await fetchMarket(); } catch (e) { console.log('No se pudo leer el mercado de la web oficial: ' + e.message); }
    try { await fetchRostersAll([cfg.current.year, cfg.current.year + 1]); } catch (e) { console.log('No se pudieron leer las plantillas de la web oficial: ' + e.message); }
    const oldOff = path.join(RAW, `oficial-${cfg.current.year}.json`); if (fs.existsSync(oldOff)) fs.unlinkSync(oldOff);
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
  if (!ONLY_REBUILD) {
    try { const core = JSON.parse(fs.readFileSync(path.join(DATA, 'core.json'), 'utf8')); if (core.inputs && core.inputs === inputsHash()) { console.log('Sin novedades en la web oficial ni en el foro: los datos siguen igual.'); return; } } catch (e) { /* reconstruir */ }
  }
  rebuild();
})().catch(e => { console.error(e); process.exit(1); });
