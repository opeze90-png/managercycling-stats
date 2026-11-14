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
  // días: si la fila no los trae (formato desde 10/2026), 1 por cada clásica o etapa disputada (también abandonos),
  // 0 en las filas de líder y en las clasificaciones finales; es exactamente como los cuenta la oficial
  const daysOf = x => x.days != null ? +x.days || 0 : (/^(Clásica|Etapa\s*\d+)/.test(x.c) && !/^l[ií]der$/i.test(String(x.p)) ? 1 : 0);
  const toRow = x => [x.c, x.p, x.r == null ? null : x.r, x.x == null ? null : x.x, x.t, x.m, +x.s || 0, daysOf(x), typeof x.time === 'string' ? x.time : '', x.profile && x.profile !== '-' ? x.profile : ''];
  // huella de una prueba en la lista de la web: si no cambia, sus filas tampoco
  const sigOf = e => JSON.stringify([e.count, (e.classifications || []).map(c => [c.name, c.count, c.statuses, c.minPosition, c.maxPosition])]);

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
    const out = [];
    if (groups.length || overlay.length) {
      // formato antiguo: archivos por grupos de pruebas + las últimas dentro de la página
      const fresh = new Set(overlay.map(o => o.event_id));
      for (const g of groups) {
        const j = await opts.getJSON(g.file);
        for (const x of j.rows || []) if (!fresh.has(x.e)) { if (!byE.has(x.e)) byE.set(x.e, []); byE.get(x.e).push(x); }
      }
      for (const o of overlay) byE.set(o.event_id, (o.rows || []).slice());
      for (const e of events) {
        const rows = (byE.get(e.eventId) || []).sort((a, b) => a.i - b.i);
        if (!rows.length) continue;
        const k = rows.find(x => x.category != null && x.category !== '') || rows[0];
        out.push({ e: e.eventId, n: e.event, sig: sigOf(e), type: String(k.type ?? ''), category: k.category == null ? '' : String(k.category), rows: rows.map(toRow) });
      }
    } else {
      // formato actual: cada prueba en su página (/resultados?prueba=N). Solo se descargan las nuevas o cambiadas,
      // las últimas (pueden estar en curso) y unas cuantas más por turno para repasarlas todas cada poco
      const prev = opts.prev || new Map();
      const ids = events.map(e => e.eventId);
      const recent = new Set(ids.slice(-(opts.recent || 12)));
      const rot = opts.rotate || 25, start = Math.floor(Date.now() / 600000) * rot % Math.max(1, ids.length);
      const sweep = new Set(Array.from({ length: Math.min(rot, ids.length) }, (_, i) => ids[(start + i) % ids.length]));
      let fetched = 0;
      for (const e of events) {
        const p = prev.get(e.eventId), sig = sigOf(e);
        let rows = null;
        if (!p || p.sig !== sig || recent.has(e.eventId) || sweep.has(e.eventId) || !p.rows.length) {
          try {
            const page = unescape(await opts.get(`/resultados?${opts.season ? `temporada=${opts.season}&` : ''}prueba=${e.eventId}`));
            const raw = jsonAfter(page, 'rows', `"e":${e.eventId},`);
            if (raw && raw.length) {
              rows = raw.filter(x => x.e === e.eventId).sort((a, b) => a.i - b.i).map(toRow); fetched++;
              // la web ya no da los días por fila: se conservan los ya guardados; los mundiales/JJOO (selecciones) no suman días
              const nat = /world championships|olympic|mundial/i.test(e.event);
              const kd = new Map(p ? p.rows.map(x => [x[0] + '|' + x[2] + '|' + x[1], x[7]]) : []);
              for (const x of rows) { const k = x[0] + '|' + x[2] + '|' + x[1]; x[7] = kd.has(k) ? kd.get(k) : nat ? 0 : x[7]; }
            }
          } catch (err) { log(`Prueba ${e.eventId}: ${err.message}`); }
        }
        if (!rows && p) rows = p.rows; // sin cambios o fallo puntual: se mantiene lo guardado
        if (!rows || !rows.length) continue;
        out.push({ e: e.eventId, n: e.event, sig, type: p ? p.type || '' : '', category: p ? p.category || '' : '', rows });
      }
      log(`${fetched} pruebas leídas de la web oficial (de ${events.length}).`);
    }
    // clasificaciones generales publicadas (para comprobar que los totales cuadran)
    let rank = null;
    try {
      const rr = jsonAfter(unescape(await opts.get('/clasificaciones/ciclistas' + q)), 'rows', '"cyclistId"');
      const tt = jsonAfter(unescape(await opts.get('/clasificaciones' + q)), 'rows', '"teamId"');
      if (rr && tt) rank = { riders: rr.map(x => [x.cyclistId, x.cyclist, x.points, x.daysCompetition]), teams: tt.map(x => [x.teamId, x.team, x.points, x.division || '']) };
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


  // Mercado (traspasos confirmados y retirados) de la próxima temporada: tablas HTML de /mercado
  const txt = h => String(h || '').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
  const isoDate = d => { const m = String(d).match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };
  async function fetchMarket(opts) {
    const page = await opts.get('/mercado?vista=traspasos');
    const year = +((page.match(/Mercado\s*(?:<!-- -->)?\s*(\d{4})/) || [])[1]) || null;
    const transfers = [];
    let k = 0;
    for (const blk of page.split('<tbody class="market-agreement"').slice(1)) {
      const body = blk.split('</tbody>')[0];
      const date = isoDate((body.match(/<span>(\d{2}\/\d{2}\/\d{4})<\/span>/) || [])[1]);
      k++;
      for (const tr of body.split('<tr').slice(1)) {
        const cells = tr.split('<td').slice(1);
        if (cells.length < 3) continue;
        const id = (cells[0].match(/\/ciclistas\/(\d+)/) || [])[1];
        if (!id) continue; // picks del draft
        transfers.push([date, +id, txt('<td' + cells[0]), txt('<td' + cells[1]), txt('<td' + cells[2]), k]);
      }
    }
    const retired = [];
    try {
      const rp = await opts.get('/mercado?vista=retirados');
      const body = (rp.split('<tbody>')[1] || '').split('</tbody>')[0];
      for (const tr of body.split('<tr').slice(1)) {
        const cells = tr.split('<td').slice(1);
        const id = (tr.match(/\/ciclistas\/(\d+)/) || [])[1];
        if (!id || cells.length < 4) continue;
        retired.push([isoDate(txt('<td' + cells[0])), +id, txt('<td' + cells[1]), txt('<td' + cells[2]), txt('<td' + cells[3])]);
      }
    } catch (e) { (opts.log || (() => {}))('Retirados: ' + e.message); }
    return { year, transfers, retired };
  }

  // Plantillas con medias (atributos) de una temporada: /plantillas?temporada=AAAA, 60 corredores por página
  // fila = [idCorredor, nombre, equipo, edad, días, puntos, rankPCS, LLA..REC (14), MED, salario]
  const ROSTER_ATTR = ['LLA', 'MON', 'MM', 'COL', 'CRI', 'PRL', 'PAV', 'SPR', 'ACE', 'DES', 'COM', 'ENE', 'RES', 'REC', 'MED'];
  const numES = v => { v = String(v || '').replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''); return v === '' || v === '-' ? null : +v; };
  function parseRoster(html, season) {
    const out = [];
    const tb = (html.split('<tbody')[1] || '').split('</tbody>')[0];
    for (const tr of tb.split('<tr').slice(1)) {
      const id = (tr.match(/\/ciclistas\/(\d+)/) || [])[1];
      if (!id) continue;
      const th = (tr.match(/<th[^>]*>([\s\S]*?)<\/th>/) || [])[1] || '';
      const cell = {};
      for (const m of tr.matchAll(/<td[^>]*data-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)) {
        const team = m[2].match(/class="roster-mobile-team">([^<]*)</);
        cell[m[1]] = team ? txt(team[1]) : txt(m[2]);
      }
      out.push([+id, txt(th), cell['Equipo'] || '', numES(cell['Edad']), numES(cell['Días']), numES(cell['Pts. MC']), numES(cell['Rank. PCS']), ...ROSTER_ATTR.map(k => numES(cell[k])), numES(cell['Salario ' + season])]);
    }
    return out;
  }
  async function fetchRosters(opts) {
    const all = [];
    for (let p = 1; p <= 80; p++) {
      const rows = parseRoster(await opts.get(`/plantillas?temporada=${opts.season}&pagina=${p}&ordenar=ciclista&sentido=asc`), opts.season);
      all.push(...rows);
      if (rows.length < 60) break;
    }
    return all;
  }

  G.MCOfficial = { BASE, fetchSeason, fetchMarket, fetchRosters, parseRoster, jsonAfter, unescape };
})(typeof window !== 'undefined' ? window : globalThis);
