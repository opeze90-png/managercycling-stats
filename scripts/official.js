// Lectura de la web oficial de Managercycling (https://managercycling-web.vercel.app).
// Desde 2026 todos los resultados de la temporada salen de ahí: cada fila trae la clasificación, el puesto,
// el corredor, el equipo, los puntos y los días de competición, ya tal y como cuentan para la oficial.
// Sirve igual en Node (scripts/update.js) que en el navegador.
(function (G) {
  const BASE = 'https://managercycling-web.vercel.app';

  // Las páginas son de Next.js: los datos van dentro del HTML como texto JSON escapado.
  const unescape = html => html.replace(/\\\\"/g, '"').replace(/\\"/g, '"');
  function jsonAfter(t, key, must) {
    let from = 0;
    for (;;) {
      const i = t.indexOf('"' + key + '":', from); if (i < 0) return null;
      const st = i + key.length + 3, open = t[st], close = open === '[' ? ']' : open === '{' ? '}' : null;
      if (!close) { from = st; continue; }
      let d = 0, j = st, str = false;
      for (; j < t.length; j++) {
        const c = t[j];
        if (str) { if (c === '\\') j++; else if (c === '"') str = false; continue; }
        if (c === '"') str = true; else if (c === open) d++; else if (c === close) { d--; if (!d) break; }
      }
      const s = t.slice(st, j + 1);
      if (!must || s.includes(must)) { try { return JSON.parse(s); } catch (e) { /* sigue buscando */ } }
      from = j;
    }
  }

  // ROW = [clasificación, puesto, idCorredor, nombre, idEquipo, equipo, puntos, días, tiempo, perfil]
  const toRow = x => [x.c, x.p, x.r == null ? null : x.r, x.x == null ? null : x.x, x.t, x.m, +x.s || 0, +x.days || 0, typeof x.time === 'string' ? x.time : '', x.profile && x.profile !== '-' ? x.profile : ''];

  // opts: { base, season, get(path) → texto, getJSON(path) → objeto, meta: {idPrueba: [fecha, tipo, bandera, país]}, log }
  async function fetchSeason(opts) {
    const base = opts.base || BASE, log = opts.log || (() => {});
    const q = opts.season ? '?temporada=' + opts.season : '';
    const t = unescape(await opts.get('/resultados' + q));
    const events = jsonAfter(t, 'events', '"classifications"');
    const groups = jsonAfter(t, 'groups', '"file"') || [];
    const overlay = jsonAfter(t, 'overlay', '"event_id"') || [];
    if (!events || !events.length) throw new Error('la página de resultados no trae pruebas');
    const sourceDate = (t.match(/"sourceDate":"([^"]+)"/) || [])[1] || null;
    const byE = new Map();
    const fresh = new Set(overlay.map(o => o.event_id));
    for (const g of groups) {
      const j = await opts.getJSON(g.file);
      for (const x of j.rows || []) if (!fresh.has(x.e)) { if (!byE.has(x.e)) byE.set(x.e, []); byE.get(x.e).push(x); }
    }
    for (const o of overlay) byE.set(o.event_id, (o.rows || []).slice());
    const out = [];
    for (const e of events) {
      const rows = (byE.get(e.eventId) || []).sort((a, b) => a.i - b.i);
      if (!rows.length) continue;
      const k = rows.find(x => x.category != null && x.category !== '') || rows[0];
      out.push({ e: e.eventId, n: e.event, type: String(k.type ?? ''), category: k.category == null ? '' : String(k.category), rows: rows.map(toRow) });
    }
    // clasificaciones generales publicadas (para comprobar que los totales cuadran)
    let rank = null;
    try {
      const rr = jsonAfter(unescape(await opts.get('/clasificaciones/ciclistas' + q)), 'rows', '"cyclistId"');
      const tt = jsonAfter(unescape(await opts.get('/clasificaciones' + q)), 'rows', '"teamId"');
      if (rr && tt) rank = { riders: rr.map(x => [x.cyclistId, x.cyclist, x.points, x.daysCompetition]), teams: tt.map(x => [x.teamId, x.team, x.points]) };
    } catch (e) { log('No se pudieron leer las clasificaciones generales: ' + e.message); }
    // fecha, categoría y país de cada prueba: salen en la ficha de los corredores que la corrieron
    const meta = Object.assign({}, opts.meta || {});
    const need = new Set(out.map(x => x.e).filter(e => !meta[e]));
    let pages = 0;
    while (need.size && pages < (opts.maxPages || 400)) {
      const cnt = new Map();
      for (const ev of out) if (need.has(ev.e)) for (const r of new Set(ev.rows.map(x => x[2]).filter(x => x != null))) cnt.set(r, (cnt.get(r) || 0) + 1);
      let best = null, bn = 0; for (const [r, n] of cnt) if (n > bn) { bn = n; best = r; }
      if (best == null) break;
      pages++;
      let got = 0;
      try {
        const p = jsonAfter(unescape(await opts.get('/ciclistas/' + best + q)), 'preview', '"eventId"');
        for (const x of (p && p.rows) || []) {
          if (meta[x.eventId] || !x.date) continue;
          const fl = (String(x.flagSrc || '').match(/\/([a-z-]+)\.svg/i) || [])[1] || '';
          meta[x.eventId] = [x.date, x.raceType || '', fl, x.country || ''];
          need.delete(x.eventId); got++;
        }
      } catch (e) { log('Ficha ' + best + ': ' + e.message); }
      if (!got) for (const ev of out) if (ev.rows.some(x => x[2] === best)) need.delete(ev.e); // no insistir con la misma prueba
    }
    if (pages) log(`Fechas de las pruebas: ${pages} fichas de corredor leídas, ${need.size} pruebas sin fecha.`);
    return { season: opts.season, src: base, sourceDate, events: out, rank, meta };
  }

  G.MCOfficial = { BASE, fetchSeason, jsonAfter, unescape };
})(typeof window !== 'undefined' ? window : globalThis);
