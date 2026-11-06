// PranIQ background service worker: all YouTube Data API calls live here.
importScripts('utils.js');

const API = 'https://www.googleapis.com/youtube/v3/';
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

// ---- Multi-key rotation: keys are stored one per line; a key that runs out rests until its quota resets.
const parseKeys = (v) => [...new Set(String(v || '').split(/[\s,;]+/).map((x) => x.trim()).filter((x) => x.length > 20))];
function nextResetPT() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const m = new Date(pt); m.setHours(24, 0, 0, 0);
  return m.getTime() + (now - pt);
}

function datePT() {
  const now = new Date();
  const pt = new Date(now.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return pt.getFullYear() + '-' + String(pt.getMonth() + 1).padStart(2, '0') + '-' + String(pt.getDate()).padStart(2, '0');
}

function hashKey(k) {
  if (typeof crypto !== 'undefined' && crypto.createHash) {
    return crypto.createHash('sha256').update(String(k)).digest('hex').slice(0, 16);
  }
  let h = 0;
  for (let i = 0; i < k.length; i++) { h = ((h << 5) - h) + k.charCodeAt(i); h |= 0; }
  return 'k_' + Math.abs(h).toString(36);
}

async function getQuotaTracker() {
  const { quota_yt = {} } = await chrome.storage.local.get('quota_yt');
  const today = datePT();
  if (quota_yt.date !== today) {
    return { date: today, keys: {} };
  }
  return quota_yt;
}

async function recordUsage(key, endpoint) {
  const tracker = await getQuotaTracker();
  const isSearch = endpoint === 'search';
  const cost = isSearch ? 100 : 1;
  const keyId = hashKey(key);
  const entry = (tracker.keys && tracker.keys[keyId]) || { searches: 0, units: 0, lastCall: Date.now() };
  entry.searches += (isSearch ? 1 : 0);
  entry.units += cost;
  entry.lastCall = Date.now();
  if (!tracker.keys) tracker.keys = {};
  tracker.keys[keyId] = entry;
  await chrome.storage.local.set({ quota_yt: tracker });
  if (entry.units >= 10000 || entry.searches >= 100) {
    await rest('yt', key, nextResetPT());
  }
  return entry;
}

async function getActiveQuotaWarning() {
  try {
    const ytKeys = parseKeys((await chrome.storage.sync.get('apiKey')).apiKey);
    if (!ytKeys.length) return null;
    const rYt = await restMap('yt');
    const liveKeys = ytKeys.filter((k) => !rYt[k]);
    if (!liveKeys.length) {
      return '⚠️ All YouTube API keys are resting or exhausted. Quota resets at midnight Pacific Time.';
    }
    const tracker = await getQuotaTracker();
    let nearLimitCount = 0;
    let totalSearchesLeft = 0;
    for (const k of liveKeys) {
      const keyId = hashKey(k);
      const u = (tracker.keys && tracker.keys[keyId]) || { searches: 0, units: 0 };
      const left = Math.max(0, 100 - u.searches);
      totalSearchesLeft += left;
      if (u.searches >= 85 || u.units >= 8500) {
        nearLimitCount++;
      }
    }
    if (nearLimitCount === liveKeys.length) {
      const resetMs = nextResetPT() - Date.now();
      const hours = Math.floor(resetMs / 3600000);
      const mins = Math.floor((resetMs % 3600000) / 60000);
      return `⚠️ YouTube search quota is nearly exhausted (~${totalSearchesLeft} searches left today across ${liveKeys.length} active key(s)). Quota resets in ${hours}h ${mins}m at midnight Pacific Time. Cached results remain free.`;
    }
  } catch {}
  return null;
}

async function restMap(name) {
  const k = 'rest_' + name;
  const o = (await chrome.storage.local.get(k))[k] || {};
  const now = Date.now();
  for (const x in o) if (o[x] < now) delete o[x];
  return o;
}
async function rest(name, key, until) {
  const o = await restMap(name); o[key] = until;
  await chrome.storage.local.set({ ['rest_' + name]: o });
}
async function keyPool(field, name) {
  const all = parseKeys((await chrome.storage.sync.get(field))[field]);
  if (!all.length) throw new Error(name === 'yt' ? 'NEEDS_YOUTUBE_KEY' : 'NEEDS_GEMINI_KEY');
  const resting = await restMap(name);
  const live = all.filter((k) => !resting[k]);
  // start from the key that worked last so we don't burn the first key every time
  const { ['last_' + name]: last } = await chrome.storage.local.get('last_' + name);
  const i = live.indexOf(last);
  return { all, live: i > 0 ? [...live.slice(i), ...live.slice(0, i)] : live };
}
const ok = (name, key) => chrome.storage.local.set({ ['last_' + name]: key });

async function ytOnce(url, key) {
  url.searchParams.set('key', key);
  const r = await fetch(url);
  return r.json();
}

const SEARCH_CACHE_MS = 24 * 60 * 60 * 1000; // 24 hours
const STATS_CACHE_MS = 6 * 60 * 60 * 1000;   // 6 hours

async function yt(endpoint, params, keyOverride) {
  const url = new URL(API + endpoint);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && k[0] !== '_') url.searchParams.set(k, v);
  const ck = url.toString();
  const ttl = endpoint === 'search' ? SEARCH_CACHE_MS : STATS_CACHE_MS;

  // 1. Check disk cache, then in-memory cache
  if (!params._nocache) {
    if (typeof __diskCache !== 'undefined') {
      const diskHit = __diskCache.get(ck);
      if (diskHit) return diskHit;
    }
    const memHit = cache.get(ck);
    if (memHit && Date.now() - memHit.t < ttl) return memHit.d;
  }

  const pool = keyOverride ? { all: [keyOverride], live: [keyOverride] } : await keyPool('apiKey', 'yt');
  let lastErr = null;
  for (const key of pool.live) {
    const d = await ytOnce(new URL(ck), key);
    if (d.error) {
      const reason = d.error.errors && d.error.errors[0] && d.error.errors[0].reason;
      if (!keyOverride && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) { await rest('yt', key, nextResetPT()); lastErr = 'quota'; continue; }
      if (!keyOverride && (reason === 'keyInvalid' || /API key not valid/i.test(d.error.message || ''))) { await rest('yt', key, Date.now() + 864e5); lastErr = 'invalid'; continue; }
      if (reason === 'quotaExceeded') throw new Error('This key\'s daily quota is used up. It resets at midnight Pacific time.');
      throw new Error(d.error.message || 'YouTube API error');
    }
    if (!keyOverride) {
      ok('yt', key);
      await recordUsage(key, endpoint);
    }
    // Store in disk cache and in memory cache
    if (typeof __diskCache !== 'undefined') {
      __diskCache.set(ck, d, ttl);
    }
    cache.set(ck, { t: Date.now(), d });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return d;
  }
  const n = pool.all.length;
  if (lastErr === 'invalid' && n === 1) throw new Error('Your YouTube key was rejected. Check it in your MCP or connector settings.');
  throw new Error(n > 1 ? `All ${n} YouTube keys are used up for today. They reset at midnight Pacific time.` : 'Daily YouTube API quota used up. It resets at midnight Pacific time. Add more keys in your MCP or connector settings to keep going.');
}

