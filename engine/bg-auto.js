// PranIQ automation pack (loaded by background.js): niche finder, video packs, Shorts finder,
// thumbnail AI, bulk keywords, competitor alerts, daily niche feed.

const PACK_SYS = 'You are PranIQ Studio, an expert scriptwriter and YouTube strategist for faceless / automation channels. You write ORIGINAL content: never copy sentences from a source, only learn its topic, structure and why it worked. Output valid JSON only when asked for JSON.';

async function thumbB64(videoId) {
  for (const q of ['maxresdefault', 'sddefault', 'hqdefault']) {
    try {
      const r = await fetch(`https://i.ytimg.com/vi/${videoId}/${q}.jpg`);
      if (!r.ok) continue;
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf.length < 3000) continue; // grey placeholder
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
      return { mime: 'image/jpeg', data: btoa(bin) };
    } catch (e) {}
  }
  throw new Error('Could not load the thumbnail');
}

async function savePack(pack) {
  const { packs = [] } = await chrome.storage.local.get('packs');
  pack.id = 'p' + Date.now();
  pack.t = Date.now();
  packs.unshift(pack);
  await chrome.storage.local.set({ packs: packs.slice(0, 25) });
  return pack;
}

async function suggest(q) {
  try {
    const r = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=' + encodeURIComponent(q));
    return (JSON.parse(await r.text())[1] || []);
  } catch (e) { return []; }
}

