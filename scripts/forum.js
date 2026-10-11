// Fetching + DOM reading of the Managercycling forum (foroactivo). Works in browsers
// (forum sends Access-Control-Allow-Origin: *) and in node with a DOMParser polyfill.
(function (G) {
  const BASE = 'https://managercycling.foroactivo.com';
  const POSTS_PER_PAGE = 25, TOPICS_PER_PAGE = 50;
  const norm = s => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  const num = s => { const t = String(s || '').replace(/[^\d]/g, ''); return t ? parseInt(t, 10) : 0; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));


  // ---- DOM-free readers (node / GitHub Actions) ----
  const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»', ndash: '–', mdash: '—', hellip: '…', iexcl: '¡', iquest: '¿', ordm: 'º', ordf: 'ª', deg: '°', middot: '·', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', euro: '€', copy: '©', reg: '®' };
  const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e.toLowerCase()] ?? m));
  const strip = h => decode(h.replace(/<[^>]*>/g, ''));
  function htmlLines(h) {
    h = h.replace(/<(style|script|noscript|iframe)\b[\s\S]*?<\/\1>/gi, '').replace(/<ins\b[\s\S]*?<\/ins>/gi, '').replace(/\r?\n/g, ' ');
    h = h.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p|tr|li|h[1-4])>/gi, '\n').replace(/<\/t[dh]>/gi, '\t');
    return strip(h).replace(/ /g, ' ').split('\n').map(l => l.replace(/^[ \t]+|[ \t]+$/g, '')).filter(Boolean);
  }
  function listTopicsText(html) {
    const out = [];
    const rows = html.split(/<tr\b/i);
    for (const r of rows) {
      const a = r.match(/<a class="topictitle" href="\/?(t(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      if (!a) continue;
      const tds = r.split(/<td\b/i).slice(1);
      const icon = (tds[0] || '').match(/src="([^"]*)"/i);
      out.push({ id: +a[2], slug: a[1], title: norm(strip(a[3])), replies: tds[3] ? num(strip('<td' + tds[3])) : 0, closed: !!(icon && /lock/.test(icon[1])) });
    }
    return out;
  }
  function pageCountText(html) { let max = 1; for (const m of html.matchAll(/href="\/?f\d+p(\d+)-/g)) max = Math.max(max, Math.floor(+m[1] / TOPICS_PER_PAGE) + 1); return max; }
  function readPostsText(html) {
    const parts = html.split(/<tr class="post\b/i).slice(1);
    const out = [];
    for (const p of parts) {
      const idm = p.match(/^[^>]*\bid="p(\d+)"/);
      const nameM = p.match(/<span class="name">([\s\S]*?)<\/span>\s*(?:<\/strong>\s*)*<\/span>|<span class="name">([\s\S]*?)<br/i);
      const author = norm(strip((nameM && (nameM[1] || nameM[2])) || '').replace(/<a[^>]*><\/a>/g, ''));
      const profM = p.match(/<span class="postdetails poster-profile">([^<]*)/i);
      const prof = norm(decode(profM ? profM[1] : ''));
      const team = (prof.match(/^M[áa]nager del?\s+(.+)$/i) || [])[1] || null;
      const dM = p.match(/<td><span class="postdetails">([\s\S]*?)<\/span><\/td>/i);
      const date = norm(strip(dM ? dM[1] : '')).replace(/^.*?(?=(Lun|Mar|Mi[ée]r?|Jue|Vie|S[áa]b|Dom|Hoy|Ayer)\b)/, '');
      const bi = p.indexOf('<div class="postbody">');
      if (bi < 0) continue;
      let body = p.slice(bi + 22);
      const sig = body.search(/<div class="signature_div"/i);
      const end = body.search(/<\/td>\s*<\/tr>\s*<\/tbody>\s*<\/table>/i);
      body = body.slice(0, sig >= 0 ? sig : (end >= 0 ? end : body.length));
      out.push({ a: author, tm: team, d: date, id: idm ? +idm[1] : null, L: htmlLines(body) });
    }
    return out;
  }

  const SECTION_NAMES = { 455: 'resultados', 451: 'inscripciones' };
  function Forum(opts = {}) {
    const DP = opts.DOMParser || G.DOMParser;
    const fetchFn = opts.fetch || G.fetch.bind(G);
    const gap = opts.gap ?? 600;           // ms between requests (forum rate-limits with 429)
    const tries = opts.tries ?? 5;
    let last = 0, stopped = false;

    async function getDoc(path) {
      const url = path.startsWith('http') ? path : BASE + (path.startsWith('/') ? '' : '/') + path;
      for (let attempt = 0; attempt < tries; attempt++) {
        if (stopped) throw new Error('stopped');
        const wait = last + gap - Date.now(); if (wait > 0) await sleep(wait);
        last = Date.now();
        let r;
        try {
          const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const to = ctl && setTimeout(() => ctl.abort(), 20000);
          r = await fetchFn(url, { credentials: 'omit', signal: ctl && ctl.signal });
          if (to) clearTimeout(to);
        } catch (e) { if (attempt >= tries - 1) throw e; await sleep(1500 * (attempt + 1)); continue; }
        if (r.status === 429) { if (opts.on429 === 'stop') { stopped = true; throw new Error('429'); } await sleep(8000 * (attempt + 1)); continue; }
        if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
        const html = await r.text();
        return DP ? new DP().parseFromString(html, 'text/html') : html;
      }
      throw new Error('gave up ' + url);
    }

    function listTopics(doc) {
      if (typeof doc === 'string') return listTopicsText(doc);
      const out = [];
      doc.querySelectorAll('a.topictitle').forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/?t(\d+)-/);
        if (!m) return;
        let tr = a.parentElement; while (tr && tr.tagName !== 'TR') tr = tr.parentElement;
        const tds = tr ? [...tr.children] : [];
        const icon = (tds[0] && tds[0].querySelector('img') && tds[0].querySelector('img').getAttribute('src')) || '';
        out.push({ id: +m[1], slug: href.replace(/^\//, ''), title: norm(a.textContent), replies: tds[3] ? num(tds[3].textContent) : 0, closed: /lock/.test(icon) });
      });
      return out;
    }
    function pageCount(doc) {
      if (typeof doc === 'string') return pageCountText(doc);
      let max = 1;
      doc.querySelectorAll('a[href]').forEach(a => { const m = (a.getAttribute('href') || '').match(/^\/?f\d+p(\d+)-/); if (m) max = Math.max(max, Math.floor(+m[1] / TOPICS_PER_PAGE) + 1); });
      return max;
    }
    // Pages of a forum section; stopAt(topicsOnPage) → true to stop early
    async function forumTopics(fid, { maxPages = 50, stopAt } = {}) {
      // Full section address ("455-resultados"): the short form "/f455-" is a redirect
      // without CORS headers, so browsers on other sites cannot read it.
      const fm = String(fid).match(/^f?(\d+)(?:-(.*))?$/);
      const id = fm ? fm[1] : fid, name = (fm && fm[2]) || SECTION_NAMES[id] || '';
      const first = await getDoc(`/f${id}-${name}`);
      const pages = Math.min(pageCount(first), maxPages);
      let all = listTopics(first);
      if (stopAt && stopAt(all)) return all;
      for (let p = 1; p < pages; p++) {
        const ts = listTopics(await getDoc(`/f${id}p${p * TOPICS_PER_PAGE}-${name}`));
        all = all.concat(ts);
        if (stopAt && stopAt(ts)) break;
      }
      const seen = new Set();
      return all.filter(t => !seen.has(t.id) && seen.add(t.id));
    }

    function bodyLines(postbody) {
      const c = postbody.cloneNode(true);
      c.querySelectorAll('.signature_div, style, script, iframe, ins, noscript, .clear').forEach(e => e.remove());
      c.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
      c.querySelectorAll('div, p, tr, li, h1, h2, h3, h4').forEach(b => b.append('\n'));
      c.querySelectorAll('td, th').forEach(b => b.append('\t'));
      return c.textContent.replace(/ /g, ' ').split('\n').map(l => l.replace(/^[ \t]+|[ \t]+$/g, '')).filter(Boolean);
    }
    function readPosts(doc) {
      if (typeof doc === 'string') return readPostsText(doc);
      return [...doc.querySelectorAll('tr.post')].map(tr => {
        const left = tr.children[0], right = tr.children[1];
        const body = right && right.querySelector('.postbody');
        if (!body) return null;
        const author = norm((left.querySelector('.name') || {}).textContent || '');
        const profEl = left.querySelector('.poster-profile');
        const prof = norm(profEl && profEl.childNodes[0] ? profEl.childNodes[0].textContent : '');
        const team = (prof.match(/^M[áa]nager del?\s+(.+)$/i) || [])[1] || null;
        const date = norm((right.querySelector('.postdetails') || {}).textContent || '').replace(/^.*?(?=(Lun|Mar|Mi[ée]r?|Jue|Vie|S[áa]b|Dom|Hoy|Ayer)\b)/, '');
        return { a: author, tm: team, d: date, id: +(tr.id || '').replace(/\D/g, '') || null, L: bodyLines(body) };
      }).filter(Boolean);
    }
    async function topic(t, kind) {
      const pages = Math.ceil(((t.replies || 0) + 1) / POSTS_PER_PAGE) || 1;
      let posts = [];
      for (let p = 0; p < pages; p++) {
        const slug = p === 0 ? t.slug : t.slug.replace(/^t(\d+)-/, `t$1p${p * POSTS_PER_PAGE}-`);
        posts = posts.concat(readPosts(await getDoc('/' + slug)));
      }
      return { id: t.id, t: { ...t, kind }, posts };
    }
    return { getDoc, forumTopics, topic, readPosts, listTopics, stop() { stopped = true; } };
  }

  G.MCForum = { Forum, BASE, readPostsText, listTopicsText };
})(typeof window !== 'undefined' ? window : globalThis);