async function videos(ids) {
  ids = [...new Set(ids)].filter(Boolean);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await yt('videos', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    out.push(...(d.items || []));
  }
  return out;
}

async function channels(ids) {
  ids = [...new Set(ids)].filter(Boolean);
  const out = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await yt('channels', { part: 'snippet,statistics,contentDetails', id: ids.slice(i, i + 50).join(','), maxResults: 50 });
    out.push(...(d.items || []));
  }
  return out;
}

async function resolveChannel(input) {
  input = String(input || '').trim();
  if (!input) throw new Error('Enter a channel URL, @handle or name');
  let m;
  if ((m = input.match(/(UC[\w-]{22})/))) {
    const c = (await channels([m[1]]))[0];
    if (c) return c;
  }
  if ((m = input.match(/@([\w.\-]+)/)) || (m = input.match(/^([\w.\-]+)$/))) {
    const d = await yt('channels', { part: 'snippet,statistics,contentDetails', forHandle: '@' + m[1] });
    if (d.items && d.items.length) return d.items[0];
  }
  const s = await yt('search', { part: 'snippet', type: 'channel', q: input, maxResults: 1 });
  const it = s.items && s.items[0];
  const id = it && ((it.id && it.id.channelId) || it.snippet.channelId);
  if (!id) throw new Error('Channel not found');
  return (await channels([id]))[0];
}

async function uploads(ch, n = 50) {
  const pl = ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads;
  if (!pl) return [];
  const d = await yt('playlistItems', { part: 'contentDetails', playlistId: pl, maxResults: Math.min(50, n) });
  return videos((d.items || []).map((i) => i.contentDetails.videoId));
}

const subsOf = (c) => (!c || c.statistics.hiddenSubscriberCount ? null : +c.statistics.subscriberCount || 0);

function videoRow(v, ch) {
  const views = +v.statistics.viewCount || 0;
  const dur = TL.isoDur(v.contentDetails && v.contentDetails.duration);
  const isShort = dur > 0 && dur <= 60;
  const subs = subsOf(ch);
  const [revLo, revHi] = TL.revenue(views, v.snippet.categoryId, isShort);
  return {
    id: v.id,
    title: v.snippet.title,
    channel: v.snippet.channelTitle,
    channelId: v.snippet.channelId,
    thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default || {}).url,
    published: v.snippet.publishedAt,
    views,
    likes: +v.statistics.likeCount || 0,
    comments: +v.statistics.commentCount || 0,
    vph: views / TL.hoursSince(v.snippet.publishedAt),
    dur,
    isShort,
    cat: v.snippet.categoryId,
    subs,
    ratio: subs ? views / subs : null,
    revLo,
    revHi,
    tags: v.snippet.tags || []
  };
}

