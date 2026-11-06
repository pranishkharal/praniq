// Shared helpers for PranIQ (content script, popup, options, background)
const TL = {
  fmt(n) {
    n = Number(n) || 0;
    const s = (x, u) => x.toFixed(1).replace(/\.0$/, '') + u;
    if (Math.abs(n) >= 1e9) return s(n / 1e9, 'B');
    if (Math.abs(n) >= 1e6) return s(n / 1e6, 'M');
    if (Math.abs(n) >= 1e3) return s(n / 1e3, 'K');
    return String(Math.round(n));
  },
  money(n) {
    n = Number(n) || 0;
    if (n >= 1000) return '$' + TL.fmt(n);
    return '$' + (n < 10 ? n.toFixed(2) : Math.round(n));
  },
  hoursSince(iso) {
    return Math.max(1, (Date.now() - new Date(iso).getTime()) / 36e5);
  },
  ago(iso) {
    const h = TL.hoursSince(iso);
    if (h < 24) return Math.round(h) + 'h ago';
    const d = h / 24;
    if (d < 30) return Math.round(d) + 'd ago';
    if (d < 365) return Math.round(d / 30) + 'mo ago';
    return (d / 365).toFixed(1) + 'y ago';
  },
  median(a) {
    a = (a || []).filter((x) => x !== null && x !== undefined && !isNaN(x));
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },
  isoDur(s) {
    const m = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(s || '') || [];
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  },
  durText(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (x) => String(x).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  },
  // Rough creator RPM ranges (USD per 1,000 views) by YouTube category ID. Estimates only.
  RPM: {
    '1': [3, 6], '2': [6, 12], '10': [1, 3], '15': [3, 6], '17': [3, 6], '19': [4, 8],
    '20': [2, 5], '22': [3, 6], '23': [2, 5], '24': [2, 5], '25': [3, 7], '26': [5, 10],
    '27': [5, 12], '28': [6, 14], '29': [3, 7]
  },
  CATS: {
    '1': 'Film & Animation', '2': 'Autos & Vehicles', '10': 'Music', '15': 'Pets & Animals',
    '17': 'Sports', '19': 'Travel & Events', '20': 'Gaming', '22': 'People & Blogs', '23': 'Comedy',
    '24': 'Entertainment', '25': 'News & Politics', '26': 'Howto & Style', '27': 'Education',
    '28': 'Science & Tech', '29': 'Nonprofits'
  },
  rpm(catId, isShort) {
    if (isShort) return [0.03, 0.1];
    return TL.RPM[String(catId)] || [2, 6];
  },
  revenue(views, catId, isShort) {
    const [lo, hi] = TL.rpm(catId, isShort);
    return [(views / 1000) * lo, (views / 1000) * hi];
  },
  esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },
  send(type, payload) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (r) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!r) return reject(new Error('No response from PranIQ background'));
          r.ok ? resolve(r.data) : reject(new Error(r.error));
        });
      } catch (e) { reject(e); }
    });
  },
  copy(text) {
    return navigator.clipboard.writeText(text).catch(() => {
      const t = document.createElement('textarea');
      t.value = text; document.body.appendChild(t); t.select();
      document.execCommand('copy'); t.remove();
    });
  },
  outlierClass(x) {
    if (x >= 5) return 'tl-hot';
    if (x >= 2) return 'tl-good';
    if (x >= 1) return 'tl-ok';
    return 'tl-low';
  },

  // ---- v2 helpers ----
  DECAY: 0.45,
  // estimated cumulative views of a video at age t (hours) given views V now at age A
  viewsAt(V, A, t) { if (t <= 0) return 0; if (t >= A) return V; return V * Math.pow(t / A, TL.DECAY); },
  // estimated views a video gained within the last `days` days
  gainedLast(V, A, days) { const h = days * 24; if (A <= h) return V; return V - TL.viewsAt(V, A, A - h); },
  parseKeywords(str) {
    if (!str) return [];
    const out = []; const re = /"([^"]+)"|(\S+)/g; let m;
    while ((m = re.exec(str))) out.push(m[1] || m[2]);
    return out;
  },
  md(text) {
    const lines = TL.esc(text || '').split('\n');
    let html = '', inList = false;
    for (let l of lines) {
      l = l.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|\s)\*(\S.+?)\*(?=\s|$)/g, '$1<i>$2</i>').replace(/`([^`]+)`/g, '<code>$1</code>');
      const li = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/);
      if (li) { if (!inList) { html += '<ul>'; inList = true; } html += `<li>${li[1]}</li>`; continue; }
      if (inList) { html += '</ul>'; inList = false; }
      const h = l.match(/^#{1,4}\s+(.*)/);
      if (h) html += `<div class="tl-mdh">${h[1]}</div>`;
      else if (l.trim()) html += `<p>${l}</p>`;
    }
    if (inList) html += '</ul>';
    return html;
  },
  parseJson(text) {
    const t = String(text || '').replace(/```(?:json)?/g, '').trim();
    const a = t.indexOf('['), o = t.indexOf('{');
    const start = a >= 0 && (o < 0 || a < o) ? a : o;
    const end = Math.max(t.lastIndexOf(']'), t.lastIndexOf('}'));
    return JSON.parse(t.slice(start, end + 1));
  },
  dateLbl(t) { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); },
  // series: [{points:[[x,y]], color, bars, dash, fill}]
  chart(series, o = {}) {
    const W = o.w || 560, H = o.h || 190, pl = 46, pr = 10, pt = 10, pb = 24;
    const all = series.flatMap((s) => s.points);
    if (!all.length) return '<div class="tl-muted tl-pad">Not enough data yet.</div>';
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    let x0 = Math.min(...xs), x1 = Math.max(...xs); if (x1 === x0) x1 = x0 + 1;
    const anyBars = series.some((s) => s.bars);
    if (anyBars) { const pad = (x1 - x0) / Math.max(series[0].points.length, 1) / 2; x0 -= pad; x1 += pad; }
    const y0 = 0, y1 = Math.max(...ys, 1) * 1.12;
    const X = (x) => pl + ((x - x0) / (x1 - x0)) * (W - pl - pr);
    const Y = (y) => H - pb - ((y - y0) / (y1 - y0)) * (H - pt - pb);
    const yf = o.yFmt || TL.fmt, xf = o.xFmt || TL.dateLbl;
    let g = '';
    for (let i = 0; i <= 3; i++) { const v = y0 + ((y1 - y0) * i) / 3; g += `<line x1="${pl}" x2="${W - pr}" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" class="tlc-grid"/><text x="${pl - 6}" y="${(Y(v) + 3).toFixed(1)}" text-anchor="end" class="tlc-lbl">${yf(v)}</text>`; }
    for (let i = 0; i <= 4; i++) { const v = x0 + ((x1 - x0) * i) / 4; g += `<text x="${X(v).toFixed(1)}" y="${H - 7}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}" class="tlc-lbl">${xf(v)}</text>`; }
    let body = '';
    series.forEach((s) => {
      const pts = [...s.points].sort((a, b) => a[0] - b[0]);
      if (s.bars) {
        const bw = Math.max(1.5, ((W - pl - pr) / Math.max(pts.length, 1)) * 0.7);
        pts.forEach((p) => (body += `<rect x="${(X(p[0]) - bw / 2).toFixed(1)}" y="${Y(p[1]).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, H - pb - Y(p[1])).toFixed(1)}" fill="${s.color}" rx="1"><title>${xf(p[0])}: ${yf(p[1])}</title></rect>`));
      } else if (pts.length) {
        const d = pts.map((p, i) => (i ? 'L' : 'M') + X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
        if (s.fill !== false && pts.length > 1) body += `<path d="${d} L${X(pts[pts.length - 1][0]).toFixed(1)},${H - pb} L${X(pts[0][0]).toFixed(1)},${H - pb} Z" fill="${s.color}" opacity=".16"/>`;
        body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" ${s.dash ? 'stroke-dasharray="5 4"' : ''}/>`;
        if (s.dots) pts.forEach((p) => (body += `<circle cx="${X(p[0]).toFixed(1)}" cy="${Y(p[1]).toFixed(1)}" r="3" fill="${s.color}"><title>${xf(p[0])}: ${yf(p[1])}</title></circle>`));
      }
    });
    return `<svg class="tlc" viewBox="0 0 ${W} ${H}">${g}${body}</svg>`;
  },
  // Bucket [{t, value}] into evenly spaced buckets between from..to
  bucket(items, from, to, stepMs) {
    const n = Math.max(1, Math.ceil((to - from) / stepMs));
    const arr = Array.from({ length: n }, (_, i) => [from + i * stepMs, 0]);
    items.forEach((it) => { const i = Math.floor((it.t - from) / stepMs); if (i >= 0 && i < n) arr[i][1] += it.value; });
    return arr;
  },
  estGained(rows, T1, T2, now = Date.now()) {
    let s = 0;
    for (const r of rows) {
      const A = (now - r.t) / 36e5; if (A <= 0) continue;
      const a2 = Math.min((T2 - r.t) / 36e5, A), a1 = Math.max(0, (T1 - r.t) / 36e5);
      if (a2 <= a1) continue;
      s += TL.viewsAt(r.views, A, a2) - TL.viewsAt(r.views, A, a1);
    }
    return Math.max(0, s);
  },
  rangeCfg(r) {
    const D = 864e5;
    return { '7D': [7 * D, D], '30D': [30 * D, D], '3M': [91 * D, 7 * D], '6M': [182 * D, 7 * D], '1Y': [365 * D, 30 * D], 'ALL': [null, 30 * D] }[r] || [30 * D, D];
  },
  seo(v) {
    const sn = (v && v.snippet) || {};
    const title = sn.title || '', desc = sn.description || '', tags = sn.tags || [];
    const checks = [];
    const add = (label, ok, pts, tip) => checks.push({ label, ok: !!ok, pts, tip });
    const kw = (tags[0] || '').toLowerCase();
    const tagChars = tags.join(',').length;
    add(`Title length 40–70 chars (${title.length})`, title.length >= 40 && title.length <= 70, 15, 'Keep titles 40–70 characters so they are not cut off.');
    add(`5+ tags (${tags.length})`, tags.length >= 5, 10, 'Add more relevant tags, from broad to specific.');
    add(`Tags use 200–500 chars (${tagChars})`, tagChars >= 200 && tagChars <= 500, 10, 'Use most of the 500-character tag budget.');
    add(`Description 250+ chars (${desc.length})`, desc.length >= 250, 15, 'Write a fuller description with your keywords.');
    add('Main keyword (first tag) in title', kw && title.toLowerCase().includes(kw), 15, 'Put your main keyword in the title.');
    add('Main keyword in description', kw && desc.toLowerCase().includes(kw), 10, 'Mention the main keyword in the description.');
    add('Main keyword in first 150 chars', kw && desc.slice(0, 150).toLowerCase().includes(kw), 5, 'Use the keyword early in the description.');
    add('Chapters / timestamps', /(^|\s)0?0:00(\s|$)/m.test(desc), 5, 'Add chapters starting at 0:00.');
    add('Hashtags in description', /#[\p{L}\d_]+/u.test(desc), 5, 'Add 2–3 hashtags.');
    add('Links / call to action', /https?:\/\//.test(desc), 5, 'Add links (socials, related videos, products).');
    add('HD custom thumbnail', !!(sn.thumbnails && sn.thumbnails.maxres), 5, 'Upload a 1280×720 thumbnail.');
    const score = checks.reduce((a, c) => a + (c.ok ? c.pts : 0), 0);
    return { score, checks };
  }
};
if (typeof self !== 'undefined') self.TL = TL;

// ---------- Video Pack rendering (shared by YouTube pages and the popup) ----------
TL.packText = (p) => {
  const L = [];
  L.push('TOPIC: ' + (p.topic || ''));
  L.push('\nTITLES:\n' + (p.titles || []).map((t) => `- ${t.title || t}${t.score ? ` (${t.score})` : ''}`).join('\n'));
  if (p.thumbnailText) L.push('\nTHUMBNAIL TEXT: ' + p.thumbnailText.join(' | '));
  L.push('\nHOOK:\n' + (p.hook || ''));
  L.push('\nSCRIPT:\n' + (p.script || ''));
  L.push('\nSCENES:\n' + (p.scenes || []).map((s) => `[${s.time || ''}] ${s.narration || ''}\n  Visual: ${s.visual || ''}\n  Image prompt: ${s.imagePrompt || ''}`).join('\n'));
  L.push('\nDESCRIPTION:\n' + (p.description || ''));
  L.push('\nTAGS:\n' + (p.tags || []).join(', '));
  L.push('\nPINNED COMMENT:\n' + (p.pinnedComment || ''));
  if (p.music) L.push('\nMUSIC: ' + p.music);
  if (p.shorts) L.push('\nSHORTS SPIN-OFFS:\n' + p.shorts.map((s) => '- ' + s).join('\n'));
  return L.join('\n');
};
TL.packHtml = (p) => {
  const E = TL.esc;
  const cp = (k, label = 'Copy') => `<button class="pk-cp" data-cp="${k}">${label}</button>`;
  const read = Math.max(1, Math.round((p.words || 0) / 150));
  return `<div class="pk">
  <div class="pk-bar"><b>${E(p.topic || '')}</b><span class="pk-mu">${p.words || 0} words · ~${read} min read · ${E(p.model || '')}</span>
    <span class="pk-sp"></span>${cp('all', 'Copy all')}<button class="pk-cp" data-dl="1">⬇ .txt</button><button class="pk-cp" data-say="1">▶ Listen</button></div>
  <div class="pk-h">Titles ${cp('titles')}</div>
  ${(p.titles || []).map((t, i) => `<div class="pk-row"><span class="pk-sc">${t.score ?? ''}</span><span class="pk-t">${E(t.title || t)}</span><button class="pk-cp" data-cpt="${i}">⧉</button></div>`).join('')}
  ${p.thumbnailText ? `<div class="pk-h">Thumbnail text</div><div class="pk-chips">${p.thumbnailText.map((t) => `<span class="pk-chip">${E(t)}</span>`).join('')}</div>` : ''}
  <div class="pk-h">Hook ${cp('hook')}</div><div class="pk-box">${E(p.hook || '')}</div>
  <div class="pk-h">Script ${cp('script')}</div><div class="pk-box pk-scroll">${E(p.script || '').replace(/\n/g, '<br>')}</div>
  <div class="pk-h">Scenes & image prompts ${cp('prompts', 'Copy prompts')}</div>
  <div class="pk-scroll">${(p.scenes || []).map((s) => `<div class="pk-scene"><b>${E(s.time || '')}</b> ${E(s.narration || '')}<div class="pk-mu">🎬 ${E(s.visual || '')}</div><div class="pk-mu">🖼 ${E(s.imagePrompt || '')}</div></div>`).join('')}</div>
  <div class="pk-h">Description ${cp('description')}</div><div class="pk-box pk-scroll">${E(p.description || '').replace(/\n/g, '<br>')}</div>
  <div class="pk-h">Tags ${cp('tags')}</div><div class="pk-chips">${(p.tags || []).map((t) => `<span class="pk-chip">${E(t)}</span>`).join('')}</div>
  <div class="pk-h">Pinned comment ${cp('pinnedComment')}</div><div class="pk-box">${E(p.pinnedComment || '')}</div>
  ${p.music ? `<div class="pk-mu" style="margin-top:6px">🎵 Music mood: ${E(p.music)}</div>` : ''}
  ${p.shorts ? `<div class="pk-h">Shorts spin-offs</div><ul>${p.shorts.map((s) => `<li>${E(s)}</li>`).join('')}</ul>` : ''}
  <div class="pk-mu" style="margin-top:8px">Saved. Open YouTube Studio's upload/edit page and use the PranIQ button to fill title, description and tags.</div>
</div>`;
};
TL.bindPack = (root, p) => {
  const val = (k) => k === 'all' ? TL.packText(p) : k === 'titles' ? (p.titles || []).map((t) => t.title || t).join('\n')
    : k === 'tags' ? (p.tags || []).join(', ') : k === 'prompts' ? (p.scenes || []).map((s) => s.imagePrompt).join('\n\n') : String(p[k] || '');
  const fl = (b) => { const o = b.textContent; b.textContent = '✓'; setTimeout(() => (b.textContent = o), 1000); };
  root.querySelectorAll('[data-cp]').forEach((b) => (b.onclick = () => { TL.copy(val(b.dataset.cp)); fl(b); }));
  root.querySelectorAll('[data-cpt]').forEach((b) => (b.onclick = () => { const t = p.titles[+b.dataset.cpt]; TL.copy(t.title || t); fl(b); }));
  root.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = () => TL.download((p.topic || 'video').replace(/[^\w\- ]+/g, '').slice(0, 50) + '.txt', TL.packText(p))));
  root.querySelectorAll('[data-say]').forEach((b) => (b.onclick = () => {
    if (!self.speechSynthesis) return;
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); b.textContent = '▶ Listen'; return; }
    const u = new SpeechSynthesisUtterance((p.hook || '') + '\n' + (p.script || ''));
    u.rate = 1.02; u.onend = () => (b.textContent = '▶ Listen');
    speechSynthesis.speak(u); b.textContent = '■ Stop';
  }));
};
TL.download = (name, text, type = 'text/plain') => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
};
TL.csv = (rows) => rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');

