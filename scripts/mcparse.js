// Line-level parser for Managercycling forum topics. Pure functions, no DOM.
// Input: posts = [{a: author, tm: profile team, d: date string, L: [lines]}], topic title.
(function (G) {
  const norm = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const fold = s => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/ß/g, 'ss').replace(/ł/g, 'l').replace(/đ/g, 'd').toLowerCase();
  const riderKey = s => fold(String(s).replace(/\(J\)/gi, ' ')).replace(/[^a-z0-9]+/g, ' ').trim();
  const tokenKey = s => riderKey(s).split(' ').filter(Boolean).sort().join(' ');
  const teamKey = s => fold(s).replace(/[^a-z0-9]+/g, '');

  // ---------- titles ----------
  const CLS_RE = /^(\d\.[A-Za-z0-9]+|[A-Z]{2,4}\.[A-Z0-9]+|NC|CN|CC|JJOO|WC|CM|GT|HC)$/;
  function parseTitle(t) {
    t = norm(t);
    let note = null;
    const nm = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
    if (nm && /\d{4}/.test(nm[1])) { t = nm[1]; note = nm[2]; }
    const m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})(?:\s*[-–]?\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{4}))?\s+(.+)$/);
    if (!m) return { name: t, start: null, end: null, country: null, cls: null, note };
    const d = (a, b, c) => `${c}-${String(b).padStart(2, '0')}-${String(a).padStart(2, '0')}`;
    let parts = m[7].split(' '), cls = null, country = null;
    for (let k = 0; k < 3 && parts.length > 1; k++) {
      const last = parts[parts.length - 1];
      if (!cls && CLS_RE.test(last)) { cls = parts.pop(); continue; }
      if (!country && /^[A-Z]{3}$/.test(last)) { country = parts.pop(); continue; }
      if (/^(ME|MU|MJ|WE)$/.test(last)) { parts.pop(); continue; }
      break;
    }
    let start = d(m[1], m[2], m[3]), end = m[4] ? d(m[4], m[5], m[6]) : null;
    if (end === start) end = null;
    return { name: parts.join(' '), start, end, country, cls, note };
  }

  // ---------- headers ----------
  const SEC = [
    ['TOTR', /^total(es)? (ciclistas|corredores)$/],
    ['TOT', /^(total|totales|puntos totales|total equipos|puntos equipos|puntos por equipos?|presupuesto)$/],
    ['GC', /^(general|resto de general|resto general|clasificacion general|general final|rojo|maillot rojo|rosa|maglia rosa|jaune|maillot jaune|amarillo|maillot amarillo|lider|gc)$/],
    ['PTS', /^(puntos|regularidad|clasificacion por puntos|ciclamino|maglia ciclamino|vert|maillot vert|verde|maillot verde|points)$/],
    ['KOM', /^(montana|clasificacion de la montana|azzurra|maglia azzurra|a pois|maillot a pois|lunares|pois|gpm|kom)$/],
    ['YOU', /^(jovenes|clasificacion jovenes|bianca|maglia bianca|blanc|maillot blanc|blanco|maillot blanco|sub ?23|young)$/],
    ['TEAM', /^(equipos|clasificacion por equipos|super team|equipes|squadre|teams|equipo)$/],
    ['R', /^(etapa|etape|tappa|final|clasica|resultado|resultados|crono|cri|llegada|meta|spoiler|clasificacion|clasificacion etapa|stage|prologo|resultado final|ttt|cre|podium|podio|resto de clasificacion|resto clasificacion|resto de clasica|resto de etapa|puntos individuales|etapa y general)$/],
    ['IGN', /^(campeones|participantes|equipos participantes|escapada|lesion|prediccion|vamos|arranca|salida|todo listo|contrarreloj integra|clasica integra|etapa en vivo|etapa y favoritos|perfil|ganador|lesionad|startlist|start list|inscritos|video|directo|vamos al directo|fuga|ultimos|abandono|favoritos|nota|palmares|puntos:|prueba|etapa completa|etapa integra|crono integra|prologo integro|clasica completa|carrera completa|retirad|descalific|sancion|fuera de control|recorrido|horario|previa)/],
  ];
  function sectionOf(h, raceName) {
    const f = fold(h).replace(/\(.*?\)/g, ' ').replace(/[:.\-–!¡]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (raceName && f === fold(raceName).replace(/[:.\-–!¡]+/g, ' ').replace(/\s+/g, ' ').trim()) return 'TOT';
    for (const [k, re] of SEC) if (re.test(f)) return k;
    return null;
  }
  // "Etapa 3 - MON", "Etapa 1 | Mónaco > Mónaco (PRL COL)", "3ª ETAPA", "Tappa 4", "Clásica - COL", "Prólogo"
  function stageCtx(h) {
    const s = norm(h);
    let m = s.match(/^(?:etapa|[ée]tape|tappa|stage)\s*(\d{1,2})\s*(?:\.\s*)?([ab](?![a-z]))?(?:\s*(?:[-–|:]\s*|\s+)(.*))?$/i);
    if (m && !/^\d/.test(m[3] || '')) return { n: +m[1] + (m[2] ? (m[2].toLowerCase() === 'b' ? 0.5 : 0.25) : 0), rest: norm(m[3] || '') };
    m = s.match(/^(\d{1,2})\s*[ªºa]?\.?\s*etapa\b\s*[-–|:]?\s*(.*)$/i);
    if (m) return { n: +m[1], rest: norm(m[2]) };
    m = s.match(/^pr[óo]logo\b\s*[-–|:]?\s*(.*)$/i);
    if (m && !/integr|complet/i.test(s)) return { n: 0.1, rest: norm(m[1]), prologue: true };
    m = s.match(/^cl[áa]sica\s*[-–|:]\s*(.+)$/i);
    if (m) return { n: 0, rest: norm(m[1]) };
    return null;
  }
  const TYPE_RE = /\b(LLA PAV|LL PAV|MM PAV|COL PAV|LLA|LL|MM|MON|COL|CRI|CRE|PRL COL|PRL|PAV|ALT|CRO)\b/;
  function cleanRoute(rest) {
    let r = (rest || '').replace(/\((?:[A-Z ]+)\)\s*$/, '').replace(TYPE_RE, '').replace(/^[-–|:\s]+|[-–|:\s]+$/g, '');
    if (!/[>–-]|\s-\s/.test(r) && /^(llana|monta|media|alta|contrarreloj|crono|colinas|pr[oó]logo|pav)/i.test(r)) return null;
    return r || null;
  }
  function stageType(rest) {
    if (!rest) return null;
    const m = rest.match(TYPE_RE); if (m) return m[1];
    const f = fold(rest), pav = /pave|adoquin/.test(f) ? ' PAV' : '';
    if (/contrarreloj por equipos|crono por equipos|crono equipos|ttt/.test(f)) return 'CRE';
    if (/contrarreloj|crono|\bcri\b|\bitt\b/.test(f)) return 'CRI';
    if (/prologo/.test(f)) return 'PRL';
    if (/media montana|media-montana|accidentad|quebrad/.test(f)) return 'MM' + pav;
    if (/alta montana|montana|alto|puerto/.test(f)) return 'MON';
    if (/colin|ondulad/.test(f)) return 'COL' + pav;
    if (/llan|sprint/.test(f)) return 'LL' + pav;
    return pav ? 'PAV' : null;
  }

  // ---------- values ----------
  const TIME_TOK = /^(s\.?t\.?|m\.?t\.?|\+|\+?\d+h\d+'?\d*"?|\+?\d+'\d*"?|\+\d+"?|\d+h\d+'?\d*"?|\d+'\d*"?|\d+:\d{2}(:\d{2})?|\d+"|a|m\.?t\.?)$/i;
  const NUM_TOK = /^\d{1,3}(\.\d{3})+(,\d+)?$|^\d+(,\d+)?$/;
  const PAREN_TOK = /^\(\d+\)$/;
  const isValTok = t => TIME_TOK.test(t) || NUM_TOK.test(t) || PAREN_TOK.test(t) || /^(dnf|dns|otl|ab|abd|fc|-|–|=|=\+|\+=)$/i.test(t) || /^=\+?\d/.test(t);
  const toNum = t => { const v = parseFloat(t.replace(/\./g, '').replace(',', '.')); return Math.round(v * 1e6) / 1e6; };

  function splitValues(rest) {
    // rest = "Name Team 4h30'35" → [textPart, valuesPart]
    const toks = rest.split(' ');
    let i = toks.length;
    while (i > 0 && isValTok(toks[i - 1])) i--;
    // don't eat a team/rider name that ends in a number like "Team 7" — keep at least one word
    return [toks.slice(0, i).join(' '), toks.slice(i).join(' ')];
  }

  // ---------- teams ----------
  function TeamIndex() {
    const byKey = new Map(); // teamKey -> display
    let sorted = null;
    return {
      add(name) { name = norm(name); if (!name || name.length < 3) return; const k = teamKey(name); if (!k) return; if (!byKey.has(k)) { byKey.set(k, name); sorted = null; } },
      has(name) { return byKey.has(teamKey(name)); },
      get(name) { return byKey.get(teamKey(name)); },
      // find team at the END of text: returns [riderPart, team] or null
      splitEnd(text) {
        // longest team name that ends the text, compared without spaces/punctuation
        const words = norm(text).split(' ');
        for (let i = 0; i < words.length; i++) {
          const k = teamKey(words.slice(i).join(' '));
          if (k && byKey.has(k)) return [words.slice(0, i).join(' '), byKey.get(k)];
        }
        return null;
      },
      all() { return [...byKey.values()]; },
      size() { return byKey.size; }
    };
  }

  // Learn team names from tabbed rows (unambiguous) across many topics.
  function learnTeams(topics, idx) {
    for (const x of topics) for (const p of x.posts) for (const l of p.L) {
      if (l.indexOf('\t') < 0) continue;
      const c = l.split('\t').map(norm).filter(Boolean);
      const okTeam = x => x && /[A-Za-z]{2}/.test(x) && !x.split(' ').every(isValTok) && !/^[+(]/.test(x);
      if (c.length >= 4 && /^\d+$/.test(c[0]) && okTeam(c[2]) && okTeam(c[1])) idx.add(c[2]);
      else if (c.length === 3 && /^\d+$/.test(c[0]) && NUM_TOK.test(c[2]) && /team|cycling|pro|equipo|\-|\//i.test(c[1]) && c[1].split(' ').length >= 2) { /* maybe team row, skip */ }
      else if (c.length === 2 && NUM_TOK.test(c[1]) && okTeam(c[0]) && !/^\d+$/.test(c[0])) idx.add(c[0]);
      else if (c.length === 3 && okTeam(c[0]) && !/^\d+$/.test(c[0]) && NUM_TOK.test(c[2]) && okTeam(c[1])) idx.add(c[1]);
    }
  }

  // ---------- rows ----------
  function preSplit(line) {
    let l = line.replace(/\b([sm])\.\s+t\./gi, '$1.t.').replace(/^\s*spoiler:\s*/i, '').replace(/^\s*final\s*\(spoiler\):\s*/i, '');
    // "Clásica:1 Paul Lapeira ..." → header + row
    if (/^l[íi]der\b/i.test(l)) return [null, ''];
    // "Etapa 19 1 Tobias Halland Johannessen Lidl-Trek 480" → header + row
    const g = l.match(/^((?:etapa|stage)\s*\d+\s*(?:\.?\s*[ab](?![a-z]))?|pr[oó]logo)[\t ]+(\d+[.º]?[\t ]+\D.*)$/i);
    if (g) return [norm(g[1]), g[2]];
    const m = l.match(/^([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9() ]{2,30}?):+\s*(\d+[\t ].*)$/);
    if (m) return [m[1], m[2]];
    const t = l.match(/^([^\t\d][^\t]{1,40}?)\t+(\d+\t.*)$/);
    if (t && (stageCtx(t[1]) || sectionOf(t[1]))) return [t[1], t[2]];
    return [null, l];
  }

  function parseRow(line, sec, teams) {
    if (line.indexOf('\t') >= 0) {
      let c = line.split('\t').map(norm).filter(Boolean);
      let pos = null;
      if (/^\d+\.?$/.test(c[0]) && c.length >= 2) { pos = parseInt(c[0], 10); c = c.slice(1); }
      else { const pm = c[0].match(/^(\d+)\s*[.ºª)-]?\s+(\D.*)$/); if (pm) { pos = +pm[1]; c[0] = pm[2]; } }
      // merge trailing value cols
      let vi = c.length; while (vi > 1 && isValTok(c[vi - 1].split(' ')[0])) vi--;
      const names = c.slice(0, vi), vals = c.slice(vi).join(' ');
      if (!vals && pos == null) return null;
      if (names.length >= 2) return mkRow(pos, names[0], names[1], vals, teams);
      if (names.length === 1) {
        const n = names[0];
        if (sec === 'TEAM' || sec === 'TOT' || teams.has(n)) return mkRow(pos, null, n, vals, teams);
        const sp = teams.splitEnd(n);
        if (sp && sp[0]) return mkRow(pos, sp[0], sp[1], vals, teams);
        return mkRow(pos, n, null, vals, teams);
      }
      return null;
    }
    let m = line.match(/^(\d+)\s*[.ºª)-]?\s+(\D.*)$/), pos = null, rest;
    if (m) { pos = +m[1]; rest = m[2]; } else rest = line;
    const [text, vals] = splitValues(norm(rest));
    if (!text) return null;
    if (pos == null && !vals) return null;
    const sp = teams.splitEnd(text);
    if (sp) return mkRow(pos, sp[0] || null, sp[1], vals, teams);
    if (pos == null) return null; // unpositioned lines need a known team
    if (sec === 'TEAM' || sec === 'TOT') return mkRow(pos, null, text, vals, teams);
    return mkRow(pos, text, null, vals, teams);
  }
  function mkRow(pos, rider, team, vals, teams) {
    vals = norm(vals);
    let toks = vals ? vals.split(' ') : [];
    const nums = toks.filter(t => NUM_TOK.test(t));
    const timey = toks.some(t => /h|'|s\.?t|m\.?t|\+|:|"/i.test(t));
    const one = !timey && toks.length === 1 && nums.length === 1 ? toNum(nums[0]) : null;
    // "1h00'12 70" / "+ 47 42": a single time followed by MC points (older seasons)
    let pts0 = null;
    if (timey && toks.length >= 2 && NUM_TOK.test(toks[toks.length - 1])) {
      const groups = []; let i = 0;
      while (i < toks.length) {
        const t = toks[i];
        if (t === '+' && i + 1 < toks.length) { groups.push('t'); i += 2; continue; }
        if (/h|'|"|s\.?t|m\.?t|:|^\+\d/i.test(t)) { groups.push('t'); i++; continue; }
        if (PAREN_TOK.test(t)) { groups.push('p'); i++; continue; }
        if (NUM_TOK.test(t)) { groups.push('n'); i++; continue; }
        groups.push('?'); i++;
      }
      if (groups.length === 2 && groups[0] === 't' && groups[1] === 'n') { pts0 = toNum(toks.pop()); vals = toks.join(' '); }
    }
    if (rider && /^[a-zà-ÿ]/.test(norm(rider)) && !/^(de|del|van|von|da|di|le|la)\s/i.test(norm(rider))) return null; // narrative text, not a rider
    return { p: pos, r: rider ? norm(rider) : null, t: team ? (teams.get(team) || norm(team)) : null, v: vals.slice(0, 40), one, timey, pts0 };
  }

  // ---------- topic → blocks ----------
  function topicBlocks(posts, raceName, teams, log) {
    const blocks = [], leaderPts = new Map();
    posts.forEach((p, pi) => {
      if (!p.L || !p.L.length || /contenido patrocinado/i.test(p.a || '')) return;
      let ctx = null, ctxInfo = null, sec = null, cur = null, lastPos = null;
      const start = (s) => { cur = { post: pi, ctx, ctxInfo, sec: s, rows: [] }; blocks.push(cur); lastPos = null; };
      for (const raw of p.L) {
        const lr = raw.replace(/^\s*spoiler:\s*/i, '');
        if (/^\s*l[íi]der\b/i.test(lr)) {
          // "Líder Remco Evenepoel (J)  Team Flanders - Baloise  96": puntos MC por ir líder tras la etapa
          const rest = lr.replace(/^\s*l[íi]der\s*:?\s*/i, '');
          const r = /\d\s*$/.test(rest) ? parseRow(rest, 'R', teams) : null;
          if (r && r.one == null && /^[\d. ]+$/.test(r.v || '')) { const t = r.v.split(' ').pop(); if (NUM_TOK.test(t)) { r.one = toNum(t); r.v = t; } }
          if (r && r.r && r.one != null && ctx != null) leaderPts.set(ctx, r);
          continue;
        }
        let [hdr, line] = preSplit(raw);
        const lines = hdr ? [hdr, line] : [line];
        for (const l0 of lines) {
          const l = norm(l0.replace(/\t+$/, '')) && l0;
          if (!norm(l)) continue;
          const looksRow = (/^\d+\s*[.ºª)-]?[\t ]+\S/.test(l) || (l.indexOf('\t') >= 0 && /\d/.test(l))) && !/^\d{1,2}\s*[ªºa]?\.?\s*etapa\b/i.test(norm(l));
          if (!looksRow) {
            const t = norm(l);
            if (/^l[íi]der\b/i.test(t)) continue;
            const sc = t.length < 160 ? stageCtx(t) : null;
            if (t.length > 70 && !sc) continue;
            if (sc) { ctx = sc.n; ctxInfo = sc; sec = 'R'; cur = null; continue; }
            const s = sectionOf(t, raceName);
            if (s) { sec = s === 'IGN' ? null : s; cur = null; continue; }
            // a bare team/rider row without position (e.g. TTT members "Name Team 75"), or a points
            // list written without positions at the top of a post: "Yves Lampaert  Intermarché - Wanty  220"
            if ((sec || /^[A-ZÀ-Ý][^\d:]{3,80}\s\d[\d.,]*$/.test(t)) && /\d$/.test(t)) {
              const r = parseRow(t, sec, teams);
              if (r && r.t && sec) {
                if (cur && r.r && cur.rows.some(x => x.r && riderKey(x.r) === riderKey(r.r))) { sec = 'UNK'; start(sec); }
                if (!cur) start(sec);
                r.p = lastPos || (cur.rows.length + 1); r.np = 1; cur.rows.push(r); continue;
              }
              if (r && r.t && r.r && r.r.split(' ').length <= 5 && r.one != null) {
                if (!cur || cur.sec !== 'NP' || cur.rows.some(x => x.r && riderKey(x.r) === riderKey(r.r))) { sec = null; start('NP'); }
                r.p = cur.rows.length + 1; cur.rows.push(r); continue;
              }
            }
            if (t.length < 40 && log) log('hdr', t);
            continue;
          }
          let s = sec;
          if (!s) { s = ctx != null ? 'R' : 'R'; }
          const r = parseRow(norm(l.replace(/\t/g, '\t')).length ? l : l, s, teams);
          if (!r) { if (log) log('row?', l); continue; }
          if (!cur || cur.sec !== s) { sec = s; start(s); }
          // a classification list that restarts at 1 without a header is another classification
          else if (r.p === 1 && lastPos >= 3 && ['GC', 'PTS', 'KOM', 'YOU', 'TEAM'].includes(s)) { sec = s = 'UNK'; start(s); }
          // a results list followed by a headerless young riders' list: "1 Jasper Philipsen (J) ..."
          else if (r.p === 1 && lastPos >= 3 && s === 'R' && r.r && /\(J\)/i.test(r.r)) { sec = s = 'YOU'; start(s); }
          if (r.p == null) { r.np = 1; r.p = lastPos || 1; } else lastPos = r.p;
          cur.rows.push(r);
        }
      }
    });
    const out = blocks.filter(b => b.rows.length);
    out.leaderPts = leaderPts;
    out.forEach((b, i) => { if (b.sec === 'NP') b.sec = i > 0 && out[i - 1].post === b.post && b.rows.every(r => /\(J\)/i.test(r.r || '')) ? 'YOU' : 'R'; });
    out.forEach(b => {
      if (b.sec === 'UNK' && b.rows.length && b.rows.every(r => r.r && /\(J\)/i.test(r.r))) { b.sec = 'YOU'; return; }
      if (b.sec !== 'UNK' || b.rows.some(r => r.timey)) return;
      const have = new Set(out.filter(o => o.post === b.post && o.ctx === b.ctx).map(o => o.sec));
      const guess = ['PTS', 'KOM'].find(k => !have.has(k));
      if (guess && b.rows.every(r => /^\d+ \d+$/.test(r.v))) b.sec = guess;
    });
    // Summary posts written as "1  Rider  Team  0  72": a constant first column, MC points last
    const timedPost = new Set(out.filter(b => b.rows.some(r => r.timey)).map(b => b.post));
    out.forEach(b => {
      if (timedPost.has(b.post)) return;
      if (b.rows.some(r => r.one != null)) {
        // stray "0 18" rows inside a points list: the MC points are the last number
        if (b.rows.filter(r => r.one != null).length >= b.rows.length * 0.7) b.rows.forEach(r => { if (r.one == null && /^[\d. ]+$/.test(r.v) && r.v.includes(' ')) { const t = r.v.split(' ').pop(); if (NUM_TOK.test(t)) r.one = toNum(t); } });
        return;
      }
      const toks = b.rows.map(r => r.v.split(' '));
      if (toks.every(t => t.length === 2 && t[0] === toks[0][0] && NUM_TOK.test(t[1]))) b.rows.forEach((r, i) => { r.one = toNum(toks[i][1]); r.v = toks[i][1]; });
    });
    // headerless team-only lists: "Team<TAB>652" → team totals; "1 Team 40" → team classification
    out.forEach(b => {
      if (b.sec === 'R' && b.rows.every(r => !r.r && r.t)) b.sec = b.rows.filter(r => r.np).length > b.rows.length / 2 ? 'TOT' : 'TEAM';
    });
    // Posts with stage results but no "Etapa N" header: number them in posting order.
    let last = 0;
    const byPost = new Map();
    out.forEach(b => { if (!byPost.has(b.post)) byPost.set(b.post, []); byPost.get(b.post).push(b); });
    for (const [, bs] of [...byPost.entries()].sort((a, b) => a[0] - b[0])) {
      const withCtx = bs.filter(b => b.ctx != null);
      if (withCtx.length) { last = Math.max(last, ...withCtx.map(b => Math.floor(b.ctx))); continue; }
      const timedR = bs.some(b => b.sec === 'R' && b.rows.some(r => r.timey) && b.rows.length >= 10);
      if (timedR) { last += 1; bs.forEach(b => { b.ctx = last; b.autoCtx = true; }); }
    }
    return out;
  }

  // ---------- assemble race ----------
  // a points list: every row has a single number, or the list goes on without values ("36 Connor Swift  Team")
  const isPointsBlock = b => b.rows.length > 0 && b.rows.some(r => r.one != null) && b.rows.every(r => r.one != null || (!r.v && !r.timey));
  const hasTime = b => b.rows.some(r => r.timey);
  function rk(r) { return r.r ? 'r:' + riderKey(r.r) : 't:' + teamKey(r.t || ''); }

  function mergeRows(base, others) {
    const out = base.map(r => ({ ...r, pts: base.isPts ? r.one : (r.pts0 ?? null) }));
    const m = new Map(out.map(r => [rk(r), r]));
    let usedP = base.isPts;
    const ordered = (others || []).slice().sort((a, b) => (isPointsBlock(b) && isPointsBlock(a) ? b.rows.length - a.rows.length : 0));
    for (const b of ordered) {
      const isP = isPointsBlock(b);
      if (isP) { if (usedP) continue; usedP = true; }
      if (!isP && !b.rows.some(r => r.pts0 != null)) continue;
      for (const r of b.rows) {
        const val = isP ? r.one : r.pts0;
        if (val == null) continue;
        const o = m.get(rk(r));
        if (o) { if (o.pts == null) o.pts = val; }
        else if (isP) { const n = { ...r, v: '', pts: val, extra: true }; out.push(n); m.set(rk(r), n); }
      }
    }
    return out;
  }
  // blocks of one stage / classification → pick the ordering base, keep the rest to merge points
  function pickBase(blocks, preferTime, preferBig) {
    if (!blocks.length) return null;
    const timeB = blocks.filter(b => !isPointsBlock(b));
    const ptsB = blocks.filter(isPointsBlock);
    const order = (a, b) => ((a.ctx ?? -1) - (b.ctx ?? -1)) || (a.post - b.post) || (a.rows.length - b.rows.length);
    const lastBy = arr => arr.slice().sort(order).pop();
    const bigBy = arr => arr.slice().sort((a, b) => (a.rows.length - b.rows.length) || order(a, b)).pop();
    let base;
    if (preferTime && timeB.length) base = preferBig ? bigBy(timeB) : lastBy(timeB);
    else if (ptsB.length) base = lastBy(ptsB);
    else base = lastBy(timeB);
    const others = blocks.filter(b => b !== base).sort(order).reverse();
    return { base, others, alt: ptsB.includes(base) ? lastBy(timeB) : null };
  }
  function finalize(sel) {
    if (!sel || !sel.base) return null;
    const base = sel.base.rows.slice();
    base.isPts = isPointsBlock(sel.base);
    const rows = mergeRows(base, sel.others);
    if (sel.alt && base.isPts) {
      const m = new Map(sel.alt.rows.map(r => [rk(r), r]));
      rows.forEach(r => { const a = m.get(rk(r)); if (a && !r.v) r.v = a.v; });
    }
    rows.sort((a, b) => a.p - b.p);
    return rows;
  }

  function parseRaceTopic(topic, teams, log) {
    const info = parseTitle(topic.t.title);
    const blocks = topicBlocks(topic.posts, info.name, teams, log);
    const stageNums = new Set();
    blocks.forEach(b => { if (b.ctx != null && b.ctx > 0) stageNums.add(b.ctx); });
    const explicit = new Set(); blocks.forEach(b => { if (b.ctx != null && b.ctx > 0 && !b.autoCtx) explicit.add(b.ctx); });
    const multi = !!info.end || explicit.size > 1;
    const race = { id: topic.id, title: topic.t.title, ...info, stages: [], cls_: {} };
    const stageInfo = {};
    blocks.forEach(b => { if (b.ctxInfo && b.ctx != null) stageInfo[b.ctx] = stageInfo[b.ctx] || b.ctxInfo; });
    if (multi) {
      const ns = [...stageNums].sort((a, b) => a - b);
      for (const n of ns) {
        const bs = blocks.filter(b => b.sec === 'R' && b.ctx === n);
        const rows = finalize(pickBase(bs, true, true));
        if (!rows) continue;
        // Crono por equipos: los puntos se publican por equipo y se reparten entre sus corredores
        if (!rows.some(r => r.pts != null)) {
          const tb = blocks.filter(b => b.ctx === n && (b.sec === 'TEAM' || b.sec === 'R') && isPointsBlock(b) && b.rows.every(r => !r.r && r.t)).pop();
          if (tb) {
            tb.ttt = true;
            for (const t of tb.rows) {
              if (t.one == null) continue;
              const mine = rows.filter(r => r.r && r.t && teamKey(r.t) === teamKey(t.t));
              mine.forEach(r => { r.pts = Math.round(1e6 * t.one / mine.length) / 1e6; });
            }
          }
        }
        const inf = stageInfo[n] || {};
        race.stages.push({ n, label: inf.prologue ? 'Prólogo' : 'Etapa ' + (Number.isInteger(n) ? n : Math.floor(n) + (n % 1 === 0.5 ? 'b' : 'a')), type: stageType(inf.rest) || (inf.prologue ? 'PRL' : null), route: cleanRoute(inf.rest), rows });
      }
      // Prologue posted as "Prólogo" but numbered "Etapa 1" in the points summary
      const pro = race.stages.find(s => s.n === 0.1), e1 = race.stages.find(s => s.n === 1);
      if (pro && e1 && e1.rows.every(r => r.pts != null && !r.timey) && !race.stages.some(s => s.n === 1 && s.rows.some(r => r.timey))) {
        const m = new Map(pro.rows.map(r => [rk(r), r]));
        e1.rows.forEach(r => { const o = m.get(rk(r)); if (o) o.pts = r.pts; });
        race.stages = race.stages.filter(s => s !== e1);
        pro.points = true;
      }
      // leaders after each stage (from time-based GC blocks)
      race.leaders = {};
      for (const [n, r] of blocks.leaderPts) race.leaders[n] = r.r;
      blocks.filter(b => b.sec === 'GC' && b.ctx != null && !isPointsBlock(b) && b.rows[0] && b.rows[0].r).forEach(b => { race.leaders[b.ctx] = b.rows[0].r; });
      if (blocks.leaderPts.size) race.cls_.LDR = [...blocks.leaderPts].sort((a, b) => a[0] - b[0]).map(([n, r]) => ({ ...r, p: n, v: '', pts: r.one }));
    } else {
      // one-day race whose points list is headed "Puntos"
      if (!blocks.some(b => b.sec === 'R' && isPointsBlock(b))) blocks.filter(b => b.sec === 'PTS' && isPointsBlock(b) && b.rows.length >= 5).forEach(b => { b.sec = 'R'; });
      const bs = blocks.filter(b => b.sec === 'R');
      const rows = finalize(pickBase(bs, true, true));
      const inf = stageInfo[0] || Object.values(stageInfo)[0] || {};
      if (rows) race.stages.push({ n: 0, label: 'Resultado', type: stageType(inf.rest), rows });
    }
    for (const c of ['GC', 'PTS', 'KOM', 'YOU', 'TEAM']) {
      const bs = blocks.filter(b => b.sec === c && !b.ttt);
      const rows = finalize(pickBase(bs, c === 'GC' || c === 'PTS' || c === 'KOM'));
      if (rows && rows.length) race.cls_[c] = rows;
    }
    const tot = blocks.filter(b => b.sec === 'TOT').pop();
    if (tot) race.cls_.TOT = tot.rows.map(r => ({ ...r, t: r.t || r.r, r: null, pts: r.one })).sort((a, b) => (b.pts || 0) - (a.pts || 0)).map((r, i) => ({ ...r, p: i + 1 }));
    race.multi = multi;
    return race;
  }

  // ---------- inscriptions ----------
  const NOT_NAME = /https?:|\d{2}\/\d{2}|clasificaci|^\d+º|:$|corredores|puntos|palmar|equipo|mánager|manager|edici[oó]n|inscrip|^\d+$|^_{2,}|lesion|baja|alta|cambio|sustitu|^(ok|vale|gracias)/i;
  function parseInscriptionTopic(topic) {
    const info = parseTitle(topic.t.title);
    const posts = topic.posts.filter(p => p.L && !/contenido patrocinado/i.test(p.a || ''));
    const rules = posts[0];
    const ruleText = rules ? norm(rules.L.join(' ')) : '';
    const mr = ruleText.match(/entre\s+(\d+)\s+y\s+(\d+)\s+corredores/i) || ruleText.match(/(\d+)\s+corredores/i);
    const byMgr = new Map();
    posts.slice(1).forEach(p => {
      const riders = [];
      for (const raw of p.L) {
        let l = norm(raw.replace(/\t/g, ' '));
        if (/^_{3,}/.test(l)) break;
        if (!l || l.length > 48 || NOT_NAME.test(l)) continue;
        l = l.replace(/^\s*(\d+\s*[.)\-ºª]?|[-•*·])\s*/, '').replace(/\s*[-–]\s*(l[ií]der|capit[áa]n|jefe|gregario|sprinter|escalador).*$/i, '').trim();
        const young = /\(\s*J\s*\)|\bsub-?23\b/i.test(l);
        l = l.replace(/\(\s*J\s*\)/gi, '').replace(/\s+,/g, ',').trim();
        // "Girmay, Biniam" → "Biniam Girmay"
        const cm = l.match(/^([^,]+),\s*([^,]+)$/);
        if (cm) l = cm[2] + ' ' + cm[1];
        if (!/^[A-Za-zÀ-ÿĀ-žḀ-ỿ'’.\- ]+$/.test(l)) continue;
        const w = l.split(' ').filter(Boolean);
        if (w.length < 2 || w.length > 6) continue;
        if (!/^[A-ZÀ-ÝĀ-ŽḀ-Ỿ'’]/.test(w[0]) || !w.every(x => /^[A-ZÀ-ÝĀ-ŽḀ-Ỿ'’]/.test(x) || /^(de|del|der|den|van|von|da|di|du|le|la|ten|ter|dos|das|al|el|bin|ben|zu|y|i|e|d'\S+)$/i.test(x))) continue;
        riders.push({ name: norm(l), young });
      }
      if (!riders.length) return;
      byMgr.set(p.a || ('#' + p.id), { manager: p.a, team: p.tm || null, date: p.d, riders });
    });
    return { id: topic.id, title: topic.t.title, ...info, closed: !!topic.t.closed, minR: mr ? +mr[1] : null, maxR: mr ? +(mr[2] || mr[1]) : null, entries: [...byMgr.values()] };
  }

  G.MC = { norm, fold, riderKey, tokenKey, teamKey, parseTitle, sectionOf, stageCtx, TeamIndex, learnTeams, topicBlocks, parseRaceTopic, parseInscriptionTopic, isPointsBlock };
})(typeof window !== 'undefined' ? window : globalThis);