// Pull ytInitialPlayerResponse out of the watch page HTML
function extractJson(html, marker) {
  const i = html.indexOf(marker);
  if (i < 0) return null;
  let start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(html.slice(start, j + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

async function pageData(videoId) {
  const r = await fetch('https://www.youtube.com/watch?v=' + encodeURIComponent(videoId) + '&hl=en', { credentials: 'omit' });
  const html = await r.text();
  return extractJson(html, 'ytInitialPlayerResponse');
}

const handlers = {
  async keyStatus() {
    const ytKeys = parseKeys((await chrome.storage.sync.get('apiKey')).apiKey);
    const aiKeys = parseKeys((await chrome.storage.sync.get('geminiKey')).geminiKey);
    const rYt = await restMap('yt');
    const rAi = await restMap('ai');
    const tracker = await getQuotaTracker();
    const resetMs = nextResetPT() - Date.now();
    const resetHours = Math.floor(resetMs / 3600000);
    const resetMins = Math.floor((resetMs % 3600000) / 60000);
    const resetText = `${resetHours}h ${resetMins}m (resets at midnight Pacific Time)`;

    const mask = (k) => k.length > 8 ? k.slice(0, 4) + '...' + k.slice(-4) : '***';

    const ytKeyStats = ytKeys.map((k, idx) => {
      const isResting = !!rYt[k];
      const keyId = hashKey(k);
      const usage = (tracker.keys && tracker.keys[keyId]) || { searches: 0, units: 0, lastCall: null };
      const searchesLeft = Math.max(0, 100 - usage.searches);
      const unitsLeft = Math.max(0, 10000 - usage.units);
      return {
        key: `Key #${idx + 1} (${mask(k)})`,
        status: isResting ? 'RESTING (quota reached, resets at midnight PT)' : 'ACTIVE',
        dailySearches: `${usage.searches} / 100 (~${searchesLeft} remaining)`,
        dailyUnits: `${usage.units} / 10,000 (~${unitsLeft} remaining)`,
        percentUsed: `${Math.min(100, Math.round((usage.units / 10000) * 100))}%`,
        lastUsed: usage.lastCall ? new Date(usage.lastCall).toISOString() : 'not used today'
      };
    });

    const aiKeyStats = aiKeys.map((k, idx) => {
      const isResting = !!rAi[k];
      return {
        key: `Key #${idx + 1} (${mask(k)})`,
        status: isResting ? 'RESTING' : 'ACTIVE'
      };
    });

    const cacheStats = (typeof __diskCache !== 'undefined') ? __diskCache.stats() : { total: 0, search: 0, stats: 0 };

    return {
      youtube: {
        totalKeys: ytKeys.length,
        activeKeys: ytKeys.filter((k) => !rYt[k]).length,
        restingKeys: ytKeys.filter((k) => rYt[k]).length,
        datePT: tracker.date || datePT(),
        resetsIn: resetText,
        keys: ytKeyStats
      },
      gemini: {
        totalKeys: aiKeys.length,
        activeKeys: aiKeys.filter((k) => !rAi[k]).length,
        restingKeys: aiKeys.filter((k) => rAi[k]).length,
        keys: aiKeyStats
      },
      diskCache: {
        totalEntries: cacheStats.total,
        searchQueriesCached: `${cacheStats.search} (24h lifetime)`,
        videoAndChannelStatsCached: `${cacheStats.stats} (6h lifetime)`,
        storageFile: 'praniq-cache.json'
      }
    };
  },

  async clearRest() {
    await chrome.storage.local.remove(['rest_yt', 'rest_ai']);
    return { ok: true };
  },

  async testKey({ key }) {
    const d = await yt('videos', { part: 'id', id: 'dQw4w9WgXcQ' }, key);
    return { ok: !!(d.items && d.items.length) };
  },

  async videoStats({ ids }) {
    const vids = await videos(ids);
    const chs = await channels(vids.map((v) => v.snippet.channelId));
    const map = Object.fromEntries(chs.map((c) => [c.id, c]));
    return vids.map((v) => {
      const r = videoRow(v, map[v.snippet.channelId]);
      delete r.tags;
      return r;
    });
  },

  async watchData({ videoId }) {
    const v = (await videos([videoId]))[0];
    if (!v) throw new Error('Video not found');
    const ch = (await channels([v.snippet.channelId]))[0];
    let recent = [];
    try { recent = (await uploads(ch, 30)).filter((x) => x.id !== videoId); } catch (e) {}
    const medianViews = TL.median(recent.map((x) => +x.statistics.viewCount || 0));
    const row = videoRow(v, ch);
    return {
      video: v,
      row,
      channel: { id: ch.id, title: ch.snippet.title, subs: subsOf(ch), views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0, created: ch.snippet.publishedAt },
      medianViews,
      outlier: medianViews ? row.views / medianViews : null,
      seo: TL.seo(v)
    };
  },

  async pageSignals({ videoId }) {
    const p = await pageData(videoId);
    if (!p) throw new Error('Could not read the video page');
    const ads = !!(p.adPlacements && p.adPlacements.length) || !!(p.playerAds && p.playerAds.length);
    const tracks = ((p.captions && p.captions.playerCaptionsTracklistRenderer && p.captions.playerCaptionsTracklistRenderer.captionTracks) || []).map((t) => ({
      lang: t.languageCode,
      name: (t.name && (t.name.simpleText || (t.name.runs || []).map((r) => r.text).join(''))) || t.languageCode,
      auto: t.kind === 'asr'
    }));
    const kw = (p.videoDetails && p.videoDetails.keywords) || [];
    return { ads, tracks, keywords: kw, family: p.microformat && p.microformat.playerMicroformatRenderer && p.microformat.playerMicroformatRenderer.isFamilySafe };
  },

  async transcript({ videoId }) {
    const p = await pageData(videoId);
    const tracks = (p && p.captions && p.captions.playerCaptionsTracklistRenderer && p.captions.playerCaptionsTracklistRenderer.captionTracks) || [];
    if (!tracks.length) throw new Error('This video has no captions.');
    const t = tracks.find((x) => x.languageCode && x.languageCode.startsWith('en') && x.kind !== 'asr') ||
      tracks.find((x) => x.languageCode && x.languageCode.startsWith('en')) || tracks[0];
    const r = await fetch(t.baseUrl + '&fmt=json3', { credentials: 'omit' });
    const txt = await r.text();
    if (!txt) throw new Error('YouTube blocked direct transcript access for this video. Use "Show transcript" under the video instead.');
    const j = JSON.parse(txt);
    const lines = [];
    for (const e of j.events || []) {
      if (!e.segs) continue;
      const text = e.segs.map((s) => s.utf8).join('').replace(/\n/g, ' ').trim();
      if (text) lines.push({ t: Math.floor((e.tStartMs || 0) / 1000), text });
    }
    return { lang: t.languageCode, lines };
  },

  async keyword({ q }) {
    q = String(q || '').trim();
    if (!q) throw new Error('Enter a keyword');
    let suggestions = [];
    try {
      const sr = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=' + encodeURIComponent(q));
      const j = JSON.parse(await sr.text());
      suggestions = (j[1] || []).filter((s) => s.toLowerCase() !== q.toLowerCase());
    } catch (e) {}
    const s = await yt('search', { part: 'snippet', type: 'video', q, maxResults: 20, order: 'relevance' });
    const vids = await videos((s.items || []).map((i) => i.id.videoId));
    const chs = await channels(vids.map((v) => v.snippet.channelId));
    const map = Object.fromEntries(chs.map((c) => [c.id, c]));
    const rows = vids.map((v) => videoRow(v, map[v.snippet.channelId]));
    const medianViews = TL.median(rows.map((r) => r.views));
    const medianSubs = TL.median(rows.map((r) => r.subs));
    const demand = Math.min(1, Math.log10(medianViews + 1) / 6.5);
    const competition = Math.min(1, Math.log10(medianSubs + 1) / 7);
    const smallWins = rows.filter((r) => r.subs !== null && r.subs < 50000 && r.views > r.subs).length;
    const recent = rows.filter((r) => TL.hoursSince(r.published) < 24 * 180).length;
    const opp = rows.length ? smallWins / rows.length : 0;
    const score = Math.round(100 * (0.45 * demand + 0.35 * (1 - competition) + 0.2 * opp));
    const tagCount = {};
    rows.forEach((r) => new Set(r.tags.map((t) => t.toLowerCase())).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)));
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([t, n]) => ({ t, n }));
    const titleLens = rows.map((r) => r.title.length);
    rows.forEach((r) => delete r.tags);
    return { q, suggestions, rows, medianViews, medianSubs, demand, competition, smallWins, recent, score, topTags, avgTitleLen: Math.round(TL.median(titleLens)) };
  },

  async outliers({ q, days = 30, maxSubs = 0, duration = 'any', minRatio = 0 }) {
    q = String(q || '').trim();
    if (!q) throw new Error('Enter a niche or keyword');
    const params = {
      part: 'snippet', type: 'video', q, order: 'viewCount', maxResults: 50,
      publishedAfter: new Date(Date.now() - days * 864e5).toISOString()
    };
    if (duration !== 'any') params.videoDuration = duration;
    const s = await yt('search', params);
    const vids = await videos((s.items || []).map((i) => i.id.videoId));
    const chs = await channels(vids.map((v) => v.snippet.channelId));
    const map = Object.fromEntries(chs.map((c) => [c.id, c]));
    let rows = vids.map((v) => videoRow(v, map[v.snippet.channelId]));
    rows.forEach((r) => delete r.tags);
    if (maxSubs > 0) rows = rows.filter((r) => r.subs !== null && r.subs <= maxSubs);
    if (minRatio > 0) rows = rows.filter((r) => r.ratio !== null && r.ratio >= minRatio);
    rows.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
    return { q, rows: rows.slice(0, 40) };
  },

  async analyzeChannel({ input }) {
    const ch = await resolveChannel(input);
    const vids = await uploads(ch, 50);
    const rows = vids.map((v) => videoRow(v, ch));
    rows.forEach((r) => delete r.tags);
    const med = TL.median(rows.map((r) => r.views));
    rows.forEach((r) => (r.outlier = med ? r.views / med : 0));
    const times = rows.map((r) => new Date(r.published).getTime()).sort((a, b) => a - b);
    const spanDays = times.length > 1 ? (times[times.length - 1] - times[0]) / 864e5 : 0;
    const perWeek = times.length > 1 && spanDays > 0 ? (times.length - 1) / (Math.max(spanDays, 7) / 7) : 0;
    const ageDays = Math.max(1, (Date.now() - new Date(ch.snippet.publishedAt).getTime()) / 864e5);
    const totalViews = +ch.statistics.viewCount || 0;
    const catCount = {};
    rows.forEach((r) => (catCount[r.cat] = (catCount[r.cat] || 0) + 1));
    const cat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
    const shortShare = rows.length ? rows.filter((r) => r.isShort).length / rows.length : 0;
    const last30 = rows.filter((r) => TL.hoursSince(r.published) <= 24 * 30);
    const views30 = last30.reduce((a, r) => a + r.views, 0);
    const monthlyViews = Math.max(views30, (totalViews / ageDays) * 30);
    const [lo, hi] = TL.rpm(cat && cat[0], false);
    const blendLo = lo * (1 - shortShare) + 0.03 * shortShare;
    const blendHi = hi * (1 - shortShare) + 0.1 * shortShare;
    const subs = subsOf(ch);
    return {
      channel: {
        id: ch.id, title: ch.snippet.title, handle: ch.snippet.customUrl, thumb: (ch.snippet.thumbnails.default || {}).url,
        subs, views: totalViews, videos: +ch.statistics.videoCount || 0, created: ch.snippet.publishedAt, country: ch.snippet.country
      },
      medianViews: med,
      perWeek,
      category: cat ? TL.CATS[cat[0]] || cat[0] : '—',
      shortShare,
      monthlyViews,
      monthlyRev: [(monthlyViews / 1000) * blendLo, (monthlyViews / 1000) * blendHi],
      ypm: subs ? subs / (ageDays / 30) : null,
      eligible: subs !== null && subs >= 1000,
      viewsPerSub: subs ? med / subs : null,
      rows: rows.sort((a, b) => b.outlier - a.outlier)
    };
  },

  async similar({ input }) {
    const ch = await resolveChannel(input);
    const vids = await uploads(ch, 20);
    const stop = new Set('this that with from your what when have will they them their about just like into more most best over make made video videos shorts short part full new official episode the and for you how why are was were been being can get got our out not all any one two vs'.split(' '));
    const own = ch.snippet.title.toLowerCase();
    const words = {};
    vids.forEach((v) => {
      const text = (v.snippet.title + ' ' + (v.snippet.tags || []).join(' ')).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ');
      text.split(/\s+/).forEach((w) => {
        if (w.length > 3 && !stop.has(w) && !own.includes(w) && !/^\d+$/.test(w)) words[w] = (words[w] || 0) + 1;
      });
    });
    const top = Object.entries(words).sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]);
    const q = top.join(' ') || ch.snippet.title;
    const s = await yt('search', { part: 'snippet', type: 'video', q, maxResults: 50, order: 'relevance' });
    const ids = [...new Set((s.items || []).map((i) => i.snippet.channelId))].filter((id) => id !== ch.id).slice(0, 25);
    const chs = await channels(ids);
    const results = chs.map((c) => ({
      id: c.id, title: c.snippet.title, thumb: (c.snippet.thumbnails.default || {}).url,
      subs: subsOf(c), views: +c.statistics.viewCount || 0, videos: +c.statistics.videoCount || 0, created: c.snippet.publishedAt
    })).sort((a, b) => (b.subs || 0) - (a.subs || 0));
    return { channel: ch.snippet.title, query: q, results };
  },

  async trackList() {
    const { tracked = [] } = await chrome.storage.local.get('tracked');
    return tracked;
  },

  async trackAdd({ input }) {
    const ch = await resolveChannel(input);
    const { tracked = [] } = await chrome.storage.local.get('tracked');
    if (!tracked.find((t) => t.id === ch.id)) {
      tracked.push({
        id: ch.id, title: ch.snippet.title, thumb: (ch.snippet.thumbnails.default || {}).url,
        history: [{ t: Date.now(), subs: subsOf(ch), views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0 }]
      });
      await chrome.storage.local.set({ tracked });
    }
    return tracked;
  },

  async trackRemove({ id }) {
    let { tracked = [] } = await chrome.storage.local.get('tracked');
    tracked = tracked.filter((t) => t.id !== id);
    await chrome.storage.local.set({ tracked });
    return tracked;
  },

  async trackRefresh() {
    const { tracked = [] } = await chrome.storage.local.get('tracked');
    if (!tracked.length) return tracked;
    const fresh = {};
    for (let i = 0; i < tracked.length; i += 50) {
      const d = await yt('channels', { part: 'snippet,statistics', id: tracked.slice(i, i + 50).map((t) => t.id).join(','), maxResults: 50, _nocache: true });
      (d.items || []).forEach((c) => (fresh[c.id] = c));
    }
    tracked.forEach((t) => {
      const c = fresh[t.id];
      if (!c) return;
      t.title = c.snippet.title;
      t.history.push({ t: Date.now(), subs: subsOf(c), views: +c.statistics.viewCount || 0, videos: +c.statistics.videoCount || 0 });
      if (t.history.length > 120) t.history = t.history.slice(-120);
    });
    await chrome.storage.local.set({ tracked });
    return tracked;
  }
};