Object.assign(handlers, {
  /* ---------- Niche Finder: small/new channels pulling big views ---------- */
  async nicheFind({ q, maxAgeMonths = 12, maxSubs = 100000, days = 90 }) {
    q = String(q || '').trim();
    if (!q) throw new Error('Enter a niche or topic');
    const s = await yt('search', { part: 'snippet', type: 'video', q, order: 'viewCount', maxResults: 50, publishedAfter: new Date(Date.now() - days * 864e5).toISOString() });
    const vids = await videos((s.items || []).map((i) => i.id.videoId));
    const chs = await channels(vids.map((v) => v.snippet.channelId));
    const cmap = Object.fromEntries(chs.map((c) => [c.id, c]));
    const rows = vids.map((v) => videoRow(v, cmap[v.snippet.channelId]));
    const byCh = {};
    rows.forEach((r) => (byCh[r.channelId] = byCh[r.channelId] || []).push(r));
    const now = Date.now();
    const all = Object.entries(byCh).map(([id, rs]) => {
      const c = cmap[id];
      if (!c) return null;
      const subs = subsOf(c);
      const views = +c.statistics.viewCount || 0;
      const vcount = +c.statistics.videoCount || 0;
      const ageDays = Math.max(1, (now - new Date(c.snippet.publishedAt)) / 864e5);
      const best = rs.sort((a, b) => b.views - a.views)[0];
      const shorts = rs.filter((r) => r.isShort).length / rs.length;
      const [lo, hi] = TL.rpm(best.cat, shorts > 0.5);
      const perDay = views / ageDays;
      return {
        id, title: c.snippet.title, thumb: (c.snippet.thumbnails.default || {}).url, subs, views, videos: vcount,
        ageDays: Math.round(ageDays), created: c.snippet.publishedAt, perDay, perVideo: vcount ? views / vcount : 0,
        estMonthly: [(perDay * 30 / 1000) * lo, (perDay * 30 / 1000) * hi],
        best: { id: best.id, title: best.title, views: best.views, thumb: best.thumb, isShort: best.isShort },
        hits: rs.length, shorts
      };
    }).filter(Boolean);
    const fresh = all.filter((c) => c.ageDays <= maxAgeMonths * 30.5 && (c.subs === null || c.subs <= maxSubs))
      .sort((a, b) => b.perDay - a.perDay);
    const big = rows.filter((r) => r.subs !== null && r.subs >= 1000000).length;
    const smallWin = rows.filter((r) => r.subs !== null && r.subs < 100000).length;
    const medViews = TL.median(rows.map((r) => r.views));
    const saturation = rows.length ? big / rows.length : 0;
    const demand = Math.min(1, Math.log10(medViews + 1) / 6.3);
    const newBlood = Math.min(1, fresh.length / 8);
    const score = Math.round(100 * (0.4 * demand + 0.3 * (1 - saturation) + 0.3 * newBlood));
    const verdict = score >= 65 ? 'Go' : score >= 45 ? 'Maybe' : 'Skip';
    const shortShare = rows.length ? rows.filter((r) => r.isShort).length / rows.length : 0;
    const medLen = TL.median(rows.filter((r) => !r.isShort).map((r) => r.dur));
    return { q, score, verdict, demand, saturation, medViews, smallWin, total: rows.length, newChannels: fresh.length, shortShare, medLen, channels: fresh.slice(0, 20) };
  },

  async nicheSave({ q, remove }) {
    let { niches = [] } = await chrome.storage.local.get('niches');
    q = String(q || '').trim().toLowerCase();
    niches = niches.filter((n) => n !== q);
    if (!remove && q) niches.unshift(q);
    niches = niches.slice(0, 5);
    await chrome.storage.local.set({ niches });
    return niches;
  },

  async nicheFeed({ refresh } = {}) {
    const { niches = [], feed = { t: 0, items: [] } } = await chrome.storage.local.get(['niches', 'feed']);
    if (!refresh) return { niches, feed };
    const items = [];
    for (const q of niches) {
      try {
        const d = await handlers.outliers({ q, days: 7, maxSubs: 0, duration: 'any', minRatio: 3 });
        (d.rows || []).slice(0, 8).forEach((r) => items.push({ ...r, niche: q }));
      } catch (e) { if (/quota|used up/i.test(e.message)) break; }
    }
    const seen = new Set();
    const uniq = items.filter((r) => !seen.has(r.id) && seen.add(r.id)).sort((a, b) => (b.outlier || b.ratio || 0) - (a.outlier || a.ratio || 0));
    const out = { t: Date.now(), items: uniq.slice(0, 40) };
    await chrome.storage.local.set({ feed: out });
    return { niches, feed: out };
  },

  /* ---------- One-click Video Pack ---------- */
  async videoPack({ videoId, topic, minutes = 8, style = '', shorts = false }) {
    let src = '';
    if (videoId) {
      const v = (await videos([videoId]))[0];
      if (!v) throw new Error('Video not found');
      const tr = await transcriptText(videoId, 9000);
      src = `SOURCE VIDEO (learn from it, do NOT copy it)
Title: ${v.snippet.title}
Views: ${v.statistics.viewCount} | Published: ${TL.ago(v.snippet.publishedAt)} | Channel: ${v.snippet.channelTitle}
Description: ${(v.snippet.description || '').slice(0, 600)}
Transcript: ${tr || '(not available)'}`;
      topic = topic || v.snippet.title;
    }
    if (!topic) throw new Error('Enter a topic');
    const words = shorts ? 120 : Math.round(minutes * 150);
    const prompt = `${src}

Create a complete, ORIGINAL YouTube ${shorts ? 'Short (under 50 seconds)' : `video (~${minutes} minutes, ~${words} words of narration)`} about: "${topic}".
${style ? 'Style / channel notes: ' + style : 'Format: faceless narration with stock footage / AI images.'}
${src ? 'Use a fresh angle that can beat the source video.' : ''}
Return ONLY JSON with this shape:
{"titles":[{"title":"max 70 chars","score":0-100}] (5 items),
"thumbnailText":["2-4 words"] (3 items),
"hook":"first 15 seconds, word for word",
"script":"the full narration, ${words} words, in short paragraphs separated by \\n\\n",
"scenes":[{"time":"0:00","narration":"line","visual":"what is on screen","imagePrompt":"detailed AI image prompt"}] (8-14 items for long, 5-7 for Shorts),
"description":"SEO description with hook lines, summary, chapters starting 0:00, call to action, 3 hashtags",
"tags":["tag"] (15-25, total under 480 chars),
"pinnedComment":"engaging question",
"music":"background music mood",
"shorts":["Short idea spun off this video"] (3 items)}`;
    const r = await gemini(prompt, PACK_SYS, { json: true, maxTokens: 16000 });
    let p;
    try { p = TL.parseJson(r.text); } catch (e) { throw new Error('The AI reply was cut off or not valid. Try again or pick a shorter length.'); }
    p.topic = topic; p.model = r.model; p.source = videoId || null; p.minutes = shorts ? 0.8 : minutes;
    p.words = String(p.script || '').split(/\s+/).filter(Boolean).length;
    return savePack(p);
  },

  async packList() {
    const { packs = [] } = await chrome.storage.local.get('packs');
    return packs;
  },

  async packDelete({ id }) {
    let { packs = [] } = await chrome.storage.local.get('packs');
    packs = packs.filter((p) => p.id !== id);
    await chrome.storage.local.set({ packs });
    return packs;
  },

  /* ---------- Script rewriter ---------- */
  async rewriteScript({ videoId, angle = '', minutes = 0 }) {
    const tr = await transcriptText(videoId, 14000);
    if (!tr) throw new Error('No transcript available for this video, so there is nothing to rewrite.');
    const v = (await videos([videoId]))[0];
    const r = await gemini(`Original video: "${v.snippet.title}"
TRANSCRIPT:
${tr}

Rewrite this into a brand-new ORIGINAL narration script on the same topic${angle ? ' with this angle: ' + angle : ''}. Different wording and structure, stronger hook in the first 2 lines, an open loop every ~60 seconds, a clear ending with a call to action.${minutes ? ` Target ~${minutes * 150} words.` : ' Keep a similar length.'}
Format: a title line starting with "# ", then the script in short paragraphs. At the end add "Word count: N, read time: M min".`, PACK_SYS, { maxTokens: 12000 });
    return { text: r.text, model: r.model };
  },

  /* ---------- Shorts finder ---------- */
  async shortsClips({ videoId }) {
    const t = await handlers.transcript({ videoId });
    const lines = t.lines.map((l) => `[${l.t}] ${l.text}`).join('\n').slice(0, 30000);
    const r = await gemini(`Transcript with start times in seconds:
${lines}

Find the 5 best moments to cut into YouTube Shorts (each 20-58 seconds, self-contained, strong first line). Return ONLY JSON:
[{"start":123,"end":170,"title":"Shorts title max 60 chars","hook":"opening line on screen","why":"why it works","score":0-100}]`, PACK_SYS, { json: true });
    let clips = [];
    try { clips = TL.parseJson(r.text); } catch (e) { throw new Error('AI reply was not valid. Try again.'); }
    return { clips: clips.sort((a, b) => (b.score || 0) - (a.score || 0)), model: r.model };
  },

  /* ---------- Thumbnail AI ---------- */
  async thumbAnalyze({ videoId }) {
    const v = (await videos([videoId]))[0];
    const img = await thumbB64(videoId);
    const r = await gemini(`This is the thumbnail of the YouTube video "${v.snippet.title}" (${v.statistics.viewCount} views).
Rate it as a YouTube thumbnail. Return ONLY JSON:
{"score":0-100,"textOnImage":"text you can read or empty","readableOnMobile":true,"focalPoint":"what draws the eye","emotion":"emotion shown","contrast":"low|medium|high","clutter":"low|medium|high","strengths":["..."],"fixes":["specific, actionable fix"],"altIdeas":["new thumbnail concept with text overlay"]}`, PACK_SYS, { images: [img], json: true });
    let a;
    try { a = TL.parseJson(r.text); } catch (e) { throw new Error('AI reply was not valid. Try again.'); }
    return { ...a, model: r.model };
  },

  /* ---------- Bulk keywords (free: uses YouTube autocomplete only) ---------- */
  async bulkKeywords({ q }) {
    q = String(q || '').trim().toLowerCase();
    if (!q) throw new Error('Enter a seed keyword');
    const seeds = [q, ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => q + ' ' + c),
      ...['how to', 'why', 'what', 'best', 'top', 'is', 'can', 'vs'].map((p) => p + ' ' + q), q + ' for beginners', q + ' 2026'];
    const found = new Map();
    for (let i = 0; i < seeds.length; i += 6) {
      const res = await Promise.all(seeds.slice(i, i + 6).map(suggest));
      res.forEach((list, j) => list.forEach((k, pos) => {
        k = k.toLowerCase();
        const o = found.get(k) || { k, hits: 0, best: 99 };
        o.hits++; o.best = Math.min(o.best, pos + 1);
        if (seeds[i + j] === q) o.direct = true;
        found.set(k, o);
      }));
    }
    const rows = [...found.values()].map((o) => ({
      ...o, words: o.k.split(/\s+/).length,
      // popularity proxy: shows higher in autocomplete and under more seeds = more searched
      pop: Math.min(100, Math.round((o.direct ? 30 : 0) + (11 - Math.min(o.best, 10)) * 5 + o.hits * 8))
    })).sort((a, b) => b.pop - a.pop);
    return { q, rows };
  },

  /* ---------- Competitor alerts ---------- */
  async checkAlerts({ manual } = {}) {
    const { tracked = [], alerted = {}, alertsOn } = await chrome.storage.local.get(['tracked', 'alerted', 'alertsOn']);
    if (!tracked.length || alertsOn === false) return { found: [] };
    const chs = await channels(tracked.map((t) => t.id));
    const found = [];
    for (const ch of chs) {
      let vids = [];
      try { vids = await uploads(ch, 15); } catch (e) { continue; }
      const long = vids.filter((v) => TL.hoursSince(v.snippet.publishedAt) > 24);
      const med = TL.median(long.map((v) => +v.statistics.viewCount || 0)) || 1;
      vids.filter((v) => TL.hoursSince(v.snippet.publishedAt) <= 7 * 24).forEach((v) => {
        const A = TL.hoursSince(v.snippet.publishedAt);
        const typ = TL.median(long.map((x) => TL.viewsAt(+x.statistics.viewCount || 0, TL.hoursSince(x.snippet.publishedAt), A))) || med;
        const x = (+v.statistics.viewCount || 0) / Math.max(1, typ);
        if (x >= 2.5 && !alerted[v.id]) {
          found.push({ id: v.id, title: v.snippet.title, channel: ch.snippet.title, x, views: +v.statistics.viewCount || 0 });
          alerted[v.id] = Date.now();
        }
      });
    }
    for (const k in alerted) if (Date.now() - alerted[k] > 30 * 864e5) delete alerted[k];
    await chrome.storage.local.set({ alerted });
    const { alertLog = [] } = await chrome.storage.local.get('alertLog');
    await chrome.storage.local.set({ alertLog: [...found.map((f) => ({ ...f, t: Date.now() })), ...alertLog].slice(0, 50) });
    for (const f of found.slice(0, 3)) {
      chrome.notifications && chrome.notifications.create('tlv_' + f.id, {
        type: 'basic', iconUrl: 'icons/icon128.png', title: `🔥 ${f.channel}: ${f.x.toFixed(1)}x outlier`,
        message: `${f.title}\n${TL.fmt(f.views)} views — beating their usual video. Click to open.`, priority: 1
      });
    }
    return { found };
  },

  async alertLog() {
    const { alertLog = [], alertsOn } = await chrome.storage.local.get(['alertLog', 'alertsOn']);
    return { log: alertLog, on: alertsOn !== false };
  },

  async alertsToggle({ on }) {
    await chrome.storage.local.set({ alertsOn: !!on });
    return { on: !!on };
  }
});

