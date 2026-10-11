#!/usr/bin/env node
// Actualiza data/ con los temas del foro Managercycling.
//  node scripts/update.js          incremental: temas nuevos o con respuestas nuevas
//  node scripts/update.js --full   vuelve a leer toda la temporada actual
// Si falta alguna temporada de scripts/config.json en data/, la descarga entera
// (así el primer arranque en GitHub crea todos los datos). Sin dependencias: Node 18+.
const fs = require('fs');
const path = require('path');
const here = __dirname;
require(path.join(here, 'mcparse.js'));
require(path.join(here, 'build.js'));
require(path.join(here, 'forum.js'));

const ROOT = path.resolve(here, '..');
const DATA = path.join(ROOT, 'data');
const cfg = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
const FULL = process.argv.includes('--full');
const MAX = +(process.env.MAX_TOPICS || 400);
const DEADLINE = Date.now() + (+(process.env.MAX_MINUTES || 300)) * 60000;

function load() {
  const f = path.join(DATA, 'core.json');
  if (!fs.existsSync(f)) return { v: 2, seasons: [], done: [], teams: [], riders: [], races: [], ins: [] };
  const core = JSON.parse(fs.readFileSync(f, 'utf8'));
  const data = { ...core, races: [], ins: [] };
  for (const s of core.seasons) {
    const p = path.join(DATA, `s${s}.json`);
    if (!fs.existsSync(p)) continue;
    const part = JSON.parse(fs.readFileSync(p, 'utf8'));
    data.races.push(...part.races); data.ins.push(...part.ins);
  }
  return data;
}
function save(data) {
  fs.mkdirSync(DATA, { recursive: true });
  const core = { v: data.v, generated: data.generated, seasons: data.seasons, done: data.done || [], teams: data.teams, riders: data.riders };
  for (const s of data.seasons) {
    const part = { races: data.races.filter(r => r.s === s), ins: data.ins.filter(i => i.s === s) };
    fs.writeFileSync(path.join(DATA, `s${s}.json`), JSON.stringify(part));
  }
  fs.writeFileSync(path.join(DATA, 'core.json'), JSON.stringify(core));
}
function ingest(data, raw) {
  const comp = MCBuild.Compactor(data);
  MCBuild.ingest(comp, raw, { onError: (x, e) => console.log('No se pudo leer', x.t.title, e.message) });
  const done = data.done || [];
  const out = comp.finish({ generated: new Date().toISOString() });
  out.done = done;
  return out;
}

(async () => {
  let data = load();
  const F = MCForum.Forum({ DOMParser: null, gap: +(process.env.GAP_MS || 900) });

  // 1) Temporadas que aún no están en data/ (primer arranque o temporada añadida al config)
  // seasons already published before this mechanism existed count as done
  if (!data.done || !data.done.length) data.done = data.seasons.filter(y => y !== cfg.current.year && data.races.some(r => r.s === y));
  const have = new Set(data.done);
  for (const s of (cfg.seasons || []).slice().sort((a, b) => b.year - a.year)) {
    if (have.has(s.year) || s.year === cfg.current.year) continue;
    if (Date.now() > DEADLINE) break;
    console.log(`Temporada ${s.year}: descargando todo…`);
    const raw = [];
    for (const [kind, fid] of [['res', s.res], ['ins', s.ins]]) {
      const topics = (await F.forumTopics(fid)).filter(t => /^\d/.test(t.title));
      console.log(`  ${kind}: ${topics.length} temas`);
      for (const t of topics) { try { raw.push(await F.topic(t, kind)); } catch (e) { console.log(`  Error en ${t.title}: ${e.message}`); } }
    }
    data = ingest(data, raw);
    data.done = [...new Set([...(data.done || []), s.year])].sort();
    save(data);
    console.log(`  Guardada: ${data.races.length} carreras en total.`);
  }

  // 2) Temporada actual: temas nuevos o modificados
  const known = new Map();
  data.races.forEach(r => known.set('res' + r.id, r.rp));
  data.ins.forEach(i => known.set('ins' + i.id, i.rp));
  const firstRun = !data.races.some(r => r.s === cfg.current.year);
  const changed = [];
  for (const [kind, fid] of [['res', cfg.current.res], ['ins', cfg.current.ins]]) {
    const stopAt = (FULL || firstRun) ? null : page => page.length > 0 && page.every(t => !/^\d/.test(t.title) || known.get(kind + t.id) === t.replies);
    const topics = await F.forumTopics(fid, { stopAt });
    for (const t of topics) if (/^\d/.test(t.title) && (FULL || firstRun || known.get(kind + t.id) !== t.replies)) changed.push({ t, kind });
    console.log(`${kind}: ${topics.length} temas revisados`);
  }
  if (!changed.length) { console.log('Sin cambios en el foro.'); if (!fs.existsSync(path.join(DATA, 'core.json'))) save(data); return; }
  const todo = firstRun ? changed : changed.slice(0, MAX);
  console.log(`Descargando ${todo.length} temas…`);
  const raw = [];
  for (const { t, kind } of todo) {
    if (Date.now() > DEADLINE) break;
    try { raw.push(await F.topic(t, kind)); process.stdout.write('.'); }
    catch (e) { console.log(`\nError en ${t.title}: ${e.message}`); }
  }
  console.log('');
  data = ingest(data, raw);
  save(data);
  console.log(`Guardado: ${data.races.length} carreras, ${data.ins.length} inscripciones, ${data.riders.length} corredores.`);
})().catch(e => { console.error(e); process.exit(1); });
