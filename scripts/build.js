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

  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 9;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
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
    s = s.replace(/\s+(CN|CC|CM|CE|EEUU|\(CN\)|\(CM\))$/, '').replace(/\s+\d+([.,]\d+)?$/, '');
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
      for (const r of data.races) {
        if (r.multi || !r.st[0] || !r.cls) continue;
        const rows = r.st[0].rows;
        if (rows.filter(x => x[4] != null).length < rows.length * 0.9) continue;
        if (!scale.has(key(r))) scale.set(key(r), new Map());
        const m = scale.get(key(r));
        for (const x of rows) if (x[4] != null && x[0] > 0) { const c = m.get(x[0]) || new Map(); c.set(x[4], (c.get(x[4]) || 0) + 1); m.set(x[0], c); }
      }
      let filled = 0;
      for (const r of data.races) {
        if (r.multi || !r.st[0] || !scale.has(key(r))) continue;
        const rows = r.st[0].rows, m = scale.get(key(r));
        const withP = rows.filter(x => x[4] != null).length;
        if (!withP || withP === rows.length) continue;
        const lastP = Math.max(...rows.filter(x => x[4] != null).map(x => x[0]));
        for (const x of rows) {
          if (x[4] != null || !(x[0] > lastP) || x[1] < 0) continue;
          const c = m.get(x[0]); if (!c) continue;
          let best = null, bn = 0; for (const [v, n] of c) if (n > bn) { bn = n; best = v; }
          if (best != null && bn >= 2) { x[4] = best; filled++; }
        }
      }
      return filled;
    }

    return {
      data,
      addRace(r, replies) {
        curSeason = seasonOf(r);
        const o = { id: r.id, s: seasonOf(r), name: r.name, start: r.start, end: r.end, c: r.country, cls: r.cls, note: r.note || undefined, multi: r.multi ? 1 : 0, rp: replies, st: [], cl: {} };
        for (const s of r.stages) o.st.push({ n: s.n, l: s.label, ty: s.type || undefined, ro: s.route || undefined, rows: s.rows.map(rowOut) });
        for (const k of SEC_ORDER) if (r.cls_[k]) o.cl[k] = r.cls_[k].map(rowOut);
        if (r.leaders && Object.keys(r.leaders).length) { o.ld = {}; for (const [n, name] of Object.entries(r.leaders)) o.ld[n] = rid(name); }
        if (!o.st.length && !Object.keys(o.cl).length) return;
        upsert(data.races, o);
      },
      addIns(i, replies) {
        curSeason = seasonOf(i);
        const o = { id: i.id, s: seasonOf(i), name: i.name, start: i.start, end: i.end, c: i.country, cls: i.cls, note: i.note || undefined, closed: i.closed ? 1 : 0, rp: replies, min: i.minR, max: i.maxR,
          e: i.entries.map(e => ({ m: e.manager, t: e.team, d: e.date, r: e.riders.map(x => {
            if (teamId.has(MC.teamKey(x.name)) || isJunk(stripTeam(cleanName(x.name)))) return -1;
            let id = rid(x.name, false);
            if (id < 0) { const cn = stripTeam(cleanName(x.name)); id = fuzzy(cn); if (id >= 0) touch(id, cn); else id = rid(x.name); }
            if (x.young) markYoung(id);
            return id;
          }).filter(id => id >= 0) })).filter(e => e.r.length) };
        upsert(data.ins, o);
      },
      finish(meta) {
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

  G.MCBuild = { Compactor, ingest };
})(typeof window !== 'undefined' ? window : globalThis);