// Extra AI tools for the popup
const _aiTool = handlers.aiTool;
handlers.aiTool = async (p) => {
  const extra = {
    hooks: `Write 10 scroll-stopping opening hooks (first 5-10 seconds, word for word) for a YouTube video about "${p.topic}". Mix curiosity, shock, stakes and story openers.`,
    comment: `Write 5 pinned-comment ideas that drive replies for a YouTube video about "${p.topic}".`,
    channel: `Plan a new faceless YouTube channel in the niche "${p.topic}": 5 channel name ideas, a one-line positioning, target audience, content pillars, video format and length, upload schedule, 15 first video titles, and how to monetize beyond AdSense.`,
    calendar: `Make a 30-day upload calendar for a YouTube channel about "${p.topic}" as a table: day, format (long or Short), title, hook idea. Mix searchable videos and trend videos.`
  }[p.kind];
  if (!extra) return _aiTool(p);
  const res = await gemini(extra, PACK_SYS);
  return { text: res.text, model: res.model };
};

chrome.notifications && chrome.notifications.onClicked.addListener((id) => {
  if (id.startsWith('tlv_')) chrome.tabs.create({ url: 'https://www.youtube.com/watch?v=' + id.slice(4) });
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('alerts', { periodInMinutes: 180 });
  chrome.alarms.create('feed', { periodInMinutes: 1440 });
});

chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'alerts') handlers.checkAlerts().catch(() => {});
  if (a.name === 'feed') {
    try {
      const { feed } = await handlers.nicheFeed({ refresh: true });
      if (feed.items.length && chrome.notifications) {
        chrome.notifications.create('tl_feed', { type: 'basic', iconUrl: 'icons/icon128.png', title: 'PranIQ: new outliers in your niches', message: `${feed.items.length} videos are beating their channel's normal views this week. Open PranIQ → Niche.` });
      }
    } catch (e) {}
  }
});