/* ======================= v2 ======================= */
async function channelById(id) {
  const d = await yt('channels', { part: 'snippet,statistics,contentDetails,brandingSettings', id });
  return d.items && d.items[0];
}

async function uploadsMany(ch, max = 200) {
  const pl = ch.contentDetails && ch.contentDetails.relatedPlaylists && ch.contentDetails.relatedPlaylists.uploads;
  if (!pl) return [];
  let ids = [], token;
  do {
    const d = await yt('playlistItems', { part: 'contentDetails', playlistId: pl, maxResults: 50, pageToken: token });
    ids.push(...(d.items || []).map((i) => i.contentDetails.videoId));
    token = d.nextPageToken;
  } while (token && ids.length < max);
  return videos(ids.slice(0, max));
}

async function pushSnap(key, data, minGapMs) {
  const o = await chrome.storage.local.get(key);
  let arr = o[key] || [];
  const last = arr[arr.length - 1];
  if (!last || Date.now() - last.t > minGapMs) {
    arr.push({ t: Date.now(), ...data });
    if (arr.length > 300) arr = arr.slice(-300);
    await chrome.storage.local.set({ [key]: arr });
  }
  return arr;
}

async function gemini(prompt, sys, opt = {}) {
  const { geminiModel } = await chrome.storage.sync.get('geminiModel');
  const pool = await keyPool('geminiKey', 'ai');
  const models = [...new Set([geminiModel, 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemma-4-31b-it'].filter(Boolean))];
  let lastErr = new Error(pool.all.length > 1 ? `All ${pool.all.length} Gemini keys hit their limit. Try again later.` : 'AI daily free limit reached. Try again later, or add more keys in settings.');
  for (const key of pool.live) {
    let limited = 0, bad = false;
    for (const m of models) {
      const isGemma = m.startsWith('gemma');
      const parts = [...(opt.images || []).map((im) => ({ inlineData: { mimeType: im.mime, data: im.data } })), { text: (sys && isGemma ? sys + '\n\n' : '') + prompt }];
      const body = { contents: [{ role: 'user', parts }] };
      if (sys && !isGemma) body.systemInstruction = { parts: [{ text: sys }] };
      if (opt.json && !isGemma) body.generationConfig = { responseMimeType: 'application/json' };
      if (opt.maxTokens) body.generationConfig = { ...(body.generationConfig || {}), maxOutputTokens: opt.maxTokens };
      let d;
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key }, body: JSON.stringify(body)
        });
        d = await r.json();
      } catch (e) { lastErr = e; continue; }
      if (d.error) {
        if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test((d.error.message || '') + (d.error.status || ''))) { bad = true; break; }
        if (d.error.code === 429) { limited++; continue; }
        lastErr = new Error(d.error.message);
        continue;
      }
      const text = (((d.candidates || [])[0] || {}).content || {}).parts ? d.candidates[0].content.parts.map((p) => p.text || '').join('') : '';
      if (text) { ok('ai', key); return { text, model: m }; }
    }
    if (bad) { await rest('ai', key, Date.now() + 864e5); if (pool.all.length === 1) throw new Error('Your Gemini key was rejected. Check it in PranIQ settings.'); continue; }
    // every model limited on this key: rest it (daily limits reset midnight PT; per-minute ones much sooner)
    if (limited === models.length) await rest('ai', key, Math.min(nextResetPT(), Date.now() + 60 * 60e3));
  }
  throw lastErr;
}

