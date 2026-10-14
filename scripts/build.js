// Compact dataset builder. Shared by the node updater and the live in-browser updater.
// Data shape (v2):
//  teams:  [name]
//  riders: [[name, ...seasons in which the forum marks the rider (J)]]
//  races:  [{id, s, name, start, end, c, cls, multi, rp, st:[{n,l,ty,ro,rows}], cl:{GC,PTS,KOM,YOU,TEAM,TOT}, ld:{stage: riderId}}]
//          row = [pos, riderId|-1, teamId|-1, value, pts|null]
//  ins:    [{id, s, name, start, end, c, cls, closed, rp, min, max, e:[{m, t, d, r:[riderId]}]}]
(function (G) {
  const MC = G.MC;
  const SEC_ORDER = ['GC', 'PTS', 'KOM', 'YOU', 'TEAM', 'TOT', 'LDR'];

  // edit distance counting a swap of two neighbouring letters as one edit ("Cavgana" / "Cavagna")
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
    return d[a.length][b.length];
  }

  // Limpia restos pegados al nombre del corredor: "1.Remco Evenepoel", "GBR Simon Yates",
  // "Remco Evenepoel CN", "Mauri Vansevenant Team Novo Nordisk 1[/b]".
  const NOC = new Set('ALB AND ARG ARM AUS AUT AZE BEL BLR BRA BUL CAN CHI CHL CHN COL CRC CRO CUB CYP CZE DEN ECU EGY ERI ESP EST ETH FIN FRA GBR GEO GER GRE GUA HKG HOL HUN IRL IRI ISR ITA JPN KAZ KOR LAT LTU LUX MAR MDA MEX MGL MKD MNE NED NOR NZL PAN PAR PER POL POR PUR ROU RSA RUS RWA SLO SMR SRB SUI SVK SWE SWI THA TUN TUR UAE UKR URU USA UZB VEN'.split(' '));
  const JUNK = /invitad|invitaci|reserva|borrar|recuperando|national champion|km a meta|pelot[oó]n|^dnf$|^dns$|^otl$|^equipos?\b/i;
  function cleanName(name) {
    let s = MC.norm(String(name).replace(/\[\/?[a-z]+\]/gi, ' '));
    s = s.replace(/^\d+\s*[.)º-]\s*/, '');
    const m = s.match(/^([A-Z]{3})\s+(.+)$/);
    if (m && NOC.has(m[1]) && m[2].split(' ').length >= 2) s = m[2];
    s = s.replace(/\s+[-(\[]?J[)\]]?$/, ' (J)').replace(/\s+(CN|CC|CM|CE|EEUU|\(CN\)|\(CM\))$/, '').replace(/\s+\d+([.,]\d+)?$/, '');
    return MC.norm(s);
  }
  const isJunk = name => !name || JUNK.test(name) || !/[a-zà-ž]/i.test(name) || name.length > 40;
  // "MCNULTY Brandon" → "Brandon Mcnulty" cuando no hay otra forma del nombre
  const cap = w => w.split(/([-'’ ])/).map(x => x.length > 1 ? x[0] + x.slice(1).toLowerCase() : x).join('').replace(/^Mc([a-z])/, (a, b) => 'Mc' + b.toUpperCase());
  function fixCaps(n) {
    const t = n.split(' ');
    const up = t.filter(w => w.length > 1 && /^[A-ZÀ-Þ'’-]+$/.test(w) && /[A-Z]/.test(w));
    if (!up.length || up.length === t.length) return n;
    const low = t.filter(w => !up.includes(w));
    return [...low, ...up.map(cap)].join(' ');
  }
  const capsPenalty = n => /\b[A-ZÀ-Þ]{3,}\b/.test(n) ? 0.3 : 1;

  function Compactor(seed) {
    const data = seed ? JSON.parse(JSON.stringify(seed)) : { v: 2, seasons: [], teams: [], riders: [], races: [], ins: [] };
    data.v = 2;
    const teamId = new Map(), riderId = new Map(), tokId = new Map(), votes = [];
    data.teams.forEach((t, i) => teamId.set(MC.teamKey(t), i));
    data.riders.forEach((r, i) => { riderId.set(MC.riderKey(r[0]), i); tokId.set(MC.tokenKey(r[0]), i); votes.push({ [r[0]]: 0.5 }); });

    const tid = name => {
      if (!name) return -1;
      const k = MC.teamKey(name);
      if (!k) return -1;
      if (!teamId.has(k)) {
        let alias = null;
        for (const [k2, id] of teamId) if (Math.min(k.length, k2.length) >= 8 && (k.startsWith(k2) || k2.startsWith(k))) { alias = id; break; }
        if (alias != null) { teamId.set(k, alias); if (name.length > data.teams[alias].length) data.teams[alias] = name; }
        else { teamId.set(k, data.teams.length); data.teams.push(name); }
      }
      return teamId.get(k);
    };
    // "Mauri Vansevenant Team Novo Nordisk" → "Mauri Vansevenant"
    const stripTeam = name => {
      const w = name.split(' ');
      for (let i = 2; i < w.length; i++) { const k = MC.teamKey(w.slice(i).join(' ')); if (k.length >= 4 && teamId.has(k)) return w.slice(0, i).join(' '); }
      return name;
    };
    let curSeason = null;
    const markYoung = id => { if (curSeason && !data.riders[id].includes(curSeason, 1)) data.riders[id].push(curSeason); };
    const touch = (id, name) => {
      const clean = MC.norm(name.replace(/\(J\)/gi, ''));
      votes[id][clean] = (votes[id][clean] || 0) + 1;
      if (/\(J\)/i.test(name)) markYoung(id);
    };
    const rid = (name, create = true) => {
      if (!name) return -1;
      name = stripTeam(cleanName(name));
      if (isJunk(name)) return -1;
      const k = MC.riderKey(name);
      if (!k) return -1;
      let id = riderId.get(k);
      if (id == null) {
        const tk = MC.tokenKey(name);
        id = tokId.get(tk);
        if (id == null) {
          if (!create) return -1;
          id = data.riders.length; data.riders.push([MC.norm(name.replace(/\(J\)/gi, ''))]); votes.push({});
          tokId.set(tk, id);
        }
        riderId.set(k, id);
      }
      touch(id, name);
      return id;
    };
    const fuzzy = name => {
      const tk = MC.tokenKey(name); if (tk.length < 6) return -1;
      let best = -1, bd = 3;
      for (const [k, id] of tokId) { if (Math.abs(k.length - tk.length) > 2) continue; const dd = lev(tk, k); if (dd < bd) { bd = dd; best = id; } }
      return bd <= (tk.length > 12 ? 2 : 1) ? best : -1;
    };
    const rowOut = r => [r.p, rid(r.r), tid(r.t), r.v || '', r.pts == null ? null : r.pts];

    function seasonOf(x) { return x.start ? +x.start.slice(0, 4) : null; }
    function upsert(list, obj) {
      const i = list.findIndex(o => o.id === obj.id);
      if (i >= 0) list[i] = obj; else list.push(obj);
    }

      // Some results posts stop listing points half way ("Spoiler:36 Connor Swift  Team" without points)
    // while the official ranking still gives them. Fill those gaps with the usual points for that
    // position in one-day races of the same class and season.
  function fillScales() {
      const scale = new Map();
      const key = r => r.s + '|' + r.cls;
      fixTTT(key);
      // Clásica publicada con la escala multiplicada (p. ej. todo ×2 por error): la oficial aplica la escala
      // de la inscripción. Sólo si TODAS las posiciones con escala salen con el mismo factor.
      for (const r of data.races) {
        if (r.multi || !r.st[0]) continue;
        const i = data.ins.find(i => i.s === r.s && i.start === r.start && i.sc && (i.cls || '') === (r.cls || '') && MC.riderKey(i.name).split(' ')[0] === MC.riderKey(r.name).split(' ')[0]);
        if (!i) continue;
        const exp = p => i.sc[p - 1] ?? (i.scr && p >= i.scr[0] ? i.scr[1] : null);
        const rows = r.st[0].rows.filter(x => x[4] != null && x[0] > 0 && exp(x[0]));
        if (rows.length < 8) continue;
        const k = rows[0][4] / exp(rows[0][0]);
        if (k < 1.01 || !rows.every(x => Math.abs(x[4] - k * exp(x[0])) < 0.01)) continue;
        for (const x of r.st[0].rows) { const e = exp(x[0]); if (x[4] != null && e != null) x[4] = e; }
        r.scx = k;
      }
      for (const r of data.races) {
        if (r.multi || !r.st[0] || !r.cls) continue;
        const rows = r.st[0].rows;
        if (rows.filter(x => x[4] != null).length < rows.length * 0.9) continue;
        if (!scale.has(key(r))) scale.set(key(r), new Map());
        const m = scale.get(key(r));
        for (const x of rows) if (x[4] != null && x[0] > 0) { const c = m.get(x[0]) || new Map(); c.set(x[4], (c.get(x[4]) || 0) + 1); m.set(x[0], c); }
      }
      // Leader points: some summaries forget the "Líder" lines although the forum totals include them.
      const today = new Date().toISOString().slice(0, 10);
      const ldVal = new Map();
      for (const r of data.races) for (const x of (r.cl.LDR || [])) { if (x[4] == null || r.ldx) continue; const c = ldVal.get(key(r)) || new Map(); c.set(x[4], (c.get(x[4]) || 0) + 1); ldVal.set(key(r), c); }
      for (const r of data.races) {
        if (!r.multi || (r.cl.LDR && r.cl.LDR.length && !r.ldx) || !r.ld || !ldVal.has(key(r)) || (r.end && r.end >= today)) continue;
        let best = null, bn = 0; for (const [v, n] of ldVal.get(key(r))) if (n > bn) { bn = n; best = v; }
        if (best == null || bn < 3) continue;
        const last = Math.max(...r.st.map(s => s.n));
        const rows = Object.entries(r.ld).filter(([n, rid]) => +n < last && rid >= 0).map(([n, rid]) => {
          const t = (r.cl.GC || []).find(w => w[1] === rid) || r.st.flatMap(s => s.rows).find(w => w[1] === rid);
          return [+n, rid, t ? t[2] : -1, '', best];
        });
        if (rows.length) { r.cl.LDR = rows; r.ldx = 1; }
      }
      // Team / young riders' classification points missing from the summary: take the final order from
      // the "(n)" of the last stage's classification and the usual points of that class and season.
      for (const k of ['TEAM', 'YOU']) {
        const sc = new Map();
        for (const r of data.races) if (r.multi && r.cl[k]) for (const x of r.cl[k]) if (x[4] != null && !r['fx' + k]) { const c = sc.get(key(r)) || new Map(); const m = c.get(x[0]) || new Map(); m.set(x[4], (m.get(x[4]) || 0) + 1); c.set(x[0], m); sc.set(key(r), c); }
        for (const r of data.races) {
          const rows = r.cl[k];
          if (!r.multi || !rows || !rows.length || rows.some(x => x[4] != null) || !sc.has(key(r)) || (r.end && r.end >= today)) continue;
          const withPos = rows.map(x => { const m = String(x[3]).match(/\((\d+)\)\s*$/); return m ? [+m[1], x] : null; });
          if (withPos.some(x => !x)) continue;
          const c = sc.get(key(r));
          withPos.sort((a, b) => a[0] - b[0]).forEach(([pos, x]) => {
            const m = c.get(pos); if (!m) return; let best = null, bn = 0; for (const [v, n] of m) if (n > bn) { bn = n; best = v; }
            x[0] = pos; if (bn >= 3) x[4] = best;
          });
          rows.sort((a, b) => a[0] - b[0]); r['fx' + k] = 1;
        }
      }
      // Clásicas sin clasificación de jóvenes publicada (p. ej. cronos por equipos): la oficial la saca del
      // orden de llegada de los corredores (J) con la escala habitual de jóvenes de esa categoría.
      {
        const ysc = new Map();
        for (const r of data.races) if (!r.multi && r.cl.YOU) for (const x of r.cl.YOU) if (x[4] != null && x[0] > 0) { const c = ysc.get(key(r)) || new Map(); const m = c.get(x[0]) || new Map(); m.set(x[4], (m.get(x[4]) || 0) + 1); c.set(x[0], m); ysc.set(key(r), c); }
        for (const r of data.races) {
          if (+r.s < 2025 || r.multi || !r.st[0] || (r.cl.YOU && r.cl.YOU.length) || !ysc.has(key(r)) || /U$/.test(r.cls || '')) continue;
          const c = ysc.get(key(r)), out = [];
          for (const x of r.st[0].rows) {
            if (x[1] < 0 || !data.riders[x[1]] || !data.riders[x[1]].slice(1).some(s => +s === +r.s)) continue;
            const pos = out.length + 1, m = c.get(pos); if (!m) break;
            let best = null, bn = 0; for (const [v, n] of m) if (n > bn) { bn = n; best = v; }
            if (best == null || bn < 3) break;
            out.push([pos, x[1], x[2], '', best]);
          }
          if (out.length) { r.cl.YOU = out; r.youx = 1; }
        }
      }
      let filled = 0;
      // the inscription topic of the same race publishes its points scale: use it first
      const insOf = r => data.ins.find(i => i.s === r.s && i.start === r.start && i.sc && MC.riderKey(i.name).split(' ')[0] === MC.riderKey(r.name).split(' ')[0]);
      for (const r of data.races) {
        if (r.multi || !r.st[0]) continue;
        const rows = r.st[0].rows, withP = rows.filter(x => x[4] != null);
        if (!withP.length || withP.length === rows.length) continue;
        const i = insOf(r); if (!i) continue;
        const lastP = Math.max(...withP.map(x => x[0]));
        for (const x of rows) {
          if (x[4] != null || !(x[0] > lastP) || x[1] < 0) continue;
          const v = i.sc[x[0] - 1] ?? (i.scr && x[0] >= i.scr[0] ? i.scr[1] : null);
          if (v != null) { x[4] = v; filled++; }
        }
      }
      for (const r of data.races) {
        if (r.multi || !r.st[0] || !scale.has(key(r))) continue;
        const rows = r.st[0].rows, m = scale.get(key(r));
        const withP = rows.filter(x => x[4] != null).length;
        if (!withP || withP === rows.length) continue;
        const lastP = Math.max(...rows.filter(x => x[4] != null).map(x => x[0]));
        // what each team is still missing compared with the totals published for the race
        const deficit = new Map();
        if (r.cl.TOT) {
          const got = new Map(); const add = (t, v) => { if (t >= 0 && v) got.set(t, (got.get(t) || 0) + v); };
          rows.forEach(x => add(x[2], x[4])); for (const k of ['GC', 'PTS', 'KOM', 'YOU', 'LDR', 'TEAM']) (r.cl[k] || []).forEach(x => add(x[2], x[4]));
          r.cl.TOT.forEach(x => { if (x[2] >= 0 && x[4]) deficit.set(x[2], x[4] - (got.get(x[2]) || 0)); });
        }
        for (const x of rows) {
          if (x[4] != null || !(x[0] > 0) || x[1] < 0) continue;
            // inside the list only fill a single missing line between two that have points
          const inside = x[0] <= lastP;
          if (inside && !(rows.some(o => o[0] === x[0] - 1 && o[4] != null) && rows.some(o => o[0] === x[0] + 1 && o[4] != null))) continue;
          const c = m.get(x[0]); if (!c) continue;
          let best = null, bn = 0; for (const [v, n] of c) if (n > bn) { bn = n; best = v; }
          if (best == null || bn < 2) continue;
          // a line missing inside the list is only filled when the team totals confirm it
          if (inside && !(deficit.get(x[2]) >= best - 0.5)) continue;
          x[4] = best; filled++; if (deficit.has(x[2])) deficit.set(x[2], deficit.get(x[2]) - best);
        }
      }
      return filled;
    }

    // Equipo que cambia de nombre a mitad de temporada ("GW Erco Shimano" → "GW Erco SportFitness"): el mismo
    // mánager inscribe con los dos nombres y nunca coinciden en una carrera → es un solo equipo esa temporada.
    function mergeTeamRenames() {
      const bySeason = new Map();
      for (const i of data.ins) for (const e of i.e || []) {
        if (!e.m || !e.t) continue; const t = teamId.get(MC.teamKey(e.t)); if (t == null) continue;
        const k = i.s + '|' + e.m.toLowerCase(); const m = bySeason.get(k) || new Map(); const o = m.get(t) || { n: 0, last: '' };
        o.n++; if ((i.start || '') > o.last) o.last = i.start || ''; m.set(t, o); bySeason.set(k, m);
      }
      // también por nombre: mismas dos primeras palabras significativas ("GW Erco …") y nunca juntos en una carrera
      const sig = n => MC.norm(n).toLowerCase().split(/[\s\-|/]+/).filter(w => w && !/^(team|cycling|pro|procycling|the|de|-)$/.test(w)).slice(0, 2).join(' ');
      for (const s of new Set(data.races.map(r => r.s))) {
        const used = new Map();
        for (const r of data.races) if (r.s === s) for (const x of r.st) for (const w of x.rows) if (w[2] >= 0) { const o = used.get(w[2]) || { last: '' }; if ((r.start || '') > o.last) o.last = r.start || ''; used.set(w[2], o); }
        const groups = new Map();
        for (const t of used.keys()) { const g = sig(data.teams[t] || ''); if (g.split(' ').length < 2 || g.length < 5) continue; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); }
        for (const ids of groups.values()) if (ids.length > 1) { const m = new Map(ids.map(t => [t, { n: 1, last: used.get(t).last }])); bySeason.set(s + '|~' + ids.join(','), m); }
      }
      for (const [k, m] of bySeason) {
        if (m.size < 2) continue;
        const s = +k.split('|')[0];
        const ids = [...m.keys()];
        const together = data.races.some(r => r.s === s && (() => { const ts = new Set(r.st.flatMap(x => x.rows.map(w => w[2]))); return ids.filter(t => ts.has(t)).length > 1; })());
        if (together) continue;
        const keep = ids.sort((a, b) => m.get(b).last.localeCompare(m.get(a).last))[0];
        const map = new Set(ids.filter(t => t !== keep));
        if (typeof process !== 'undefined' && process.env && process.env.MC_LOG_TEAMS) console.error('team merge', s, ids.map(t => data.teams[t]).join(' | '), '→', data.teams[keep]);
        const fix = w => { if (map.has(w[2])) w[2] = keep; };
        for (const r of data.races) if (r.s === s) { r.st.forEach(x => x.rows.forEach(fix)); for (const c in r.cl) r.cl[c].forEach(fix); }
        for (const i of data.ins) if (i.s === s) for (const e of i.e || []) if (map.has(teamId.get(MC.teamKey(e.t)))) e.t = data.teams[keep];
      }
    }

    // Crono por equipos: la clasificación oficial reparte los puntos del puesto del equipo (escala de la
    // carrera o de las etapas de esa categoría) a partes iguales entre sus corredores, sin redondear y sin
    // sumar la clasificación por equipos. El foro a veces publica el reparto redondeado o con los totales.
    function fixTTT(key) {
      const isTTT = rows => {
        if (rows.length < 6) return false;
        const shared = rows.filter((x, i) => i > 0 && x[0] === rows[i - 1][0] && x[2] === rows[i - 1][2] && x[2] >= 0).length;
        return shared > rows.length / 2;
      };
      const mode = m => { let best = null, bn = 0; for (const [v, n] of m) if (n > bn) { bn = n; best = v; } return [best, bn]; };
      // escala de etapas por categoría y temporada
      const stScale = new Map();
      for (const r of data.races) {
        if (!r.multi || !r.cls) continue;
        for (const s of r.st) {
          if (isTTT(s.rows) || s.rows.filter(x => x[4] != null).length < 10) continue;
          const c = stScale.get(key(r)) || new Map();
          for (const x of s.rows) if (x[4] != null && x[0] > 0 && x[0] <= 30) { const m = c.get(x[0]) || new Map(); m.set(x[4], (m.get(x[4]) || 0) + 1); c.set(x[0], m); }
          stScale.set(key(r), c);
        }
      }
      const insOf = r => data.ins.find(i => i.s === r.s && i.start === r.start && i.sc && MC.riderKey(i.name).split(' ')[0] === MC.riderKey(r.name).split(' ')[0] && (i.cls || '') === (r.cls || ''));
      let n = 0;
      for (const r of data.races) {
        if (+r.s < 2025) continue; // hasta 2024 la clasificación oficial usaba el reparto publicado
        for (const s of r.st) {
          if (!isTTT(s.rows)) continue;
          let S = null;
          if (!r.multi) { const i = insOf(r); if (i) S = p => i.sc[p - 1] ?? null; }
          else if (stScale.has(key(r))) { const c = stScale.get(key(r)); S = p => { const m = c.get(p); if (!m) return null; const [v, k] = mode(m); return k >= 3 ? v : null; }; }
          if (!S) continue;
          const groups = new Map();
          for (const x of s.rows) { if (x[1] < 0 || x[2] < 0) continue; const g = x[0] + ':' + x[2]; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
          for (const xs of groups.values()) {
            const v = S(xs[0][0]); if (v == null) continue;
            const each = v / xs.length, posted = xs[0][4];
            // sólo si lo publicado es ese reparto (redondeado) o el total del equipo con alguna clasificación extra
            if (posted != null && Math.abs(posted - each) > 0.01 && !(Math.abs(posted * xs.length - v) <= xs.length) && !(posted * xs.length > v && posted * xs.length - v <= v * 0.35)) continue;
            for (const x of xs) { if (x[4] !== each) { x[4] = Math.round(each * 1e6) / 1e6; n++; } }
          }
        }
      }
      return n;
    }

    // Same rider written two ways in results ("Natnael Tesfatsion" / "Natnael Tesfazion"): names one or two
    // letters apart, riding for the same team in the same season and never in the same race → one rider.
    function mergeDuplicates() {
      const N = data.riders.length;
      const races = Array.from({ length: N }, () => new Set()), teams = Array.from({ length: N }, () => new Set()), refs = new Array(N).fill(0);
      const each = fn => { for (const r of data.races) { r.st.forEach((s, si) => { for (const x of s.rows) fn(x, r, 's' + si); }); for (const k in r.cl) for (const x of r.cl[k]) fn(x, r, k); } };
      each((x, r, l) => { const i = x[1]; if (i >= 0 && i < N) { races[i].add(r.id + l); refs[i]++; if (x[2] >= 0) teams[i].add(r.s + ':' + x[2]); } });
      const keys = data.riders.map(r => MC.fold(r[0].replace(/\(J\)/gi, '')).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim());
      const parent = Array.from({ length: N }, (_, i) => i);
      const find = i => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
      const ids = keys.map((k, i) => i).filter(i => keys[i].length > 6 && refs[i] > 0);
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a], j = ids[b];
        if (Math.abs(keys[i].length - keys[j].length) > 2 || keys[i][0] !== keys[j][0] && keys[i].split(' ').pop()[0] !== keys[j].split(' ').pop()[0]) continue;
        if (lev(keys[i], keys[j]) > 2) continue;
        if (![...teams[i]].some(t => teams[j].has(t))) continue;
        if ([...races[i]].some(r => races[j].has(r))) continue;
        const ri = find(i), rj = find(j); if (ri === rj) continue;
        if (G.MC_LOG_MERGE) console.log("merge", data.riders[i][0], "=", data.riders[j][0]);
        if (refs[ri] >= refs[rj]) parent[rj] = ri; else parent[ri] = rj;
      }
      // riders only seen in inscriptions, misspelled: attach them to the one rider with results that is close enough
      const withRes = keys.map((k, i) => i).filter(i => refs[i] > 0 && keys[i].length > 6);
      for (let i = 0; i < N; i++) {
        if (refs[i] > 0 || keys[i].length <= 6) continue;
        const lim = keys[i].length > 12 ? 2 : 1;
        const c = withRes.filter(j => Math.abs(keys[i].length - keys[j].length) <= lim && lev(keys[i], keys[j]) <= lim);
        if (c.length === 1) parent[i] = find(c[0]);
      }
      if (parent.every((p, i) => p === i)) return;
      for (let i = 0; i < N; i++) { const m = find(i); if (m !== i) { for (const y of data.riders[i].slice(1)) if (!data.riders[m].includes(y, 1)) data.riders[m].push(y); for (const [n, c] of Object.entries(votes[i] || {})) votes[m][n] = (votes[m][n] || 0) + c; } }
      each(x => { if (x[1] >= 0) x[1] = find(x[1]); });
      for (const r of data.races) if (r.ld) for (const k in r.ld) if (r.ld[k] >= 0) r.ld[k] = find(r.ld[k]);
      for (const i of data.ins) for (const e of i.e) e.r = [...new Set(e.r.map(find))];
      // drop riders nobody refers to any more and renumber
      const used = new Set(); each(x => { if (x[1] >= 0) used.add(x[1]); });
      for (const r of data.races) if (r.ld) Object.values(r.ld).forEach(v => v >= 0 && used.add(v));
      for (const i of data.ins) for (const e of i.e) e.r.forEach(v => used.add(v));
      const map = new Map(); const riders = [], nv = [];
      data.riders.forEach((r, i) => { if (used.has(i)) { map.set(i, riders.length); riders.push(r); nv.push(votes[i]); } });
      const re = v => (v >= 0 ? map.get(v) ?? -1 : v);
      each(x => { x[1] = re(x[1]); });
      for (const r of data.races) if (r.ld) for (const k in r.ld) r.ld[k] = re(r.ld[k]);
      for (const i of data.ins) for (const e of i.e) e.r = e.r.map(re).filter(v => v >= 0);
      data.riders = riders; votes.length = 0; votes.push(...nv);
      riderId.clear(); tokId.clear();
      data.riders.forEach((r, i) => { riderId.set(MC.riderKey(r[0]), i); tokId.set(MC.tokenKey(r[0]), i); });
    }

    return {
      data,
      addRace(r, replies) {
        curSeason = seasonOf(r);
        const o = { id: r.id, s: seasonOf(r), name: r.name, start: r.start, end: r.end, c: r.country, cls: r.cls, note: r.note || undefined, im: r.im || undefined, multi: r.multi ? 1 : 0, rp: replies, st: [], cl: {} };
        for (const s of r.stages) o.st.push({ n: s.n, l: s.label, ty: s.type || undefined, ro: s.route || undefined, im: s.im || undefined, rows: s.rows.map(rowOut) });
        // team totals often use short names ("Trek", "Ineos"): match them to the teams of this race
        const local = new Map(); for (const s of r.stages) for (const x of s.rows) if (x.t) local.set(MC.teamKey(x.t), x.t);
        for (const k of ['GC', 'TEAM', 'YOU']) for (const x of (r.cls_[k] || [])) if (x.t) local.set(MC.teamKey(x.t), x.t);
        const localTeam = n => {
          const k = MC.teamKey(n || '').replace('bahrein', 'bahrain'); if (!k || local.has(k)) return local.get(k) || n;
          const c = [...local.keys()].filter(lk => k.length >= 3 && (lk.startsWith(k) || lk.includes(k) || (lk.length >= 5 && k.includes(lk))));
          return c.length === 1 ? local.get(c[0]) : n;
        };
        if (r.cls_.TOT) r.cls_.TOT = r.cls_.TOT.map(x => ({ ...x, t: localTeam(x.t) }));
        for (const k of SEC_ORDER) if (r.cls_[k]) o.cl[k] = r.cls_[k].map(rowOut);
        if (r.leaders && Object.keys(r.leaders).length) { o.ld = {}; for (const [n, name] of Object.entries(r.leaders)) o.ld[n] = rid(name); }
        if (!o.st.length && !Object.keys(o.cl).length) return;
        upsert(data.races, o);
      },
      addIns(i, replies) {
        curSeason = seasonOf(i);
        const o = { id: i.id, s: seasonOf(i), name: i.name, start: i.start, end: i.end, c: i.country, cls: i.cls, note: i.note || undefined, im: i.im || undefined, sc: i.sc || undefined, scr: i.scRest || undefined, closed: i.closed ? 1 : 0, rp: replies, min: i.minR, max: i.maxR,
          e: i.entries.map(e => ({ m: e.manager, t: e.team, d: e.date, r: e.riders.map(x => {
            if (teamId.has(MC.teamKey(x.name)) || isJunk(stripTeam(cleanName(x.name)))) return -1;
            let id = rid(x.name, false);
            if (id < 0) { const cn = stripTeam(cleanName(x.name)); id = fuzzy(cn); if (id >= 0) touch(id, cn); else id = rid(x.name); }
            if (x.young) markYoung(id);
            return id;
          }).filter(id => id >= 0) })).filter(e => e.r.length) };
        if (i.img && i.img.length) o.img = i.img;
        upsert(data.ins, o);
      },
      finish(meta) {
        mergeDuplicates();
        mergeTeamRenames();
        fillScales();
        data.riders.forEach((r, i) => {
          const v = Object.entries(votes[i] || {}).map(([n, c]) => [n, c * capsPenalty(n)]).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
          if (v.length) r[0] = v[0][0];
          r[0] = fixCaps(r[0]);
          const ys = r.slice(1).filter(y => typeof y === 'number' && y > 1900).sort();
          r.length = 1; r.push(...ys);
        });
        data.races.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.id - b.id);
        data.ins.sort((a, b) => (a.start || '').localeCompare(b.start || '') || a.id - b.id);
        data.seasons = [...new Set(data.races.map(r => r.s).concat(data.ins.map(i => i.s)).filter(Boolean))].sort();
        if (meta) Object.assign(data, meta);
        return data;
      }
    };
  }

  // Parse raw topics ({id, t:{title,replies,closed,kind}, posts:[{a,tm,d,L}]}) into the compactor.
  function ingest(comp, topics, opts = {}) {
    const res = topics.filter(x => x.t.kind === 'res');
    const ins = topics.filter(x => x.t.kind === 'ins');
    const teamIdx = MC.TeamIndex();
    comp.data.teams.forEach(t => teamIdx.add(t));
    MC.learnTeams(res, teamIdx);
    for (const x of res) { try { comp.addRace(MC.parseRaceTopic(x, teamIdx), x.t.replies); } catch (e) { opts.onError && opts.onError(x, e); } }
    for (const x of ins) { try { const i = MC.parseInscriptionTopic(x); if (i.start) comp.addIns(i, x.t.replies); } catch (e) { opts.onError && opts.onError(x, e); } }
  }

  // Puntos y días por corredor y puntos por equipo de una temporada, con las mismas reglas que la web (app.js)
  function seasonTotals(data, season, today) {
    today = today || new Date().toISOString().slice(0, 10);
    const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 864e5);
    const R = new Map(), T = new Map();
    const RS = id => { let o = R.get(id); if (!o) { o = { pts: 0, days: 0 }; R.set(id, o); } return o; };
    for (const r of data.races) {
      if (+r.s !== +season) continue;
      const add = row => { const [p, rid, tid, v, pts] = row; if (tid >= 0 && pts) T.set(tid, (T.get(tid) || 0) + pts); if (rid >= 0) RS(rid).pts += pts || 0; };
      r.st.forEach(s => s.rows.forEach(add));
      for (const k of ['GC', 'PTS', 'KOM', 'YOU', 'LDR']) (r.cl[k] || []).forEach(add);
      (r.cl.TEAM || []).forEach(([p, rid, tid, v, pts]) => { if (tid >= 0 && pts) T.set(tid, (T.get(tid) || 0) + pts); });
      const dayRows = new Map();
      if (/^(WC|OG)\./.test(r.cls || '')) { /* no cuentan */ }
      else if (!r.multi) {
        r.st.forEach(s => s.rows.forEach(w => { if (w[1] >= 0) dayRows.set(w[1], 1); }));
        for (const k of ['GC', 'PTS', 'KOM', 'YOU', 'LDR']) (r.cl[k] || []).forEach(w => { if (w[1] >= 0) dayRows.set(w[1], 1); });
      } else {
        const prl = new Set(r.st.filter(s => s.ty === 'PRL').map(s => Math.floor(s.n)));
        const dayN = [...new Set(r.st.map(s => Math.floor(s.n)))].sort((a, b) => (prl.has(b) - prl.has(a)) || a - b);
        const span = r.end && r.start ? daysBetween(r.start, r.end) + 1 : dayN.length;
        const D = Math.min(dayN.length, span);
        const ended = !(r.end && r.end >= today);
        r.st.forEach(s => { const di = dayN.indexOf(Math.floor(s.n)); s.rows.forEach(w => { if (w[1] >= 0) dayRows.set(w[1], Math.max(dayRows.get(w[1]) || 0, di + 1)); }); });
        const gc = new Set((r.cl.GC || []).map(w => w[1]));
        for (const [rid, d] of dayRows) dayRows.set(rid, gc.has(rid) ? D : Math.min(D, ended ? d + 1 : d));
        for (const rid of gc) if (rid >= 0 && !dayRows.has(rid)) dayRows.set(rid, D);
      }
      for (const [rid, d] of dayRows) RS(rid).days += d;
    }
    return { riders: R, teams: T };
  }

  G.MCBuild = { Compactor, ingest, seasonTotals };
})(typeof window !== 'undefined' ? window : globalThis);