TL.CONTACT_URL = 'https://wa.me/9779700720101?text=Hi%20Pranish%21%20I%20am%20using%20your%20PranIQ%20YouTube%20extension.%20I%20want%20more%20tools%20and%20info%20about%20this%20type%20of%20extension.';
TL.creditHtml = () => '<div class="pq-credit">Made by <b>Pranish Kharal</b><a class="pq-wa" href="https://wa.me/9779700720101?text=Hi%20Pranish%21%20I%20am%20using%20your%20PranIQ%20YouTube%20extension.%20I%20want%20more%20tools%20and%20info%20about%20this%20type%20of%20extension." target="_blank" rel="noopener" title="WhatsApp Pranish for more tools"><svg viewBox="0 0 32 32" width="16" height="16" aria-hidden="true"><path fill="#fff" d="M16 3C8.8 3 3 8.7 3 15.8c0 2.5.7 4.9 2 6.9L3 29l6.5-2c1.9 1 4.1 1.6 6.5 1.6 7.2 0 13-5.7 13-12.8S23.2 3 16 3zm0 23.3c-2.1 0-4.1-.6-5.8-1.7l-.4-.3-3.9 1.2 1.2-3.7-.3-.4c-1.2-1.8-1.8-3.8-1.8-5.9C5 9.9 10 5.1 16 5.1s11 4.8 11 10.7-5 10.5-11 10.5zm6-7.9c-.3-.2-1.9-.9-2.2-1-.3-.1-.5-.2-.7.2-.2.3-.8 1-1 1.2-.2.2-.4.2-.7.1-.3-.2-1.4-.5-2.6-1.6-1-.9-1.6-1.9-1.8-2.2-.2-.3 0-.5.1-.7l.5-.6c.2-.2.2-.3.3-.6.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4-.3.3-1.2 1.1-1.2 2.7s1.2 3.2 1.4 3.4c.2.2 2.4 3.6 5.8 5 2.9 1.1 3.4.9 4 .8.6-.1 1.9-.8 2.2-1.5.3-.7.3-1.4.2-1.5-.1-.1-.3-.2-.6-.4z"/></svg><span>WhatsApp me for more tools</span></a></div>';