const AI_SYS = 'You are PranIQ AI Coach, a sharp YouTube growth strategist. Be specific, practical and concise. Use short paragraphs and bullet points. Never invent analytics you were not given.';

async function transcriptText(videoId, maxChars = 12000) {
  try {
    const t = await handlers.transcript({ videoId });
    return t.lines.map((l) => l.text).join(' ').slice(0, maxChars);
  } catch (e) { return ''; }
}

function scoreRows(rows) {
  const medianViews = TL.median(rows.map((r) => r.views));
  const medianSubs = TL.median(rows.map((r) => r.subs));
  const demand = Math.min(1, Math.log10(medianViews + 1) / 6.5);
  const competition = Math.min(1, Math.log10(medianSubs + 1) / 7);
  const smallWins = rows.filter((r) => r.subs !== null && r.subs < 50000 && r.views > r.subs).length;
  const recent = rows.filter((r) => TL.hoursSince(r.published) < 24 * 180).length;
  const opp = rows.length ? smallWins / rows.length : 0;
  const score = Math.round(100 * (0.45 * demand + 0.35 * (1 - competition) + 0.2 * opp));
  return { medianViews, medianSubs, demand, competition, smallWins, recent, score };
}

async function suggest(q) {
  try {
    const sr = await fetch('https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=' + encodeURIComponent(q));
    const j = JSON.parse(await sr.text());
    return (j[1] || []).filter((s) => s.toLowerCase() !== q.toLowerCase());
  } catch (e) { return []; }
}

