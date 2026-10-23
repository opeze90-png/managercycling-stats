// Predicción de la próxima temporada a partir de las medias (atributos) de la web oficial.
//
// 1. Aprende de la temporada actual qué puntos saca un corredor según sus atributos, su edad, si es joven (J)
//    y su papel en el equipo (puesto por media dentro de la plantilla, nivel del equipo): árboles de decisión
//    potenciados (gradient boosting) sobre log(1 + puntos por cada 85 días), sin contar los de la clasificación
//    de jóvenes, que se predicen aparte solo para los que siguen siendo jóvenes.
// 2. Valida el modelo con validación cruzada (cada corredor se predice con un modelo que no lo ha visto).
// 3. Aplica el modelo a las medias y plantillas de la próxima temporada y reparte los puntos de forma que el
//    total de los corredores que siguen sea el mismo que este año (los de los retirados quedan para los que
//    entren nuevos).
(function (G) {
  // ---------- gradient boosting (árboles de regresión, pérdida cuadrática) ----------
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function buildTree(X, r, idx, depth, minLeaf) {
    let sum = 0; for (const i of idx) sum += r[i];
    const mean = sum / idx.length;
    if (depth === 0 || idx.length < 2 * minLeaf) return { v: mean };
    let best = null;
    const nf = X[0].length;
    for (let f = 0; f < nf; f++) {
      const ord = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
      let ls = 0;
      for (let k = 0; k < ord.length - 1; k++) {
        ls += r[ord[k]];
        const nl = k + 1, nr = ord.length - nl;
        if (nl < minLeaf || nr < minLeaf) continue;
        const xa = X[ord[k]][f], xb = X[ord[k + 1]][f];
        if (xa === xb) continue;
        const rs = sum - ls, gain = ls * ls / nl + rs * rs / nr;
        if (!best || gain > best.gain) best = { gain, f, t: (xa + xb) / 2, k };
      }
    }
    if (!best) return { v: mean };
    const L = [], R = [];
    for (const i of idx) (X[i][best.f] <= best.t ? L : R).push(i);
    return { f: best.f, t: best.t, l: buildTree(X, r, L, depth - 1, minLeaf), r: buildTree(X, r, R, depth - 1, minLeaf) };
  }
  const predTree = (n, x) => { while (n.v === undefined) n = x[n.f] <= n.t ? n.l : n.r; return n.v; };
  function fitGBM(X, y, o = {}) {
    const n = X.length, T = o.trees || 400, lr = o.lr || 0.03, depth = o.depth || 3, sub = o.sub || 0.8, minLeaf = o.minLeaf || 5;
    const base = y.reduce((a, b) => a + b, 0) / n, F = new Array(n).fill(base), trees = [], rnd = rng(o.seed || 7);
    for (let t = 0; t < T; t++) {
      const r = y.map((v, i) => v - F[i]);
      const idx = []; for (let i = 0; i < n; i++) if (rnd() < sub) idx.push(i);
      const tree = buildTree(X, r, idx, depth, minLeaf);
      trees.push(tree);
      for (let i = 0; i < n; i++) F[i] += lr * predTree(tree, X[i]);
    }
    return { predict: x => trees.reduce((a, tr) => a + lr * predTree(tr, x), base) };
  }

  // ---------- datos ----------
  // fila de plantilla = [idCorredor, nombre, equipo, edad, días, puntos, rankPCS, LLA..REC (14), MED, salario]
  const ATTR = ['LLA', 'MON', 'MM', 'COL', 'CRI', 'PRL', 'PAV', 'SPR', 'ACE', 'DES', 'COM', 'ENE', 'RES', 'REC'];
  const OUT = /^(retirados|sancionados|agentes libres)$/i;
  function riders(rows) {
    return rows.map(r => ({ id: r[0], name: r[1], team: r[2], age: r[3], days: r[4] || 0, pts: r[5] || 0, att: r.slice(7, 21), med: r[21], J: /\(J\)/.test(r[1]) })).filter(o => o.med != null && o.att.every(v => v != null));
  }
  // papel en el equipo: puesto por media dentro de la plantilla, media de sus 8 mejores y distancia al líder
  function context(list) {
    const by = new Map();
    for (const o of list) { if (!by.has(o.team)) by.set(o.team, []); by.get(o.team).push(o); }
    for (const [t, l] of by) {
      l.sort((a, b) => b.med - a.med);
      const top = l.slice(0, 8).reduce((a, o) => a + o.med, 0) / Math.min(8, l.length);
      l.forEach((o, i) => { o.trank = OUT.test(t) ? 15 : i + 1; o.ttop = OUT.test(t) ? 70 : top; o.gap = o.med - l[0].med; });
    }
  }
  const feats = o => [...o.att, o.med, o.J ? 1 : 0, o.age || 27, o.trank, o.ttop, o.gap, o.div === 'WT' ? 1 : o.div === 'CP' ? 0 : 0.5];

  // youth: {idCorredor: puntos de la clasificación de jóvenes este año}; teamClass: puntos totales de la clasificación por equipos
  // Ascensos y descensos: con la clasificación por equipos de la temporada (equipo, puntos, categoría), los 3
  // últimos WorldTour bajan a Continental Profesional y los 3 primeros CP suben al WorldTour.
  function divisionsNext(rankTeams, n = 3) {
    const cur = {}, next = {}, up = [], down = [];
    for (const [name, , d] of rankTeams) cur[name] = next[name] = d;
    const wt = rankTeams.filter(t => t[2] === 'WT').sort((a, b) => b[1] - a[1]);
    const cp = rankTeams.filter(t => t[2] === 'CP').sort((a, b) => b[1] - a[1]);
    if (wt.length > n && cp.length > n) {
      for (const t of wt.slice(-n)) { next[t[0]] = 'CP'; down.push(t[0]); }
      for (const t of cp.slice(0, n)) { next[t[0]] = 'WT'; up.push(t[0]); }
    }
    return { cur, next, up, down };
  }

  function run(cur, next, youth, teamClass, opts = {}) {
    const A = riders(cur), B = riders(next);
    // Jóvenes (J): hasta una edad máxima (la de los J de esta temporada, 25). Las plantillas de la próxima temporada
    // copian la marca (J) de esta, así que se recalcula con la edad que tendrán: los que pasan de ella dejan de ser J.
    const jAges = A.filter(o => o.J && o.age).map(o => o.age);
    const jMax = jAges.length ? Math.max(...jAges) : 25;
    let lostJ = 0;
    for (const o of B) if (o.age) { const j = o.age <= jMax; if (o.J && !j) lostJ++; o.J = j; }
    context(A); context(B);
    // categoría de cada equipo esta temporada y la próxima (si se conoce)
    const DV = opts.rank ? divisionsNext(opts.rank) : null;
    const key = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const look = (m, team) => { if (!m) return null; if (m[team]) return m[team]; const k = key(team); for (const t in m) if (key(t) === k) return m[t]; return null; };
    for (const o of A) o.div = look(DV && DV.cur, o.team);
    for (const o of B) o.div = look(DV && DV.next, o.team) || (OUT.test(o.team) ? null : 'CP');
    const train = A.filter(o => o.days >= 15);
    const yv = o => Math.log1p(Math.max(0, o.pts - (youth[o.id] || 0)) / o.days * 85);
    const X = train.map(feats), y = train.map(yv);
    const gbmOpts = { trees: opts.trees || 400, lr: 0.03, depth: 3, sub: 0.8, minLeaf: 5 };
    // validación cruzada (5 grupos): cada corredor se predice con el modelo que no lo ha visto
    const K = 5, oof = new Array(train.length), models = [], foldOf = new Map();
    for (let k = 0; k < K; k++) {
      const tr = [], te = [];
      train.forEach((o, i) => (i % K === k ? te : tr).push(i));
      const m = fitGBM(tr.map(i => X[i]), tr.map(i => y[i]), { ...gbmOpts, seed: 11 + k });
      models.push(m);
      for (const i of te) { oof[i] = m.predict(X[i]); foldOf.set(train[i].id, { k, res: y[i] - oof[i], y: y[i] }); }
    }
    const my = y.reduce((a, b) => a + b, 0) / y.length;
    const r2 = 1 - y.reduce((a, v, i) => a + (v - oof[i]) ** 2, 0) / y.reduce((a, v) => a + (v - my) ** 2, 0);
    const ex = oof.map(Math.expm1), ac = y.map(Math.expm1);
    const corr = (a, b) => { const ma = a.reduce((s, v) => s + v, 0) / a.length, mb = b.reduce((s, v) => s + v, 0) / b.length; let c = 0, va = 0, vb = 0; a.forEach((v, i) => { c += (v - ma) * (b[i] - mb); va += (v - ma) ** 2; vb += (b[i] - mb) ** 2; }); return c / Math.sqrt(va * vb); };
    const cal = ac.reduce((a, b) => a + b, 0) / ex.reduce((a, b) => a + b, 0); // corrige el sesgo de volver de logaritmos
    // por equipos (validación): suma por equipo de lo predicho frente a lo real
    const tA = new Map(), tP = new Map();
    train.forEach((o, i) => { tA.set(o.team, (tA.get(o.team) || 0) + ac[i] * o.days / 85); tP.set(o.team, (tP.get(o.team) || 0) + ex[i] * cal * o.days / 85); });
    const tk = [...tA.keys()].filter(t => !OUT.test(t));
    const teamCorr = corr(tk.map(t => tA.get(t)), tk.map(t => tP.get(t)));
    // jóvenes: puntos de la clasificación de jóvenes por 85 días, entre los jóvenes de este año
    const YJ = A.filter(o => o.J && o.days >= 15);
    const ym = fitGBM(YJ.map(feats), YJ.map(o => Math.log1p((youth[o.id] || 0) / o.days * 85)), { ...gbmOpts, trees: 200, seed: 3 });
    const youthTot = A.reduce((a, o) => a + (youth[o.id] || 0), 0);
    // efecto de correr en un equipo WorldTour o Continental Profesional (calendario, invitaciones): lo que los
    // corredores de cada categoría sacan por encima o por debajo de lo que dan sus atributos, por separado
    // para jóvenes y resto (los CP corren además las carreras sub-23)
    const eff = {}, cnt = {};
    train.forEach((o, i) => { if (!o.div) return; const g = o.div + (o.J ? 'J' : ''); eff[g] = (eff[g] || 0) + (y[i] - oof[i]); cnt[g] = (cnt[g] || 0) + 1; });
    for (const g in eff) eff[g] /= cnt[g];
    // efecto medio de la categoría según el modelo: el mismo corredor en un WT frente a un CP
    let wtv = 0, cpv = 0;
    for (const o of train) { const x = feats(o), n = x.length - 1; const a1 = x.slice(), a0 = x.slice(); a1[n] = 1; a0[n] = 0; wtv += Math.expm1(models.reduce((s, m) => s + m.predict(a1), 0) / K); cpv += Math.expm1(models.reduce((s, m) => s + m.predict(a0), 0) / K); }
    const wtRatio = cpv ? wtv / cpv : 1;
    const E = (d, J) => (d ? eff[d + (J ? 'J' : '')] ?? eff[d] ?? 0 : 0);
    // días por corredor según la categoría (los WT corren más)
    const md = {}, mn = {};
    for (const o of A) if (o.div && o.days > 0) { md[o.div] = (md[o.div] || 0) + o.days; mn[o.div] = (mn[o.div] || 0) + 1; }
    for (const d in md) md[d] /= mn[d];
    // próxima temporada
    const prev = new Map(A.map(o => [o.id, o]));
    const act = B.filter(o => !OUT.test(o.team));
    for (const o of act) {
      const p = prev.get(o.id);
      // modelo que no ha visto al corredor + parte de lo que se salió del modelo este año (forma, papel, calendario).
      // Esa parte pesa poco en general (de un año a otro se repite poco) y más en los mejores, que no tienen
      // corredores parecidos con los que comparar.
      const f = foldOf.get(o.id), x = feats(o);
      const base = f ? models[f.k].predict(x) : models.reduce((a, m) => a + m.predict(x), 0) / K;
      const a = f ? 0.1 + 0.4 * Math.min(1, Math.max(0, (f.y - 8.5) / 2)) : 0;
      // lo propio del corredor (residuo) se mide sin el efecto de la categoría en la que corrió, y se aplica el de la nueva
      const d0 = p ? p.div : null, d1 = o.div;
      const own = f ? f.res - E(d0, p && p.J) : 0;
      o.p85 = Math.expm1(base + a * own + E(d1, o.J)) * cal;
      o.y85 = o.J ? Math.max(0, Math.expm1(ym.predict(feats(o)))) : 0;
      // días que correrá: como este año; si su equipo cambia de categoría, en proporción a lo que corren en la nueva
      let ed = p && p.days >= 40 ? Math.min(85, p.days) : (md[d1] || 80);
      if (d0 && d1 && d0 !== d1 && md[d0] && md[d1]) ed = Math.max(40, Math.min(85, ed * md[d1] / md[d0]));
      o.edays = Math.round(ed);
      o.prev = p;
    }
    // reparto: los que siguen se reparten los mismos puntos que sumaron este año
    const poolMain = act.reduce((a, o) => a + (o.prev ? Math.max(0, o.prev.pts - (youth[o.id] || 0)) : 0), 0);
    const rawMain = act.reduce((a, o) => a + o.p85 * o.edays / 85, 0);
    const poolY = act.filter(o => o.J).reduce((a, o) => a + (youth[o.id] || 0), 0) || youthTot * 0.6;
    const rawY = act.reduce((a, o) => a + o.y85 * o.edays / 85, 0) || 1;
    const kM = poolMain / rawMain, kY = poolY / rawY;
    for (const o of act) { o.main = o.p85 * o.edays / 85 * kM; o.yp = o.y85 * o.edays / 85 * kY; o.pred = o.main + o.yp; o.pred85 = (o.p85 * kM + o.y85 * kY); }
    // equipos: suma de sus corredores + clasificación por equipos repartida según su fuerza
    const teams = new Map();
    for (const o of act) { if (!teams.has(o.team)) teams.set(o.team, { team: o.team, n: 0, riders: 0, top: [] }); const t = teams.get(o.team); t.n++; t.riders += o.pred; t.top.push(o); }
    const totR = [...teams.values()].reduce((a, t) => a + t.riders, 0);
    for (const t of teams.values()) { t.tc = teamClass * t.riders / totR; t.total = t.riders + t.tc; t.top.sort((a, b) => b.pred - a.pred); }
    return {
      year: opts.year, from: opts.from, jMax, lostJ,
      quality: { n: train.length, r2: Math.round(r2 * 1000) / 1000, corr: Math.round(corr(ex.map(v => v * cal), ac) * 1000) / 1000, teamCorr: Math.round(teamCorr * 1000) / 1000 },
      riders: act.sort((a, b) => b.pred - a.pred).map(o => [o.id, o.name, o.team, o.med, o.prev ? o.prev.med : null, o.J ? 1 : 0, o.age, o.prev ? o.prev.team : null, o.prev ? o.prev.pts : 0, o.prev ? o.prev.days : 0, Math.round(o.pred), Math.round(o.pred85), Math.round(o.yp), o.edays, o.trank]),
      teams: [...teams.values()].sort((a, b) => b.total - a.total).map(t => [t.team, t.n, Math.round(t.riders), Math.round(t.tc), Math.round(t.total), look(DV && DV.next, t.team) || '', look(DV && DV.cur, t.team) || '']),
      div: DV ? { up: DV.up, down: DV.down, wtRatio: Math.round(wtRatio * 1000) / 1000, effect: Object.fromEntries(Object.entries(eff).map(([g, v]) => [g, Math.round(Math.expm1(v) * 1000) / 1000])), days: Object.fromEntries(Object.entries(md).map(([g, v]) => [g, Math.round(v * 10) / 10])) } : null
    };
  }

  G.MCPredict = { run, fitGBM, ATTR, divisionsNext };
})(typeof window !== 'undefined' ? window : globalThis);