Object.assign(handlers, {
  async openOptions() { chrome.runtime.openOptionsPage(); return true; },

  async resolve({ input }) {
    const c = await resolveChannel(input);
    return { id: c.id };
  },

  async channelFull({ input, id, max = 200 }) {
    let ch = id ? await channelById(id) : await resolveChannel(input);
    if (!ch) throw new Error('Channel not found');
    if (!ch.brandingSettings) ch = await channelById(ch.id);
    const vids = await uploadsMany(ch, max);
    const rows = vids.map((v) => {
      const dur = TL.isoDur(v.contentDetails && v.contentDetails.duration);
      return {
        id: v.id, title: v.snippet.title, thumb: (v.snippet.thumbnails.medium || v.snippet.thumbnails.default || {}).url,
        t: new Date(v.snippet.publishedAt).getTime(), views: +v.statistics.viewCount || 0, likes: +v.statistics.likeCount || 0,
        comments: +v.statistics.commentCount || 0, dur, isShort: dur > 0 && dur <= 60, cat: v.snippet.categoryId, tags: v.snippet.tags || []
      };
    });
    const subs = subsOf(ch), totalViews = +ch.statistics.viewCount || 0, videoCount = +ch.statistics.videoCount || 0;
    const created = new Date(ch.snippet.publishedAt).getTime();
    const sumViews = rows.reduce((a, r) => a + r.views, 0);
    const est = rows.map((r) => ({ t: r.t, views: r.views }));
    const missing = totalViews - sumViews;
    if (missing > 0 && rows.length) {
      const oldest = Math.min(...rows.map((r) => r.t));
      est.push({ t: (oldest + created) / 2, views: missing, pseudo: true });
    }
    const now = Date.now();
    const g7 = TL.estGained(est, now - 7 * 864e5, now, now);
    const g30 = TL.estGained(est, now - 30 * 864e5, now, now);
    const catCount = {};
    rows.forEach((r) => (catCount[r.cat] = (catCount[r.cat] || 0) + 1));
    const cat = Object.entries(catCount).sort((a, b) => b[1] - a[1])[0];
    const shortShare = rows.length ? rows.filter((r) => r.isShort).length / rows.length : 0;
    const [lo, hi] = TL.rpm(cat && cat[0], false);
    const rpm = [lo * (1 - shortShare) + 0.03 * shortShare, hi * (1 - shortShare) + 0.1 * shortShare];
    const longs = rows.filter((r) => !r.isShort);
    const avgLen = TL.median((longs.length ? longs : rows).map((r) => r.dur));
    const last28 = rows.filter((r) => now - r.t <= 28 * 864e5).length;
    const last90 = rows.filter((r) => now - r.t <= 90 * 864e5).length;
    const perWeek = last28 ? last28 / 4 : last90 / 13;
    let keywords = TL.parseKeywords(ch.brandingSettings && ch.brandingSettings.channel && ch.brandingSettings.channel.keywords);
    const tagCount = {};
    rows.forEach((r) => new Set(r.tags.map((t) => t.toLowerCase())).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)));
    const videoTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 30).map((x) => x[0]);
    const med = TL.median(rows.map((r) => r.views));
    const snaps = await pushSnap('snap_' + ch.id, { subs, views: totalViews, videos: videoCount }, 3 * 3600e3);
    const { tracked = [] } = await chrome.storage.local.get('tracked');
    const tr = tracked.find((t) => t.id === ch.id);
    const history = [...snaps, ...(tr ? tr.history : [])].sort((a, b) => a.t - b.t);
    rows.forEach((r) => { delete r.tags; r.outlier = med ? r.views / med : 0; });
    return {
      channel: {
        id: ch.id, title: ch.snippet.title, handle: ch.snippet.customUrl, thumb: (ch.snippet.thumbnails.medium || ch.snippet.thumbnails.default || {}).url,
        subs, views: totalViews, videos: videoCount, created, country: ch.snippet.country || (ch.brandingSettings.channel || {}).country || '',
        desc: ch.snippet.description || ''
      },
      rows, est, g7, g30, earn30: [(g30 / 1000) * rpm[0], (g30 / 1000) * rpm[1]], rpm,
      subsPerView: subs && totalViews ? subs / totalViews : 0,
      avgLen, perWeek, category: cat ? TL.CATS[cat[0]] || cat[0] : '—', shortShare, keywords, videoTags, median: med,
      history, tracked: !!tr, covered: rows.length
    };
  },

  async similarCached({ id }) {
    const k = 'sim_' + id;
    const o = await chrome.storage.local.get(k);
    if (o[k] && Date.now() - o[k].t < 7 * 864e5) return o[k].d;
    const d = await handlers.similar({ input: id });
    await chrome.storage.local.set({ [k]: { t: Date.now(), d } });
    return d;
  },

  async watchFull({ videoId }) {
    const v = (await videos([videoId]))[0];
    if (!v) throw new Error('Video not found');
    const ch = await channelById(v.snippet.channelId);
    let recent = [];
    try { recent = (await uploads(ch, 50)).filter((x) => x.id !== videoId); } catch (e) {}
    const row = videoRow(v, ch);
    const A = TL.hoursSince(v.snippet.publishedAt);
    const all = recent.map((x) => {
      const d = TL.isoDur(x.contentDetails && x.contentDetails.duration);
      return { V: +x.statistics.viewCount || 0, A: TL.hoursSince(x.snippet.publishedAt), s: d > 0 && d <= 60 };
    });
    const same = all.filter((o) => o.s === row.isShort);
    const pool = same.length >= 5 ? same : all;
    const typicalAt = (t) => {
      const old = pool.filter((o) => o.A >= t);
      return TL.median((old.length >= 3 ? old : pool).map((o) => TL.viewsAt(o.V, o.A, t)));
    };
    const typicalNow = pool.length ? typicalAt(A) : 0;
    const key = 'vs_' + videoId;
    const o = await chrome.storage.local.get(key);
    const vs = o[key] || { snaps: [], titles: [] };
    const prev = [...vs.snaps].reverse().find((s) => Date.now() - s.t > 30 * 60e3);
    const recentVph = prev ? (row.views - prev.v) / ((Date.now() - prev.t) / 36e5) : null;
    const lastSnap = vs.snaps[vs.snaps.length - 1];
    if (!lastSnap || Date.now() - lastSnap.t > 20 * 60e3) vs.snaps.push({ t: Date.now(), v: row.views });
    const lastTitle = vs.titles[vs.titles.length - 1];
    if (!lastTitle || lastTitle.title !== v.snippet.title) vs.titles.push({ t: Date.now(), title: v.snippet.title });
    if (vs.snaps.length > 300) vs.snaps = vs.snaps.slice(-300);
    await chrome.storage.local.set({ [key]: vs });
    const chHist = await pushSnap('snap_' + ch.id, { subs: subsOf(ch), views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0 }, 3 * 3600e3);
    return {
      video: v, row, A, pool, typicalNow, outlier: typicalNow ? row.views / typicalNow : null, vs, recentVph,
      channel: {
        id: ch.id, title: ch.snippet.title, handle: ch.snippet.customUrl, thumb: (ch.snippet.thumbnails.medium || ch.snippet.thumbnails.default || {}).url,
        subs: subsOf(ch), views: +ch.statistics.viewCount || 0, videos: +ch.statistics.videoCount || 0, created: ch.snippet.publishedAt,
        keywords: TL.parseKeywords(ch.brandingSettings && ch.brandingSettings.channel && ch.brandingSettings.channel.keywords), history: chHist
      },
      medianViews: TL.median(all.map((x) => x.V)),
      seo: TL.seo(v)
    };
  },

  async searchScore({ q, ids }) {
    const [suggestions, rowsRaw] = await Promise.all([suggest(q), handlers.videoStats({ ids: ids.slice(0, 20) })]);
    const vids = await videos(ids.slice(0, 20));
    const tagCount = {};
    vids.forEach((v) => new Set((v.snippet.tags || []).map((t) => t.toLowerCase())).forEach((t) => (tagCount[t] = (tagCount[t] || 0) + 1)));
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([t, n]) => ({ t, n }));
    return { q, suggestions, topTags, count: rowsRaw.length, ...scoreRows(rowsRaw) };
  },

  async compare({ inputs }) {
    const out = [];
    for (const input of inputs) {
      const d = await handlers.channelFull({ input, max: 50 });
      out.push({ id: d.channel.id, title: d.channel.title, thumb: d.channel.thumb, subs: d.channel.subs, views: d.channel.views, videos: d.channel.videos, g30: d.g30, earn30: d.earn30, perWeek: d.perWeek, median: d.median, avgLen: d.avgLen, created: d.channel.created });
    }
    return out;
  },

  async testAi({ key }) {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=5', { headers: { 'x-goog-api-key': key } });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return { ok: true };
  },

  async aiRemix({ videoId, count = 8 }) {
    const v = (await videos([videoId]))[0];
    const prompt = `Video title: "${v.snippet.title}"
Channel: ${v.snippet.channelTitle}
Views: ${v.statistics.viewCount}, published ${TL.ago(v.snippet.publishedAt)}
Tags: ${(v.snippet.tags || []).slice(0, 20).join(', ')}
Description: ${(v.snippet.description || '').slice(0, 800)}

Write ${count} new, more clickable YouTube titles for a video on this same topic (a "remix"). Mix curiosity, numbers, stakes and benefit angles. Max 70 characters each. Rate each 0-100 for click potential.
Return ONLY JSON: [{"title":"...","score":88,"angle":"curiosity"}]`;
    const r = await gemini(prompt, AI_SYS);
    let ideas = [];
    try { ideas = TL.parseJson(r.text); } catch (e) { ideas = r.text.split('\n').filter((l) => l.trim()).map((l) => ({ title: l.replace(/^\W+/, ''), score: null })); }
    return { ideas: ideas.sort((a, b) => (b.score || 0) - (a.score || 0)), model: r.model };
  },

  async aiCoach({ videoId, question }) {
    const d = await handlers.watchFull({ videoId });
    const v = d.video, r = d.row;
    const transcript = await transcriptText(videoId);
    const ctx = `VIDEO
Title: ${v.snippet.title}
Published: ${TL.ago(v.snippet.publishedAt)} | Length: ${r.isShort ? 'Short' : TL.durText(r.dur)} | Category: ${TL.CATS[r.cat] || r.cat}
Views: ${r.views} | Likes: ${r.likes} | Comments: ${r.comments} | Views/hour (lifetime): ${Math.round(r.vph)}
Outlier vs this channel's typical video at the same age: ${d.outlier ? d.outlier.toFixed(2) + 'x' : 'unknown'}
Tags: ${(v.snippet.tags || []).join(', ')}
Description: ${(v.snippet.description || '').slice(0, 1500)}
SEO score: ${d.seo.score}/100 (failed: ${d.seo.checks.filter((c) => !c.ok).map((c) => c.label).join('; ')})

CHANNEL
${d.channel.title} | Subs: ${d.channel.subs ?? 'hidden'} | Videos: ${d.channel.videos} | Median views of recent uploads: ${Math.round(d.medianViews)}

TRANSCRIPT (may be partial)
${transcript || '(not available)'}`;
    const res = await gemini(`${ctx}\n\nQUESTION: ${question}`, AI_SYS);
    return { text: res.text, model: res.model, hadTranscript: !!transcript };
  },

  async aiChannel({ id }) {
    const d = await handlers.channelFull({ id, max: 50 });
    const top = [...d.rows].sort((a, b) => b.outlier - a.outlier);
    const ctx = `CHANNEL: ${d.channel.title}
Subs: ${d.channel.subs ?? 'hidden'} | Total views: ${d.channel.views} | Videos: ${d.channel.videos} | Created: ${new Date(d.channel.created).toDateString()}
Uploads/week: ${d.perWeek.toFixed(1)} | Shorts share: ${Math.round(d.shortShare * 100)}% | Category: ${d.category} | Median views: ${Math.round(d.median)}
Description: ${d.channel.desc.slice(0, 600)}
Best performers: ${top.slice(0, 8).map((r) => `"${r.title}" (${r.views} views, ${r.outlier.toFixed(1)}x)`).join('; ')}
Worst performers: ${top.slice(-5).map((r) => `"${r.title}" (${r.views} views)`).join('; ')}`;
    const res = await gemini(`${ctx}\n\nGive a channel audit: 1) what is working (patterns in the best videos), 2) what is not, 3) five specific next video ideas with titles, 4) three quick wins.`, AI_SYS);
    return { text: res.text, model: res.model };
  },

  async aiTool({ kind, topic, extra }) {
    const prompts = {
      ideas: `Give 10 fresh, high-potential YouTube video ideas for the niche/topic "${topic}". For each: a clickable title (max 70 chars), a one-line hook, and why it can work. ${extra || ''}`,
      titles: `Write 12 click-worthy YouTube titles (max 70 chars) for a video about "${topic}". Vary the angles (curiosity, numbers, challenge, mistake, transformation). Give each a 0-100 click score. ${extra || ''}`,
      description: `Write an SEO-optimised YouTube description for a video about "${topic}". Start with a 2-line hook that includes the main keyword, then a short summary, a chapters placeholder starting at 0:00, a call to action and 3 hashtags. ${extra || ''}`,
      tags: `Give 25 YouTube tags for a video about "${topic}", from specific long-tail to broad, comma-separated on one line, staying under 500 characters total. ${extra || ''}`,
      script: `Write a YouTube video outline for "${topic}": a 15-second hook (word for word), intro, 5-7 sections with key points, retention tricks between sections, and an end-screen call to action. ${extra || ''}`,
      shorts: `Write 5 YouTube Shorts scripts (under 45 seconds each) about "${topic}". Each: a 2-second scroll-stopping first line, the body, and a loop ending. ${extra || ''}`
    };
    const res = await gemini(prompts[kind] || prompts.ideas, AI_SYS);
    return { text: res.text, model: res.model };
  }
});

// Tracker refresh also feeds channel snapshots
const _trackRefresh = handlers.trackRefresh;
handlers.trackRefresh = async () => {
  const list = await _trackRefresh();
  for (const t of list) {
    const h = t.history[t.history.length - 1];
    if (h) await pushSnap('snap_' + t.id, { subs: h.subs, views: h.views, videos: h.videos }, 3 * 3600e3);
  }
  return list;
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = handlers[msg && msg.type];
  if (!h) { sendResponse({ ok: false, error: 'Unknown request' }); return false; }
  h(msg.payload || {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message === 'NO_KEY' ? 'Add your free YouTube API key in PranIQ settings (right-click the icon → Options).' : e.message === 'NO_AI' ? 'Add your free Gemini key in PranIQ settings to use AI features.' : e.message }));
  return true;
});

chrome.runtime.onInstalled.addListener((details) => {
  chrome.alarms.create('tracker', { periodInMinutes: 720 });
  if (details.reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'tracker') handlers.trackRefresh().catch(() => {});
});

importScripts('bg-auto.js');
